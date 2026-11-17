use crate::{
    app::{self, AppState},
    catalog::encode,
    error::{AppError, Result},
};
use axum::{
    extract::{Query, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Avatar {
    mxc: String,
    homeserver: String,
}
pub async fn avatar(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(input): Query<Avatar>,
) -> Result<Response> {
    let (_, session) = app::auth(&state, &headers, false).await?;
    if input.homeserver != session.matrix.origin {
        return Err(AppError::new(403, "头像不属于当前服务器会话"));
    }
    let path = input
        .mxc
        .strip_prefix("mxc://")
        .ok_or_else(|| AppError::new(400, "无效头像地址"))?;
    let (server, media) = path
        .split_once('/')
        .ok_or_else(|| AppError::new(400, "无效头像地址"))?;
    if server.is_empty()
        || media.is_empty()
        || input.mxc.len() > 2048
        || server.contains(['@', '?', '#', '\\', '%'])
        || media.contains(['/', '?', '#', '\\', '%'])
        || media == "."
        || media == ".."
    {
        return Err(AppError::new(400, "无效头像地址"));
    }
    let server = encode(server);
    let media = encode(media);
    let _permit = state
        .avatar_limit
        .acquire()
        .await
        .map_err(|_| AppError::new(503, "头像服务不可用"))?;
    let paths = [
        format!(
            "/_matrix/client/v1/media/thumbnail/{server}/{media}?width=96&height=96&method=crop&allow_redirect=false"
        ),
        format!(
            "/_matrix/media/v3/thumbnail/{server}/{media}?width=96&height=96&method=crop&allow_redirect=false"
        ),
        format!("/_matrix/client/v1/media/download/{server}/{media}?allow_redirect=false"),
        format!("/_matrix/media/v3/download/{server}/{media}?allow_redirect=false"),
    ];
    for path in paths {
        match session.matrix.image(&session.token, &path).await {
            Ok((mime, bytes)) => {
                return Ok((
                    [
                        ("content-type", mime.as_str()),
                        ("content-disposition", "inline"),
                        ("vary", "Cookie"),
                    ],
                    bytes,
                )
                    .into_response());
            }
            Err(e) if matches!(e.status.as_u16(), 400 | 404 | 405 | 501) => continue,
            Err(e) => return Err(e),
        }
    }
    Err(AppError::new(404, "头像不存在"))
}
