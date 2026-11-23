use crate::{
    app::{AppState, Payload, Session, auth},
    catalog::{AdminRequest, encode},
    error::{AppError, Result},
    store::{self, now},
};
use axum::{Json, extract::State, http::HeaderMap};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

async fn cached_room(state: &AppState, s: &Session, room_id: &str) -> Result<Value> {
    let key = format!("{}\0{room_id}", s.matrix.origin);
    if let Some((at, value)) = state.room_cache.lock().await.get(&key).cloned() {
        if now().saturating_sub(at) < 60_000 {
            return Ok(value);
        }
    }
    let _permit = state.avatar_limit.acquire().await;
    let value = s
        .matrix
        .request(
            &s.token,
            Method::GET,
            &format!("/_synapse/admin/v1/rooms/{}", encode(room_id)),
            None,
        )
        .await?;
    let mut cache = state.room_cache.lock().await;
    if cache.len() >= 1024 {
        let cutoff = now().saturating_sub(60_000);
        cache.retain(|_, (at, _)| *at > cutoff);
        if cache.len() >= 1024 {
            cache.clear();
        }
    }
    cache.insert(key, (now(), value.clone()));
    Ok(value)
}

pub async fn context(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<Value>> {
    let (_, s) = auth(&state, &headers, false).await?;
    let profile_path = format!("/_synapse/admin/v2/users/{}", encode(&s.user_id));
    let (profile, version) = tokio::join!(
        s.matrix.request(&s.token, Method::GET, &profile_path, None),
        s.matrix.request(
            &s.token,
            Method::GET,
            "/_synapse/admin/v1/server_version",
            None
        )
    );
    let mut out = json!({"profile":null,"version":null});
    for (key, result) in [("profile", profile), ("version", version)] {
        match result {
            Ok(v) => out[key] = v,
            Err(e) => out[format!("{key}Error")] = json!(e.message),
        }
    }
    Ok(Json(out))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoomRequest {
    pub user_id: String,
    #[serde(default)]
    pub from: usize,
}
pub async fn user_rooms(
    State(state): State<AppState>,
    headers: HeaderMap,
    Payload(input): Payload<RoomRequest>,
) -> Result<Json<Value>> {
    let (_, s) = auth(&state, &headers, true).await?;
    validate_id(&input.user_id)?;
    let result = s
        .matrix
        .request(
            &s.token,
            Method::GET,
            &format!(
                "/_synapse/admin/v1/users/{}/joined_rooms",
                encode(&input.user_id)
            ),
            None,
        )
        .await?;
    let ids = result["joined_rooms"]
        .as_array()
        .ok_or_else(|| AppError::new(502, "房间列表响应无效"))?;
    let total = ids.len();
    let mut tasks = tokio::task::JoinSet::new();
    for (index, id) in ids.iter().skip(input.from).take(20).enumerate() {
        let id = id
            .as_str()
            .ok_or_else(|| AppError::new(502, "房间 ID 无效"))?
            .to_owned();
        let s = s.clone();
        let state = state.clone();
        tasks.spawn(async move {
            let result = cached_room(&state, &s, &id).await;
            let row = match result {
                Ok(v) => json!({"room_id":id,"name":v["name"],"avatar":v["avatar"],"canonical_alias":v["canonical_alias"],"joined_members":v["joined_members"]}),
                Err(e) => json!({"room_id":id,"error":e.message})
            };
            (index,row)
        });
    }
    let mut rows = Vec::new();
    while let Some(row) = tasks.join_next().await {
        rows.push(row.map_err(AppError::internal)?);
    }
    rows.sort_by_key(|(index, _)| *index);
    Ok(Json(
        json!({"rooms":rows.into_iter().map(|(_,v)| v).collect::<Vec<_>>(),"total":total,"next_token":(input.from.saturating_add(20)<total).then(||input.from+20)}),
    ))
}
pub fn validate_id(id: &str) -> Result<()> {
    if !id.starts_with('@')
        || !id.contains(':')
        || id.len() > 1024
        || id
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | '%'))
    {
        return Err(AppError::new(400, "无效的 Matrix 用户 ID"));
    }
    Ok(())
}
fn token_key(origin: &str, token: &str) -> String {
    format!("{:x}", Sha256::digest(format!("{origin}\0{token}")))
}
// The upstream wire format has no source field. Never infer config origin from
// null limits: database tokens can also be unlimited. Remember only explicit rejections.
pub async fn token_result(
    state: &AppState,
    s: &Session,
    input: &AdminRequest,
    result: Result<Value>,
) -> Result<Result<Value>> {
    if matches!(input.id.as_str(), "saveToken" | "deleteToken") {
        if let Err(error) = &result {
            if error.status.as_u16() == 403 && error.message.to_lowercase().contains("config file")
            {
                let key = token_key(
                    &s.matrix.origin,
                    input.params["token"].as_str().unwrap_or_default(),
                );
                let origin = s.matrix.origin.clone();
                store::access(&state.store, true, move |store| {
                    if store.data.readonly_tokens.len() < 4096 {
                        store.data.readonly_tokens.insert(key, origin);
                    }
                    Ok(())
                })
                .await?;
                let mut e = AppError::new(
                    403,
                    "此令牌由 Tuwunel 的配置文件定义，API 不允许修改或删除。请在 Tuwunel 配置中修改 registration_token / registration_token_file 并重启；需要次数或有效期限制时，请在本面板创建新的数据库令牌。",
                );
                e.code = "M_CONFIG_TOKEN_READ_ONLY".into();
                return Ok(Err(e));
            }
        }
    }
    if input.id == "tokens" {
        if let Ok(mut data) = result {
            let known = store::access(&state.store, false, |store| {
                Ok(store.data.readonly_tokens.clone())
            })
            .await?;
            if let Some(tokens) = data["registration_tokens"].as_array_mut() {
                for t in tokens {
                    let readonly = known.contains_key(&token_key(
                        &s.matrix.origin,
                        t["token"].as_str().unwrap_or_default(),
                    ));
                    t["read_only"] = json!(readonly);
                    t["source"] = json!(if readonly {
                        "config"
                    } else if t["uses_allowed"].is_number()
                        || t["expiry_time"].is_number()
                        || t["completed"].as_u64().unwrap_or(0) > 0
                    {
                        "database"
                    } else {
                        "unknown"
                    });
                }
            }
            return Ok(Ok(data));
        }
    }
    Ok(result)
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct RoomsRequest {
    from: usize,
    search: String,
}
pub async fn rooms(
    State(state): State<AppState>,
    headers: HeaderMap,
    Payload(input): Payload<RoomsRequest>,
) -> Result<Json<Value>> {
    let (_, s) = auth(&state, &headers, true).await?;
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("from", &input.from.to_string())
        .append_pair("limit", "20")
        .append_pair("search_term", &input.search)
        .append_pair("order_by", "name")
        .finish();
    let mut data = s
        .matrix
        .request(
            &s.token,
            Method::GET,
            &format!("/_synapse/admin/v1/rooms?{query}"),
            None,
        )
        .await?;
    let rows = data["rooms"]
        .as_array()
        .ok_or_else(|| AppError::new(502, "房间列表格式无效"))?;
    let mut tasks = tokio::task::JoinSet::new();
    for (index, row) in rows.iter().cloned().enumerate() {
        let state = state.clone();
        let s = s.clone();
        tasks.spawn(async move {
            let mut row = row;
            if let Some(id) = row["room_id"].as_str() {
                match cached_room(&state, &s, id).await {
                    Ok(details) => {
                        row["avatar"] = details["avatar"].clone();
                    }
                    Err(e) => {
                        row["avatarError"] = json!(e.message);
                    }
                }
            }
            (index, row)
        });
    }
    let mut out = vec![];
    while let Some(row) = tasks.join_next().await {
        out.push(row.map_err(AppError::internal)?);
    }
    out.sort_by_key(|(i, _)| *i);
    data["rooms"] = json!(out.into_iter().map(|(_, v)| v).collect::<Vec<_>>());
    Ok(Json(data))
}
