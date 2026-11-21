use crate::{
    app::{self, AppState, Payload},
    config::Config,
    error::{AppError, Result},
    matrix::{self, Matrix},
    store::{self, now, random_hex},
};
use axum::{
    Json,
    extract::{ConnectInfo, Query, State},
    http::{HeaderMap, HeaderValue, Method},
    response::{IntoResponse, Redirect, Response},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{net::SocketAddr, sync::Arc};
use subtle::ConstantTimeEq;
use tokio::sync::Mutex;
use url::Url;

#[derive(Clone)]
pub struct Discovery {
    pub matrix: Matrix,
    pub password: bool,
    pub sso: bool,
    pub providers: Vec<Value>,
    pub metadata: Option<Value>,
    pub native_oidc: bool,
    pub warning: Option<String>,
    pub expires: u64,
}
impl Discovery {
    fn public(&self) -> Value {
        let oauth = self.metadata.is_some();
        json!({
            "homeserver": self.matrix.origin,
            "password": self.password && !oauth,
            "sso": self.sso && !oauth,
            "providers": if oauth { Value::Array(vec![]) } else { json!(self.providers) },
            "oauth": oauth,
            "nativeOidc": self.native_oidc,
            "issuer": self.metadata.as_ref().and_then(|m| m["issuer"].as_str()),
            "preferred": if oauth { "oauth" } else if self.sso && !self.password { "sso" } else { "password" },
            "warning": self.warning
        })
    }
}
#[derive(Clone)]
pub struct Pending {
    origin: String,
    nonce: String,
    expires: u64,
    flow: Flow,
}
#[derive(Clone)]
enum Flow {
    Sso,
    OAuth {
        metadata: Value,
        client_id: String,
        verifier: String,
        redirect_uri: String,
        scope: String,
    },
}
#[derive(Clone)]
pub struct OAuthSession {
    pub access: String,
    refresh: Option<String>,
    expires: u64,
    metadata: Value,
    client_id: String,
}

fn endpoint(config: &Config, homeserver: &str, value: &str) -> Result<(reqwest::Client, Url)> {
    let url = Url::parse(value).map_err(|_| AppError::new(502, "服务器公布了无效的认证地址"))?;
    let origin = url.origin().ascii_serialization();
    let trusted = (origin == homeserver && config.select_homeserver(Some(homeserver))?.1)
        || config.auth.allowed_origins.contains(&origin);
    Ok((matrix::safe_client(config, &url, trusted)?, url))
}
async fn remote(
    config: &Config,
    hs: &str,
    url: &str,
    method: Method,
    body: Option<Value>,
    form: Option<Vec<(&str, String)>>,
) -> Result<Value> {
    let (client, url) = endpoint(config, hs, url)?;
    let mut request = client.request(method, url);
    if let Some(body) = body {
        request = request.json(&body);
    }
    if let Some(form) = form {
        request = request.form(&form);
    }
    let response = request
        .send()
        .await
        .map_err(|_| AppError::new(502, "认证服务器无法连接，请检查 TLS、地址与内网允许列表"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppError::new(
            502,
            format!(
                "认证服务器拒绝请求（HTTP {}），请检查客户端注册、回调地址和服务器配置",
                status.as_u16()
            ),
        ));
    }
    let bytes = matrix::limited_bytes(response, 128 * 1024).await?;
    if bytes.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(&bytes).map_err(|_| AppError::new(502, "认证服务器没有返回有效 JSON"))
}
fn field<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 8192)
        .ok_or_else(|| AppError::new(502, format!("认证响应缺少 {key}")))
}
fn contains(v: &Value, key: &str, item: &str) -> bool {
    v[key]
        .as_array()
        .is_some_and(|a| a.iter().any(|v| v == item))
}
async fn optional(matrix: &Matrix, path: &str) -> Result<Option<Value>> {
    match matrix.request("", Method::GET, path, None).await {
        Ok(v) => Ok(Some(v)),
        Err(e) if matches!(e.status.as_u16(), 404 | 405 | 501) => Ok(None),
        Err(e) => Err(e),
    }
}
async fn metadata(matrix: &Matrix, config: &Config) -> Result<Option<Value>> {
    for path in [
        "/_matrix/client/v1/auth_metadata",
        "/_matrix/client/unstable/org.matrix.msc2965/auth_metadata",
    ] {
        if let Some(v) = optional(matrix, path).await? {
            return validate_metadata(matrix, config, v).map(Some);
        }
    }
    for path in [
        "/_matrix/client/v1/auth_issuer",
        "/_matrix/client/unstable/org.matrix.msc2965/auth_issuer",
    ] {
        if let Some(v) = optional(matrix, path).await? {
            let issuer = field(&v, "issuer")?;
            let url = format!(
                "{}/.well-known/openid-configuration",
                issuer.trim_end_matches('/')
            );
            let data = remote(config, &matrix.origin, &url, Method::GET, None, None).await?;
            if data["issuer"] != issuer {
                return Err(AppError::new(502, "认证服务器 issuer 不匹配"));
            }
            return validate_metadata(matrix, config, data).map(Some);
        }
    }
    Ok(None)
}
fn validate_metadata(matrix: &Matrix, config: &Config, data: Value) -> Result<Value> {
    for key in [
        "issuer",
        "authorization_endpoint",
        "token_endpoint",
        "revocation_endpoint",
    ] {
        endpoint(config, &matrix.origin, field(&data, key)?)?;
    }
    if let Some(url) = data["registration_endpoint"].as_str() {
        endpoint(config, &matrix.origin, url)?;
    }
    if !contains(&data, "code_challenge_methods_supported", "S256")
        || !contains(&data, "response_types_supported", "code")
    {
        return Err(AppError::new(
            502,
            "认证服务器不支持安全的授权码与 PKCE S256 登录",
        ));
    }
    if let Some(modes) = data["response_modes_supported"].as_array()
        && !modes.iter().any(|v| v == "query")
    {
        return Err(AppError::new(502, "认证服务器不支持 query 回调模式"));
    }
    Ok(data)
}
pub async fn discover(state: &AppState, input: Option<&str>) -> Result<Discovery> {
    let (origin, _) = state.config.select_homeserver(input)?;
    if let Some(d) = state
        .discovery
        .lock()
        .await
        .get(&origin)
        .filter(|d| d.expires > now())
        .cloned()
    {
        return Ok(d);
    }
    let matrix = Matrix::new(&state.config, &origin)?;
    let (flows, meta) = tokio::join!(
        optional(&matrix, "/_matrix/client/v3/login"),
        metadata(&matrix, &state.config)
    );
    let mut warning = None;
    let meta = match meta {
        Ok(v) => v,
        Err(e) => {
            warning = Some(e.message);
            None
        }
    };
    let flows = match flows {
        Ok(v) => v.unwrap_or(json!({"flows":[]})),
        Err(e) if meta.is_some() => {
            warning = Some(e.message);
            json!({"flows":[]})
        }
        Err(e) => return Err(e),
    };
    let methods = flows["flows"].as_array();
    if methods.is_none() && meta.is_none() {
        return Err(AppError::new(502, "该地址没有返回有效的 Matrix 登录方式"));
    }
    let list = methods.cloned().unwrap_or_default();
    let password = list.iter().any(|v| v["type"] == "m.login.password");
    let sso_flow = list.iter().find(|v| v["type"] == "m.login.sso");
    let sso = sso_flow.is_some() && list.iter().any(|v| v["type"] == "m.login.token");
    let providers=sso_flow.and_then(|v|v["identity_providers"].as_array()).map(|v|v.iter().take(20).filter_map(|p|Some(json!({"id":p["id"].as_str()?,"name":p["name"].as_str().unwrap_or("单点登录")}))).collect()).unwrap_or_default();
    let native_oidc = meta.as_ref().is_some_and(|m| {
        [
            "authorization_endpoint",
            "token_endpoint",
            "registration_endpoint",
        ]
        .iter()
        .any(|k| m[k].as_str().is_some_and(|u| u.contains("/_tuwunel/oidc/")))
    });
    let d = Discovery {
        matrix,
        password,
        sso,
        providers,
        metadata: meta,
        native_oidc,
        warning,
        expires: now() + 60000,
    };
    let mut cache = state.discovery.lock().await;
    cache.retain(|_, v| v.expires > now());
    if cache.len() >= 128 {
        cache.clear();
    }
    cache.insert(origin, d.clone());
    Ok(d)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscoverInput {
    homeserver: Option<String>,
}
pub async fn probe(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Payload(input): Payload<DiscoverInput>,
) -> Result<Json<Value>> {
    app::limit(&state.discovery_attempts, addr.ip(), 120, 60000).await?;
    Ok(Json(
        discover(&state, input.homeserver.as_deref())
            .await?
            .public(),
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartInput {
    homeserver: Option<String>,
    kind: String,
    provider: Option<String>,
}
fn pending_cookie(state: &AppState, nonce: &str, age: u64) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "ta_auth={nonce}; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age={age}{}",
        if state.config.server.cookie_secure {
            "; Secure"
        } else {
            ""
        }
    ))
    .unwrap()
}
async fn client_id(state: &AppState, d: &Discovery, m: &Value, redirect: &str) -> Result<String> {
    let issuer = field(m, "issuer")?;
    if let Some(client) = state
        .config
        .auth
        .clients
        .iter()
        .find(|c| c.issuer == issuer)
    {
        return Ok(client.client_id.clone());
    }
    let key = serde_json::to_string(&[&d.matrix.origin, issuer, redirect]).unwrap();
    let _guard = state.registration_lock.lock().await;
    let lookup = key.clone();
    if let Some(id) = store::access(&state.store, false, move |s| {
        let cached = s.data.oauth_clients.get(&lookup).cloned();
        if cached.is_none() && s.data.oauth_clients.len() >= 128 {
            return Err(AppError::new(
                400,
                "自动注册客户端数量已达上限，请配置 auth.clients",
            ));
        }
        Ok(cached)
    })
    .await?
    {
        return Ok(id);
    }
    let url = field(m, "registration_endpoint").map_err(|_| {
        AppError::new(
            400,
            "服务器未开放自动注册，请部署者在 auth.clients 配置预注册的公共客户端 ID",
        )
    })?;
    let data=remote(&state.config,&d.matrix.origin,url,Method::POST,Some(json!({"client_name":"Tuwunel Admin","client_uri":state.config.server.public_url,"redirect_uris":[redirect],"application_type":"web","grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none"})),None).await?;
    let id = field(&data, "client_id")?.to_owned();
    if data["token_endpoint_auth_method"]
        .as_str()
        .is_some_and(|v| v != "none")
    {
        return Err(AppError::new(502, "认证服务器没有注册公共 PKCE 客户端"));
    }
    let saved = id.clone();
    store::access(&state.store, true, move |s| {
        if s.data.oauth_clients.len() >= 128 {
            return Err(AppError::new(
                400,
                "自动注册客户端数量已达上限，请配置 auth.clients",
            ));
        }
        s.data.oauth_clients.insert(key, saved);
        Ok(())
    })
    .await?;
    Ok(id)
}
pub async fn start(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Payload(input): Payload<StartInput>,
) -> Result<Response> {
    app::limit(
        &state.attempts,
        addr.ip(),
        state.config.limits.login_attempts,
        state.config.limits.login_window_seconds * 1000,
    )
    .await?;
    let d = discover(&state, input.homeserver.as_deref()).await?;
    let id = random_hex(32);
    let nonce = random_hex(32);
    let redirect = format!("{}/api/auth/callback", state.config.server.public_url);
    let (url, flow) = match input.kind.as_str() {
        "sso" if d.sso => {
            let provider = input.provider.filter(|p| !p.is_empty());
            if provider
                .as_ref()
                .is_some_and(|p| !d.providers.iter().any(|v| v["id"] == *p))
            {
                return Err(AppError::new(400, "未知的身份提供商"));
            }
            let path = provider
                .map(|p| format!("/{}", crate::catalog::encode(&p)))
                .unwrap_or_default();
            let mut url = Url::parse(&format!(
                "{}/_matrix/client/v3/login/sso/redirect{path}",
                d.matrix.origin
            ))
            .unwrap();
            url.query_pairs_mut()
                .append_pair("redirectUrl", &format!("{redirect}?state={id}"));
            (url, Flow::Sso)
        }
        "oauth" if d.metadata.is_some() => {
            let metadata = d.metadata.as_ref().unwrap().clone();
            let client_id = client_id(&state, &d, &metadata, &redirect).await?;
            let verifier = random_hex(32);
            let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
            let prefix = if contains(&metadata, "scopes_supported", "urn:matrix:client:api:*") {
                "urn:matrix:client"
            } else {
                "urn:matrix:org.matrix.msc2967.client"
            };
            let scope = format!("{prefix}:api:* {prefix}:device:{}", random_hex(16));
            let mut url = Url::parse(field(&metadata, "authorization_endpoint")?).unwrap();
            url.query_pairs_mut().extend_pairs([
                ("client_id", client_id.as_str()),
                ("response_type", "code"),
                ("response_mode", "query"),
                ("redirect_uri", redirect.as_str()),
                ("scope", scope.as_str()),
                ("state", id.as_str()),
                ("code_challenge", challenge.as_str()),
                ("code_challenge_method", "S256"),
            ]);
            (
                url,
                Flow::OAuth {
                    metadata,
                    client_id,
                    verifier,
                    redirect_uri: redirect,
                    scope,
                },
            )
        }
        _ => return Err(AppError::new(400, "该服务器未提供所选登录方式")),
    };
    let mut pending = state.pending_auth.lock().await;
    pending.retain(|_, p| p.expires > now());
    if pending.len() >= 1024 {
        return Err(AppError::new(429, "等待认证的请求过多，请稍后重试"));
    }
    pending.insert(
        id,
        Pending {
            origin: d.matrix.origin,
            nonce: nonce.clone(),
            expires: now() + 600000,
            flow,
        },
    );
    let mut response = Json(json!({"url":url.as_str()})).into_response();
    response
        .headers_mut()
        .append("set-cookie", pending_cookie(&state, &nonce, 600));
    Ok(response)
}
#[derive(Deserialize)]
pub struct Callback {
    state: Option<String>,
    code: Option<String>,
    #[serde(rename = "loginToken")]
    login_token: Option<String>,
    error: Option<String>,
    iss: Option<String>,
}
pub async fn callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(input): Query<Callback>,
) -> Response {
    let result = complete(&state, &headers, input).await;
    let mut response = match result {
        Ok(mut response) => {
            *response.status_mut() = axum::http::StatusCode::SEE_OTHER;
            response
                .headers_mut()
                .insert("location", HeaderValue::from_static("/"));
            *response.body_mut() = axum::body::Body::empty();
            response
        }
        Err(error) => {
            let code = match error.status.as_u16() {
                403 => "not_admin",
                400 | 401 => "expired",
                _ => "failed",
            };
            Redirect::to(&format!("/?auth_error={code}")).into_response()
        }
    };
    response
        .headers_mut()
        .append("set-cookie", pending_cookie(&state, "", 0));
    response
}
async fn complete(state: &AppState, headers: &HeaderMap, input: Callback) -> Result<Response> {
    let id = input
        .state
        .ok_or_else(|| AppError::new(400, "认证状态缺失"))?;
    let cookie = app::cookie_value(headers, "ta_auth").unwrap_or_default();
    let pending = {
        let mut map = state.pending_auth.lock().await;
        let p = map
            .get(&id)
            .filter(|p| {
                p.expires > now() && bool::from(p.nonce.as_bytes().ct_eq(cookie.as_bytes()))
            })
            .ok_or_else(|| AppError::new(400, "认证已过期或不是当前浏览器发起"))?;
        let p = p.clone();
        map.remove(&id);
        p
    };
    if input.error.is_some() {
        return Err(AppError::new(400, "认证已取消"));
    }
    let matrix = Matrix::new(&state.config, &pending.origin)?;
    let (token, oauth) = match pending.flow {
        Flow::Sso => {
            let token = input
                .login_token
                .filter(|v| !v.is_empty() && v.len() <= 8192)
                .ok_or_else(|| AppError::new(400, "登录令牌缺失"))?;
            let data=matrix.request("",Method::POST,"/_matrix/client/v3/login",Some(&json!({"type":"m.login.token","token":token,"initial_device_display_name":"Tuwunel Admin"}))).await?;
            (field(&data, "access_token")?.to_owned(), None)
        }
        Flow::OAuth {
            metadata,
            client_id,
            verifier,
            redirect_uri,
            scope,
        } => {
            let issuer = field(&metadata, "issuer")?;
            if input.iss.as_deref().is_some_and(|v| v != issuer)
                || (metadata["authorization_response_iss_parameter_supported"] == true
                    && input.iss.is_none())
            {
                return Err(AppError::new(400, "认证 issuer 不匹配"));
            }
            let code = input
                .code
                .filter(|v| !v.is_empty() && v.len() <= 8192)
                .ok_or_else(|| AppError::new(400, "授权码缺失"))?;
            let data = remote(
                &state.config,
                &pending.origin,
                field(&metadata, "token_endpoint")?,
                Method::POST,
                None,
                Some(vec![
                    ("grant_type", "authorization_code".into()),
                    ("code", code),
                    ("client_id", client_id.clone()),
                    ("redirect_uri", redirect_uri),
                    ("code_verifier", verifier),
                ]),
            )
            .await?;
            let session = OAuthSession::from_tokens(data, metadata, client_id, None)?;
            // Identity is established only by Matrix whoami + the admin API, never ID-token claims.
            let _ = scope;
            (session.access.clone(), Some(Arc::new(Mutex::new(session))))
        }
    };
    app::finish_login(state, headers, matrix, token, true, oauth).await
}
impl OAuthSession {
    fn from_tokens(
        data: Value,
        metadata: Value,
        client_id: String,
        previous: Option<String>,
    ) -> Result<Self> {
        if !field(&data, "token_type")?.eq_ignore_ascii_case("bearer") {
            return Err(AppError::new(502, "不支持的 OAuth 令牌类型"));
        }
        let access = field(&data, "access_token")?.to_owned();
        let seconds = data["expires_in"]
            .as_u64()
            .filter(|v| *v > 0 && *v < 315360000)
            .ok_or_else(|| AppError::new(502, "OAuth 响应缺少有效的 expires_in"))?;
        let refresh = data["refresh_token"]
            .as_str()
            .filter(|v| !v.is_empty() && v.len() <= 8192)
            .map(str::to_owned)
            .or(previous);
        Ok(Self {
            access,
            refresh,
            expires: now() + seconds * 1000,
            metadata,
            client_id,
        })
    }
    pub async fn current(&mut self, config: &Config, hs: &str) -> Result<String> {
        if now() + 30000 >= self.expires {
            let token = self
                .refresh
                .clone()
                .ok_or_else(|| AppError::new(401, "认证已过期，请重新登录"))?;
            let data = remote(
                config,
                hs,
                field(&self.metadata, "token_endpoint")?,
                Method::POST,
                None,
                Some(vec![
                    ("grant_type", "refresh_token".into()),
                    ("refresh_token", token),
                    ("client_id", self.client_id.clone()),
                ]),
            )
            .await
            .map_err(|_| AppError::new(401, "认证续期失败，请重新登录"))?;
            *self = Self::from_tokens(
                data,
                self.metadata.clone(),
                self.client_id.clone(),
                self.refresh.clone(),
            )?;
        }
        Ok(self.access.clone())
    }
    pub async fn revoke(&self, config: &Config, hs: &str) {
        if let Some(url) = self.metadata["revocation_endpoint"].as_str() {
            for (hint, token) in [
                ("refresh_token", self.refresh.as_deref()),
                ("access_token", Some(self.access.as_str())),
            ] {
                if let Some(token) = token {
                    let _ = remote(
                        config,
                        hs,
                        url,
                        Method::POST,
                        None,
                        Some(vec![
                            ("token", token.into()),
                            ("token_type_hint", hint.into()),
                            ("client_id", self.client_id.clone()),
                        ]),
                    )
                    .await;
                }
            }
        }
    }
}
