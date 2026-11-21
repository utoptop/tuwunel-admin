use crate::{
    app::{AppState, Payload, Session, auth},
    catalog::encode,
    error::{AppError, Result},
    store::{self, now, random_hex},
    workspace::validate_id,
};
use axum::{Json, extract::State, http::HeaderMap};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;

fn default_true() -> bool {
    true
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Start {
    users: Vec<String>,
    confirmation: String,
    #[serde(default = "default_true", alias = "keepAvatar")]
    keep_avatar: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cancel {
    id: String,
}
pub async fn list(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<Value>> {
    let (_, s) = auth(&state, &headers, false).await?;
    let jobs = store::access(&state.store, false, move |store| {
        let mut jobs = store
            .data
            .media_jobs
            .values()
            .filter(|v| v["homeserver"] == s.matrix.origin)
            .cloned()
            .collect::<Vec<_>>();
        jobs.sort_by_key(|v| std::cmp::Reverse(v["created"].as_u64().unwrap_or(0)));
        Ok(jobs)
    })
    .await?;
    Ok(Json(json!({"jobs":jobs})))
}
pub async fn cancel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Payload(input): Payload<Cancel>,
) -> Result<Json<Value>> {
    let (_, s) = auth(&state, &headers, true).await?;
    store::access(&state.store, true, move |store| {
        let job = store
            .data
            .media_jobs
            .get_mut(&input.id)
            .filter(|j| j["homeserver"] == s.matrix.origin)
            .ok_or_else(|| AppError::new(404, "任务不存在"))?;
        if job["status"] == "running" {
            job["cancelRequested"] = json!(true);
        }
        Ok(())
    })
    .await?;
    Ok(Json(json!({"ok":true})))
}
pub async fn start(
    State(state): State<AppState>,
    headers: HeaderMap,
    Payload(input): Payload<Start>,
) -> Result<Json<Value>> {
    let (_, s) = auth(&state, &headers, true).await?;
    let mut seen = HashSet::new();
    let ids = input
        .users
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect::<Vec<_>>();
    if ids.is_empty() || ids.len() > 1000 {
        return Err(AppError::new(
            400,
            "请选择 1–1000 位用户；文件数量不设 100 个上限",
        ));
    }
    if input.confirmation != format!("删除 {} 位用户的全部媒体", ids.len()) {
        return Err(AppError::new(400, "请输入完整确认文字"));
    }
    for id in &ids {
        validate_id(id)?;
        if id.split_once(':').map(|v| v.1) != s.user_id.split_once(':').map(|v| v.1) {
            return Err(AppError::new(400, "只能清理当前服务器本地用户的媒体"));
        }
    }
    let key = random_hex(16);
    let job_id = key.clone();
    let origin = s.matrix.origin.clone();
    let actor = s.user_id.clone();
    let targets = ids.clone();
    let keep_avatar = input.keep_avatar;
    store::access(&state.store,true,move|store|{
  if store.data.media_jobs.values().any(|v|v["homeserver"]==origin && v["status"]=="running") || store.data.cleanup_jobs.values().any(|v|v["homeserver"]==origin && v["status"]=="running") {return Err(AppError::new(409,"当前服务器已有媒体或桥接清理运行，请等待完成"));}
  if store.data.media_jobs.len()>=20 {
   let old=store.data.media_jobs.iter().filter(|(_,j)|j["status"]!="running").min_by_key(|(_,j)|j["created"].as_u64().unwrap_or(0)).map(|(k,_)|k.clone());
   if let Some(old)=old {store.data.media_jobs.remove(&old);}else{return Err(AppError::new(429,"运行中的任务过多"));}
  }
  store.audit(&origin,&actor,"开始全量用户媒体清理",&format!("{} 位用户{}",targets.len(), if keep_avatar { "（保留头像）" } else { "（含头像）" }),"success");
  let rows=targets.iter().map(|id|json!({"userId":id,"status":"pending","deleted":0,"preserved":0})).collect::<Vec<_>>();
  store.data.media_jobs.insert(job_id.clone(),json!({"id":job_id,"homeserver":origin,"actor":actor,"created":now(),"status":"running","cancelRequested":false,"keepAvatar":keep_avatar,"users":rows,"concurrency":3}));Ok(())
 }).await?;
    let job = key.clone();
    tokio::spawn(async move {
        run(state, headers, s, job, ids, keep_avatar).await;
    });
    Ok(Json(json!({"id":key})))
}
async fn update(state: &AppState, job: &str, id: &str, patch: Value) -> Result<()> {
    let key = job.to_owned();
    let id = id.to_owned();
    store::access(&state.store, true, move |store| {
        let j = store
            .data
            .media_jobs
            .get_mut(&key)
            .ok_or_else(|| AppError::new(500, "任务记录不存在"))?;
        let row = j["users"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|v| v["userId"] == id)
            .unwrap();
        for (k, v) in patch.as_object().unwrap() {
            row[k] = v.clone();
        }
        Ok(())
    })
    .await
}
async fn active(state: &AppState, key: &str, headers: &HeaderMap) -> Result<Session> {
    let job = key.to_owned();
    let canceled = store::access(&state.store, false, move |store| {
        Ok(store
            .data
            .media_jobs
            .get(&job)
            .is_none_or(|j| j["cancelRequested"] == true))
    })
    .await?;
    if canceled {
        return Err(AppError::new(409, "任务已取消；已删除的文件不会恢复"));
    }
    Ok(auth(state, headers, true).await?.1)
}
fn parse_local_mxc(mxc: &str, expected_server: &str) -> Option<String> {
    let rest = mxc.strip_prefix("mxc://")?;
    let (server, media_id) = rest.split_once('/')?;
    if server == expected_server
        && !media_id.is_empty()
        && !media_id.contains(['/', '?', '#', '\\', '%'])
        && media_id != "."
        && media_id != ".."
    {
        Some(media_id.to_owned())
    } else {
        None
    }
}
async fn clean(
    state: &AppState,
    headers: &HeaderMap,
    key: &str,
    id: &str,
    keep_avatar: bool,
) -> Result<()> {
    let s = active(state, key, headers).await?;
    s.matrix.verify(&s.token).await?;
    let server_name = id
        .split_once(':')
        .map(|(_, d)| d)
        .ok_or_else(|| AppError::new(400, "无效的 Matrix 用户 ID"))?;
    let path = format!("/_synapse/admin/v1/users/{}/media", encode(id));
    let mut protected_ids = HashSet::new();
    if keep_avatar {
        let profile = s
            .matrix
            .request(
                &s.token,
                Method::GET,
                &format!("/_synapse/admin/v2/users/{}", encode(id)),
                None,
            )
            .await
            .map_err(|_| {
                AppError::new(
                    502,
                    "无法读取用户资料以识别当前头像，已停止清理以避免误删头像",
                )
            })?;
        if let Some(mxc) = profile["avatar_url"].as_str()
            && let Some(mid) = parse_local_mxc(mxc, server_name)
        {
            protected_ids.insert(mid);
        }
    }
    let mut deleted = 0u64;
    let mut previous = String::new();
    update(state, key, id, json!({"status":"running"})).await?;
    if !protected_ids.is_empty() {
        let mut from = 0usize;
        let mut preserved_ids = HashSet::new();
        loop {
            let s = active(state, key, headers).await?;
            let current = s
                .matrix
                .request(
                    &s.token,
                    Method::GET,
                    &format!("{path}?from={from}&limit=100"),
                    None,
                )
                .await?;
            let media = current["media"]
                .as_array()
                .ok_or_else(|| AppError::new(502, "媒体列表格式无效"))?;
            let total = current["total"].as_u64().unwrap_or(0);
            if media.is_empty() && total > 0 && from == 0 {
                return Err(AppError::new(502, "媒体列表和剩余总数不一致"));
            }
            let mut deletable = Vec::new();
            for item in media {
                let mid = item["media_id"]
                    .as_str()
                    .ok_or_else(|| AppError::new(502, "媒体缺少 ID"))?;
                if protected_ids.contains(mid) {
                    preserved_ids.insert(mid.to_owned());
                } else {
                    deletable.push(mid.to_owned());
                }
            }
            if deletable.is_empty() {
                let next = current["next_token"]
                    .as_str()
                    .and_then(|v| v.parse::<usize>().ok())
                    .or_else(|| current["next_token"].as_u64().map(|n| n as usize));
                if let Some(next_from) = next
                    && next_from > from
                    && !media.is_empty()
                {
                    from = next_from;
                    continue;
                }
                update(
                    state,
                    key,
                    id,
                    json!({
                        "status": "complete",
                        "deleted": deleted,
                        "preserved": preserved_ids.len(),
                        "remaining": 0,
                        "verified": true
                    }),
                )
                .await?;
                return Ok(());
            }
            if deletable[0] == previous {
                return Err(AppError::new(
                    502,
                    "媒体删除没有前进，请检查上游文件存储权限后重试",
                ));
            }
            previous = deletable[0].clone();
            from = 0;
            let mut batch_deleted = 0usize;
            let mut batch_gone = 0usize;
            let mut first_error: Option<AppError> = None;
            for chunk in deletable.chunks(6) {
                let s = active(state, key, headers).await?;
                let mut tasks = tokio::task::JoinSet::new();
                for mid in chunk {
                    let s = s.clone();
                    let req_path = format!(
                        "/_synapse/admin/v1/media/{}/{}",
                        encode(server_name),
                        encode(mid)
                    );
                    tasks.spawn(async move {
                        s.matrix
                            .request(&s.token, Method::DELETE, &req_path, Some(&json!({})))
                            .await
                    });
                }
                while let Some(res) = tasks.join_next().await {
                    match res.map_err(AppError::internal)? {
                        Ok(_) => batch_deleted += 1,
                        Err(e) if e.status.as_u16() == 404 => batch_gone += 1,
                        Err(e) => {
                            if first_error.is_none() {
                                first_error = Some(e);
                            }
                        }
                    }
                }
            }
            if batch_deleted + batch_gone == 0 {
                return Err(first_error
                    .unwrap_or_else(|| AppError::new(502, "仍有媒体但上游未删除任何文件")));
            }
            deleted += batch_deleted as u64;
            let remaining = total
                .saturating_sub(preserved_ids.len() as u64)
                .saturating_sub((batch_deleted + batch_gone) as u64);
            update(
                state,
                key,
                id,
                json!({
                    "deleted": deleted,
                    "preserved": preserved_ids.len(),
                    "remaining": remaining
                }),
            )
            .await?;
        }
    }
    loop {
        let s = active(state, key, headers).await?;
        let current = s
            .matrix
            .request(
                &s.token,
                Method::GET,
                &format!("{path}?from=0&limit=1"),
                None,
            )
            .await?;
        let media = current["media"]
            .as_array()
            .ok_or_else(|| AppError::new(502, "媒体列表格式无效"))?;
        if media.is_empty() {
            if current["total"].as_u64().unwrap_or(0) > 0 {
                return Err(AppError::new(502, "媒体列表和剩余总数不一致"));
            }
            update(
                state,
                key,
                id,
                json!({"status":"complete","deleted":deleted,"preserved":0,"remaining":0,"verified":true}),
            )
            .await?;
            return Ok(());
        }
        let first = media[0]["media_id"]
            .as_str()
            .ok_or_else(|| AppError::new(502, "媒体缺少 ID"))?;
        if first == previous {
            return Err(AppError::new(
                502,
                "媒体删除没有前进，请检查上游文件存储权限后重试",
            ));
        }
        previous = first.to_owned();
        let batch = s
            .matrix
            .request(
                &s.token,
                Method::DELETE,
                &format!("{path}?from=0&limit=100"),
                Some(&json!({})),
            )
            .await?;
        let count = batch["deleted_media"]
            .as_array()
            .map(|v| v.len())
            .unwrap_or(0);
        if count == 0 {
            return Err(AppError::new(502, "仍有媒体但上游未删除任何文件"));
        }
        deleted += count as u64;
        update(state,key,id,json!({"deleted":deleted,"preserved":0,"remaining":current["total"].as_u64().map(|v|v.saturating_sub(count as u64))})).await?;
    }
}
async fn run(
    state: AppState,
    headers: HeaderMap,
    s: Session,
    key: String,
    ids: Vec<String>,
    keep_avatar: bool,
) {
    let mut queue = ids.into_iter();
    let mut running = tokio::task::JoinSet::new();
    loop {
        while running.len() < 3 {
            let Some(id) = queue.next() else { break };
            let state = state.clone();
            let headers = headers.clone();
            let key = key.clone();
            let s = s.clone();
            running.spawn(async move {
                let result = clean(&state, &headers, &key, &id, keep_avatar).await;
                if let Err(e) = &result {
                    let _ = update(
                        &state,
                        &key,
                        &id,
                        json!({"status":"failed","error":e.message}),
                    )
                    .await;
                }
                let _ = crate::app::audit(
                    &state,
                    &s,
                    "清理用户全部媒体",
                    &id,
                    if result.is_ok() { "success" } else { "failed" },
                )
                .await;
            });
        }
        if running.join_next().await.is_none() {
            break;
        }
    }
    let _ = store::access(&state.store, true, move |store| {
        if let Some(j) = store.data.media_jobs.get_mut(&key) {
            let complete = j["users"]
                .as_array()
                .unwrap()
                .iter()
                .all(|u| u["status"] == "complete");
            j["status"] = json!(if complete {
                "complete"
            } else if j["cancelRequested"] == true {
                "canceled"
            } else {
                "partial"
            });
            j["finished"] = json!(now());
        }
        Ok(())
    })
    .await;
}
