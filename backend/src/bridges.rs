use crate::{
    app::{AppState, Payload, Session, audit, auth},
    catalog::encode,
    error::{AppError, Result},
    matrix::normalize,
    store::{self, now, random_hex},
    workspace::validate_id,
};
use axum::{Json, extract::State, http::HeaderMap};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};

#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct BridgeConfig {
    pub detect_common: bool,
    pub rules: Vec<BridgeRule>,
}
impl Default for BridgeConfig {
    fn default() -> Self {
        Self {
            detect_common: true,
            rules: vec![],
        }
    }
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BridgeRule {
    pub homeserver: String,
    pub name: String,
    pub user_prefix: String,
}
impl BridgeConfig {
    pub fn validate(&mut self) -> Result<()> {
        if self.rules.len() > 128 {
            return Err(AppError::new(500, "桥接规则最多 128 条"));
        }
        for rule in &mut self.rules {
            rule.homeserver = normalize(&rule.homeserver)?;
            if rule.name.is_empty()
                || rule.name.len() > 80
                || rule.user_prefix.len() < 3
                || rule.user_prefix.len() > 255
                || !rule.user_prefix.starts_with('@')
                || rule
                    .user_prefix
                    .chars()
                    .any(|c| c.is_whitespace() || matches!(c, ':' | '/' | '\\' | '%' | '*'))
            {
                return Err(AppError::new(
                    500,
                    "桥接规则需要名称、精确 homeserver 和至少 3 字符的 @用户名前缀（不含通配符或域名）",
                ));
            }
        }
        Ok(())
    }
}
#[derive(Clone)]
pub struct Directory {
    at: u64,
    rows: Vec<Value>,
}
pub struct Plan {
    session: String,
    origin: String,
    actor: String,
    at: u64,
    ids: Vec<String>,
}
fn bridge(config: &BridgeConfig, s: &Session, user: &Value) -> Option<Value> {
    let id = user["name"].as_str()?;
    let (local, domain) = id.strip_prefix('@')?.split_once(':')?;
    if domain != s.user_id.split_once(':')?.1 {
        return None;
    }
    if let Some(rule) = config
        .rules
        .iter()
        .find(|r| r.homeserver == s.matrix.origin && id.starts_with(&r.user_prefix))
    {
        return Some(json!({"name":rule.name,"source":"部署规则","rule":rule.user_prefix}));
    }
    if let Some(appservice) = user["appservice_id"].as_str().filter(|s| !s.is_empty()) {
        return Some(json!({"name":appservice,"source":"服务器归属","rule":appservice}));
    }
    if !config.detect_common {
        return None;
    }
    // Strict formats supplied by the operator; a namespace match is a candidate,
    // never proof that an account belongs to a bridge. Deletion requires a preview.
    if let Some(suffix) = local.strip_prefix("signal_") {
        if suffix.len() == 36
            && suffix.bytes().enumerate().all(|(i, c)| {
                if [8, 13, 18, 23].contains(&i) {
                    c == b'-'
                } else {
                    c.is_ascii_hexdigit()
                }
            })
        {
            return Some(json!({"name":"Signal","source":"ID 格式匹配","rule":"@signal_<UUID>"}));
        }
    }
    for (prefix, name, rule) in [
        ("telegram_", "Telegram", "@telegram_<数字>"),
        ("whatsapp_", "WhatsApp", "@whatsapp_<数字>"),
        ("discord_", "Discord", "@discord_<数字>"),
        ("instagram_", "Instagram", "@instagram_<数字>"),
        ("meta_", "Meta", "@meta_<数字>"),
        ("gmessages_", "Google Messages", "@gmessages_<数字>"),
    ] {
        if let Some(suffix) = local.strip_prefix(prefix)
            && !suffix.is_empty()
            && suffix.bytes().all(|c| c.is_ascii_digit())
        {
            return Some(json!({"name": name, "source": "ID 格式匹配", "rule": rule}));
        }
    }
    None
}
fn is_true(v: &Value) -> bool {
    v == true || v == 1
}
fn is_erased(u: &Value) -> bool {
    is_true(&u["erased"])
}
fn protected(s: &Session, u: &Value) -> bool {
    let id = u["name"].as_str().unwrap_or_default();
    let local = id.split(':').next().unwrap_or_default();
    is_true(&u["admin"])
        || id == s.user_id
        || matches!(local, "@conduit" | "@tuwunel" | "@server")
        || !id
            .split_once(':')
            .zip(s.user_id.split_once(':'))
            .is_some_and(|(a, b)| a.1 == b.1)
}
async fn rows(state: &AppState, s: &Session, refresh: bool) -> Result<Vec<Value>> {
    let _guard = state.directory_lock.lock().await;
    if !refresh {
        if let Some(d) = state
            .directory_cache
            .lock()
            .await
            .get(&s.matrix.origin)
            .filter(|d| now() - d.at < 30000)
        {
            return Ok(d.rows.clone());
        }
    }
    let mut rows = Vec::new();
    let mut from = 0;
    let mut seen = HashSet::new();
    loop {
        let data = s
            .matrix
            .request(
                &s.token,
                Method::GET,
                &format!(
                    "/_synapse/admin/v2/users?from={from}&limit=500&deactivated=true&locked=true"
                ),
                None,
            )
            .await?;
        let batch = data["users"]
            .as_array()
            .ok_or_else(|| AppError::new(502, "用户列表响应无效"))?;
        for u in batch {
            let id = u["name"]
                .as_str()
                .ok_or_else(|| AppError::new(502, "用户列表缺少 ID"))?;
            if !seen.insert(id.to_owned()) {
                return Err(AppError::new(502, "用户列表分页重复，请刷新后重试"));
            }
            if is_erased(u) {
                continue;
            }
            let mut u = u.clone();
            u["bridge"] = bridge(&state.config.bridges, s, &u).unwrap_or(Value::Null);
            u["protected"] = json!(protected(s, &u));
            rows.push(u);
        }
        if data["next_token"].is_null() {
            break;
        }
        let next = data["next_token"]
            .as_str()
            .and_then(|x| x.parse::<usize>().ok())
            .or_else(|| data["next_token"].as_u64().map(|n| n as usize))
            .ok_or_else(|| AppError::new(502, "用户分页游标无效"))?;
        if next <= from || batch.is_empty() {
            return Err(AppError::new(502, "用户列表分页没有前进"));
        }
        if rows.len() >= 50000 {
            return Err(AppError::new(
                413,
                "用户目录超过 50,000 个账号，当前版本无法安全生成完整分类，请使用高级 API 分页查看",
            ));
        }
        from = next;
    }
    let mut cache = state.directory_cache.lock().await;
    cache.retain(|_, v| now() - v.at < 30000);
    if cache.len() >= 4 {
        cache.clear();
    }
    cache.insert(
        s.matrix.origin.clone(),
        Directory {
            at: now(),
            rows: rows.clone(),
        },
    );
    Ok(rows)
}
#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct Filter {
    from: usize,
    search: String,
    group: String,
    status: String,
    refresh: bool,
}
fn matches(u: &Value, f: &Filter) -> bool {
    let q = f.search.to_lowercase();
    (q.is_empty()
        || u["name"]
            .as_str()
            .unwrap_or_default()
            .to_lowercase()
            .contains(&q)
        || u["displayname"]
            .as_str()
            .unwrap_or_default()
            .to_lowercase()
            .contains(&q))
        && match f.group.as_str() {
            "" | "regular" => u["bridge"].is_null(),
            "bridges" => !u["bridge"].is_null(),
            "all" => true,
            name => u["bridge"]["name"] == name,
        }
        && match f.status.as_str() {
            "active" => !is_true(&u["deactivated"]),
            "unerased" => !is_erased(u),
            "erased" => is_erased(u),
            "admin" => is_true(&u["admin"]),
            _ => true,
        }
}
pub async fn directory(
    State(state): State<AppState>,
    headers: HeaderMap,
    Payload(f): Payload<Filter>,
) -> Result<Json<Value>> {
    let (_, s) = auth(&state, &headers, true).await?;
    let all = rows(&state, &s, f.refresh).await?;
    let mut groups = BTreeMap::<String, usize>::new();
    let mut pending_groups = BTreeMap::<String, usize>::new();
    let mut regular_total = 0usize;
    let mut regular_erased = 0usize;
    let mut bridges_erased = 0usize;
    for row in &all {
        let erased = is_erased(row);
        if let Some(name) = row["bridge"]["name"].as_str() {
            *groups.entry(name.into()).or_default() += 1;
            if erased {
                bridges_erased += 1;
            } else {
                *pending_groups.entry(name.into()).or_default() += 1;
            }
        } else {
            regular_total += 1;
            if erased {
                regular_erased += 1;
            }
        }
    }
    let bridge_count = groups.values().sum::<usize>();
    let bridges_pending = bridge_count - bridges_erased;
    let filtered: Vec<_> = all.iter().filter(|u| matches(u, &f)).collect();
    let total = filtered.len();
    Ok(Json(json!({
        "users": filtered.into_iter().skip(f.from).take(20).collect::<Vec<_>>(),
        "total": total,
        "next_token": (f.from.saturating_add(20) < total).then(|| f.from + 20),
        "counts": {
            "regular": regular_total,
            "regularActive": regular_total - regular_erased,
            "bridges": bridge_count,
            "bridgesPending": bridges_pending,
            "bridgesErased": bridges_erased,
            "erased": regular_erased + bridges_erased,
            "all": all.len()
        },
        "groups": groups,
        "pendingGroups": pending_groups
    })))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    #[serde(default)]
    ids: Vec<String>,
    #[serde(default)]
    all: bool,
    #[serde(default)]
    filter: Filter,
}
pub async fn preview(
    State(state): State<AppState>,
    headers: HeaderMap,
    Payload(input): Payload<Selection>,
) -> Result<Json<Value>> {
    let (session, s) = auth(&state, &headers, true).await?;
    if input.all && !input.ids.is_empty() {
        return Err(AppError::new(400, "不能同时指定全选和用户列表"));
    }
    let all = rows(&state, &s, true).await?;
    let requested: HashSet<_> = input.ids.iter().collect();
    let mut chosen: Vec<Value> = all
        .iter()
        .filter(|u| {
            if input.all {
                matches(u, &input.filter) && !u["bridge"].is_null() && !protected(&s, u)
            } else {
                u["name"]
                    .as_str()
                    .is_some_and(|id| requested.contains(&id.to_string()))
            }
        })
        .cloned()
        .collect();
    if !input.all && chosen.len() < requested.len() {
        // Allow explicit retry of an already-erased bridge account whose media drain failed mid-way.
        for req_id in &input.ids {
            if !chosen.iter().any(|u| u["name"].as_str() == Some(req_id)) {
                validate_id(req_id)?;
                if let Ok(mut u) = request(
                    &s,
                    Method::GET,
                    format!("/_synapse/admin/v2/users/{}", encode(req_id)),
                    None,
                )
                .await
                {
                    if u["name"].is_null() {
                        u["name"] = json!(req_id);
                    }
                    u["bridge"] = bridge(&state.config.bridges, &s, &u).unwrap_or(Value::Null);
                    u["protected"] = json!(protected(&s, &u));
                    chosen.push(u);
                }
            }
        }
    }
    if chosen.is_empty() || chosen.len() > 10000 || (!input.all && chosen.len() != requested.len())
    {
        return Err(AppError::new(
            400,
            "请选择存在的桥接用户；每次最多 10,000 个，超过时请按桥接或名称分批清理",
        ));
    }
    for u in &chosen {
        if protected(&s, u) || u["bridge"].is_null() {
            return Err(AppError::new(
                403,
                "禁止清理管理员、系统账号、远程账号或未匹配桥接规则的用户",
            ));
        }
    }
    let ids = chosen
        .iter()
        .map(|u| u["name"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    let id = random_hex(24);
    let count = ids.len();
    let mut plans = state.cleanup_plans.lock().await;
    plans.retain(|_, p| now() - p.at < 600000);
    if plans.len() >= 32 {
        return Err(AppError::new(429, "预览过多，请稍后重试"));
    }
    plans.insert(
        id.clone(),
        Plan {
            session,
            origin: s.matrix.origin,
            actor: s.user_id,
            at: now(),
            ids,
        },
    );
    Ok(Json(
        json!({"plan":id,"count":count,"users":chosen,"expires":now()+600000,"confirmation":format!("清理 {count} 个桥接用户"),"scope":"停用并擦除资料、注销设备、退出房间、清除账户数据，循环删除该账号上传的全部本地媒体与缩略图，并复核剩余数据。","limits":"Matrix 用户 ID 和历史事件仍可能保留；不删除共享房间、其他服务器副本、独立桥接程序数据库或无法归属到该用户的远程缓存。请先停止对应桥接，避免重新写入或创建账号。"}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Start {
    plan: String,
    confirm: String,
}
pub async fn start(
    State(state): State<AppState>,
    headers: HeaderMap,
    Payload(input): Payload<Start>,
) -> Result<Json<Value>> {
    let (session, s) = auth(&state, &headers, true).await?;
    let mut plans = state.cleanup_plans.lock().await;
    let plan = plans
        .get(&input.plan)
        .ok_or_else(|| AppError::new(409, "预览已失效，请重新生成"))?;
    if plan.session != session
        || plan.origin != s.matrix.origin
        || plan.actor != s.user_id
        || now() - plan.at >= 600000
    {
        return Err(AppError::new(403, "预览不属于当前会话或已超时"));
    }
    if input.confirm != format!("清理 {} 个桥接用户", plan.ids.len()) {
        return Err(AppError::new(400, "请输入完整确认文字"));
    }
    let ids = plan.ids.clone();
    let job_id = random_hex(16);
    let key = job_id.clone();
    let origin = s.matrix.origin.clone();
    let actor = s.user_id.clone();
    let targets = ids.clone();
    store::access(&state.store,true,move |store| {
        if store.data.cleanup_jobs.values().any(|j|j["homeserver"]==origin && j["status"]=="running") || store.data.media_jobs.values().any(|j|j["homeserver"]==origin && j["status"]=="running") {return Err(AppError::new(409,"此服务器已有桥接清理任务在运行"));}
        if store.data.cleanup_jobs.len()>=20 {
            let oldest=store.data.cleanup_jobs.iter().filter(|(_,j)|j["status"]!="running").min_by_key(|(_,j)|j["created"].as_u64().unwrap_or(0)).map(|(id,_)|id.clone());
            if let Some(id)=oldest {store.data.cleanup_jobs.remove(&id);} else {return Err(AppError::new(429,"清理任务过多"));}
        }
        store.audit(&origin, &actor, "开始桥接用户清理", &format!("{} 个用户", targets.len()), "success");
        store.data.cleanup_jobs.insert(key.clone(),json!({"id":key,"homeserver":origin,"actor":actor,"created":now(),"status":"running","cancelRequested":false,"total":targets.len(),"targets":targets,"results":[],"processed":0})); Ok(())
    }).await?;
    plans.remove(&input.plan);
    drop(plans);
    let job = (state.clone(), s.clone());
    let key = job_id.clone();
    tokio::spawn(async move {
        run(job.0, job.1, headers, key, ids).await;
    });
    Ok(Json(json!({"id":job_id})))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Cancel {
    id: String,
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
            .cleanup_jobs
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
pub async fn jobs(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<Value>> {
    let (_, s) = auth(&state, &headers, false).await?;
    let rows = store::access(&state.store, false, move |store| {
        let mut jobs = store
            .data
            .cleanup_jobs
            .values()
            .filter(|j| j["homeserver"] == s.matrix.origin)
            .cloned()
            .collect::<Vec<_>>();
        jobs.sort_by_key(|j| std::cmp::Reverse(j["created"].as_u64().unwrap_or(0)));
        Ok(jobs)
    })
    .await?;
    Ok(Json(json!({"jobs":rows})))
}
async fn request(s: &Session, method: Method, path: String, body: Option<Value>) -> Result<Value> {
    s.matrix
        .request(&s.token, method, &path, body.as_ref())
        .await
}
async fn clean(state: &AppState, headers: &HeaderMap, id: &str, result: &mut Value) -> Result<()> {
    validate_id(id)?;
    let (_, s) = auth(state, headers, true).await?;
    // Fresh upstream checks precede each destructive user operation.
    s.matrix.verify(&s.token).await?;
    let u = request(
        &s,
        Method::GET,
        format!("/_synapse/admin/v2/users/{}", encode(id)),
        None,
    )
    .await?;
    if u["admin"] != false && u["admin"] != 0 {
        return Err(AppError::new(403, "无法确认目标不是管理员，已跳过"));
    }
    if protected(&s, &u) || u["name"] != id || bridge(&state.config.bridges, &s, &u).is_none() {
        return Err(AppError::new(403, "账号权限或桥接归属已变化，已跳过"));
    }
    // Deactivation may leave many federated rooms; allow a wider timeout than quick reads.
    let deactivate_timeout = Some(state.config.limits.request_timeout_seconds.clamp(120, 300));
    s.matrix
        .request_with_timeout(
            &s.token,
            Method::POST,
            &format!("/_synapse/admin/v1/deactivate/{}", encode(id)),
            Some(&json!({"erase":true})),
            deactivate_timeout,
        )
        .await?;
    result["deactivated"] = json!(true);
    let path = format!("/_synapse/admin/v1/users/{}/media", encode(id));
    let server_name = id.split_once(':').map(|(_, d)| d).unwrap_or_default();
    let mut previous = String::new();
    loop {
        let (_, s) = auth(state, headers, true).await?;
        let remaining = request(&s, Method::GET, format!("{path}?from=0&limit=100"), None).await?;
        let media = remaining["media"]
            .as_array()
            .ok_or_else(|| AppError::new(502, "媒体列表响应无效"))?;
        if media.is_empty() && remaining["total"].as_u64().unwrap_or(0) > 0 {
            return Err(AppError::new(502, "媒体列表与剩余数量不一致"));
        }
        if media.is_empty() {
            result["mediaVerified"] = json!(true);
            break;
        }
        let first = media[0]["media_id"]
            .as_str()
            .ok_or_else(|| AppError::new(502, "媒体 ID 缺失"))?;
        if first == previous {
            return Err(AppError::new(502, "媒体清理没有前进，请检查文件存储后重试"));
        }
        previous = first.to_owned();
        let deleted = request(
            &s,
            Method::DELETE,
            format!("{path}?from=0&limit=100"),
            Some(json!({})),
        )
        .await?;
        let mut count = deleted["deleted_media"]
            .as_array()
            .map(|a| a.len())
            .unwrap_or(0);
        if count == 0 && !server_name.is_empty() {
            // Fallback to individual media deletion if batch deletion skipped items.
            for item in media {
                if let Some(mid) = item["media_id"].as_str()
                    && request(
                        &s,
                        Method::DELETE,
                        format!(
                            "/_synapse/admin/v1/media/{}/{}",
                            encode(server_name),
                            encode(mid)
                        ),
                        Some(json!({})),
                    )
                    .await
                    .is_ok()
                {
                    count += 1;
                }
            }
        }
        if count == 0 {
            return Err(AppError::new(
                502,
                "仍有媒体但服务器未删除任何文件，请检查 Tuwunel 的媒体存储权限后重试",
            ));
        }
        result["mediaDeleted"] = json!(result["mediaDeleted"].as_u64().unwrap_or(0) + count as u64);
    }
    let (_, s) = auth(state, headers, true).await?;
    let mut profile = request(
        &s,
        Method::GET,
        format!("/_synapse/admin/v2/users/{}", encode(id)),
        None,
    )
    .await?;
    if profile["avatar_url"]
        .as_str()
        .is_some_and(|v| !v.is_empty())
        || profile["displayname"]
            .as_str()
            .is_some_and(|v| !v.is_empty())
    {
        let _ = request(
            &s,
            Method::PUT,
            format!("/_synapse/admin/v2/users/{}", encode(id)),
            Some(json!({"displayname": "", "avatar_url": ""})),
        )
        .await;
        profile = request(
            &s,
            Method::GET,
            format!("/_synapse/admin/v2/users/{}", encode(id)),
            None,
        )
        .await?;
    }
    if !is_true(&profile["deactivated"])
        || !is_true(&profile["erased"])
        || profile["avatar_url"]
            .as_str()
            .is_some_and(|v| !v.is_empty())
        || profile["displayname"]
            .as_str()
            .is_some_and(|v| !v.is_empty())
    {
        return Err(AppError::new(
            502,
            "服务器尚未完成停用和资料擦除，请检查账号状态后重试",
        ));
    }
    let devices_resp = request(
        &s,
        Method::GET,
        format!("/_synapse/admin/v2/users/{}/devices", encode(id)),
        None,
    )
    .await?;
    let device_ids: Vec<String> = devices_resp["devices"]
        .as_array()
        .ok_or_else(|| AppError::new(502, "设备列表响应无效"))?
        .iter()
        .filter_map(|d| d["device_id"].as_str().map(str::to_owned))
        .collect();
    if !device_ids.is_empty() {
        let _ = request(
            &s,
            Method::POST,
            format!("/_synapse/admin/v2/users/{}/delete_devices", encode(id)),
            Some(json!({"devices": device_ids})),
        )
        .await;
        let check = request(
            &s,
            Method::GET,
            format!("/_synapse/admin/v2/users/{}/devices", encode(id)),
            None,
        )
        .await?;
        if !check["devices"].as_array().is_some_and(|a| a.is_empty()) {
            return Err(AppError::new(
                502,
                "清理后仍存在未注销的设备，请检查服务器后重试",
            ));
        }
    }
    let rooms_resp = request(
        &s,
        Method::GET,
        format!("/_synapse/admin/v1/users/{}/joined_rooms", encode(id)),
        None,
    )
    .await?;
    let joined = rooms_resp["joined_rooms"]
        .as_array()
        .ok_or_else(|| AppError::new(502, "已加入房间响应无效"))?;
    if !joined.is_empty() {
        let sample = joined
            .iter()
            .filter_map(Value::as_str)
            .take(3)
            .collect::<Vec<_>>()
            .join(", ");
        return Err(AppError::new(
            502,
            format!(
                "停用后仍停留在 {} 个房间（{}），可能是远端联邦房间退房失败，请检查服务器后重试",
                joined.len(),
                sample
            ),
        ));
    }
    let data = request(
        &s,
        Method::GET,
        format!("/_synapse/admin/v1/users/{}/accountdata", encode(id)),
        None,
    )
    .await?;
    let data = data.get("account_data").unwrap_or(&data);
    let global_empty = data
        .get("global")
        .is_none_or(|v| v.is_null() || v.as_object().is_some_and(|m| m.is_empty()));
    if !global_empty {
        return Err(AppError::new(
            502,
            "全局账户数据未能确认清空，请检查服务器后重试",
        ));
    }
    let remaining_room_data = data
        .get("rooms")
        .and_then(Value::as_object)
        .map(|m| m.len())
        .unwrap_or(0);
    if remaining_room_data > 0 {
        // User has already left all joined rooms; Tuwunel does not sweep room account data
        // for historical banned rooms and exposes no API to delete it.
        result["note"] = json!(format!(
            "已退出全部房间；保留了 {remaining_room_data} 条已退出/封禁历史房间的账户数据（上游未提供清除接口）"
        ));
    }
    result["accountVerified"] = json!(true);
    Ok(())
}
async fn is_canceled(state: &AppState, key: &str) -> bool {
    let job = key.to_owned();
    store::access(&state.store, false, move |store| {
        Ok(store
            .data
            .cleanup_jobs
            .get(&job)
            .is_none_or(|j| j["cancelRequested"] == true))
    })
    .await
    .unwrap_or(true)
}
async fn run(state: AppState, s: Session, headers: HeaderMap, key: String, ids: Vec<String>) {
    for id in ids {
        if is_canceled(&state, &key).await {
            break;
        }
        let mut row =
            json!({"user_id":id,"mediaDeleted":0,"deactivated":false,"status":"complete"});
        if let Err(error) = clean(&state, &headers, &id, &mut row).await {
            row["status"] = json!("failed");
            row["error"] = json!(error.message);
        }
        let status = if row["status"] == "complete" {
            "success"
        } else {
            "failed"
        };
        let _ = audit(&state, &s, "清理桥接用户与媒体", &id, status).await;
        let job = key.clone();
        let saved = store::access(&state.store, true, move |store| {
            let job = store
                .data
                .cleanup_jobs
                .get_mut(&job)
                .ok_or_else(|| AppError::new(500, "清理记录不存在"))?;
            job["results"].as_array_mut().unwrap().push(row);
            job["processed"] = json!(job["results"].as_array().unwrap().len());
            Ok(())
        })
        .await;
        state.directory_cache.lock().await.remove(&s.matrix.origin);
        if saved.is_err() {
            break;
        }
        if auth(&state, &headers, true).await.is_err() {
            break;
        }
    }
    let _ = store::access(&state.store, true, move |store| {
        if let Some(job) = store.data.cleanup_jobs.get_mut(&key) {
            let failed = job["results"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r["status"] != "complete");
            job["status"] = json!(if job["cancelRequested"] == true
                && job["processed"] != job["total"]
            {
                "canceled"
            } else if job["processed"] != job["total"] {
                "interrupted"
            } else if failed {
                "partial"
            } else {
                "complete"
            });
            job["finished"] = json!(now());
        }
        Ok(())
    })
    .await;
}
