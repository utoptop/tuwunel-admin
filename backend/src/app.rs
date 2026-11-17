use crate::{
    catalog::{self, AdminRequest, Endpoint},
    config::Config,
    error::{AppError, Result},
    matrix::Matrix,
    policy::{self, Policy, Settings},
    store::{self, SharedStore, Store, now, random_hex},
};
use axum::{
    Json, Router,
    body::Body,
    extract::{
        ConnectInfo, DefaultBodyLimit, FromRequest, Request, State, rejection::JsonRejection,
    },
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex as StdMutex},
};
use subtle::ConstantTimeEq;
use tokio::sync::{Mutex, RwLock};
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone)]
pub struct Session {
    pub token: String,
    pub owned: bool,
    pub user_id: String,
    pub csrf: String,
    pub expires: u64,
    pub verified: u64,
    pub matrix: Matrix,
}
pub struct Inner {
    pub config: Config,
    pub store: SharedStore,
    pub catalog: HashMap<String, Endpoint>,
    sessions: RwLock<HashMap<String, Session>>,
    attempts: Mutex<HashMap<IpAddr, Vec<u64>>>,
    policy_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}
pub type AppState = Arc<Inner>;
impl Inner {
    pub fn new(mut config: Config) -> Result<AppState> {
        config.validate()?;
        let store = Arc::new(StdMutex::new(Store::open(&config)?));
        Ok(Arc::new(Self {
            config,
            store,
            catalog: catalog::catalog(),
            sessions: RwLock::new(HashMap::new()),
            attempts: Mutex::new(HashMap::new()),
            policy_locks: Mutex::new(HashMap::new()),
        }))
    }
    pub async fn policy_lock(&self, origin: &str) -> Arc<Mutex<()>> {
        let mut locks = self.policy_locks.lock().await;
        // Entries with no outstanding holder can be recreated, bounding idle origins.
        locks.retain(|_, lock| Arc::strong_count(lock) > 1);
        locks.entry(origin.into()).or_default().clone()
    }
}
pub struct Payload<T>(pub T);
impl<S, T> FromRequest<S> for Payload<T>
where
    S: Send + Sync,
    T: DeserializeOwned + Send,
{
    type Rejection = AppError;
    async fn from_request(req: Request, state: &S) -> Result<Self> {
        Json::<T>::from_request(req, state)
            .await
            .map(|Json(v)| Self(v))
            .map_err(|e: JsonRejection| {
                AppError::new(
                    e.status().as_u16(),
                    "无效 JSON 请求、字段类型错误或请求体过大",
                )
            })
    }
}
fn cookie_id(headers: &HeaderMap) -> Option<String> {
    headers
        .get("cookie")?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|c| c.trim().split_once('='))
        .find(|(k, _)| *k == "ta_session")
        .map(|(_, v)| v.to_owned())
}
fn cookie(state: &AppState, value: &str, max_age: u64) -> String {
    format!(
        "ta_session={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{}",
        if state.config.server.cookie_secure {
            "; Secure"
        } else {
            ""
        }
    )
}
fn session_json(s: &Session) -> Value {
    json!({"userId":s.user_id,"csrf":s.csrf,"homeserver":s.matrix.origin,"expires":s.expires})
}
async fn auth(state: &AppState, headers: &HeaderMap, mutation: bool) -> Result<(String, Session)> {
    let id = cookie_id(headers).ok_or_else(|| AppError::new(401, "会话已过期，请重新登录"))?;
    let session = state
        .sessions
        .read()
        .await
        .get(&id)
        .cloned()
        .filter(|s| s.expires > now())
        .ok_or_else(|| AppError::new(401, "会话已过期，请重新登录"))?;
    if mutation {
        let csrf = headers
            .get("x-csrf-token")
            .map(|v| v.as_bytes())
            .unwrap_or_default();
        if !bool::from(csrf.ct_eq(session.csrf.as_bytes())) {
            return Err(AppError::new(403, "CSRF 校验失败，请刷新页面"));
        }
    }
    if now() - session.verified > 60000 {
        if let Err(e) = session.matrix.verify(&session.token).await {
            if e.status == StatusCode::UNAUTHORIZED || e.status == StatusCode::FORBIDDEN {
                state.sessions.write().await.remove(&id);
            }
            return Err(e);
        }
        if let Some(s) = state.sessions.write().await.get_mut(&id) {
            s.verified = now();
        }
    }
    Ok((id, session))
}
async fn audit(
    state: &AppState,
    s: &Session,
    action: &str,
    target: &str,
    status: &str,
) -> Result<()> {
    let (origin, user, action, target, status) = (
        s.matrix.origin.clone(),
        s.user_id.clone(),
        action.to_owned(),
        target.to_owned(),
        status.to_owned(),
    );
    store::access(&state.store, true, move |store| {
        store.audit(&origin, &user, &action, &target, &status);
        Ok(())
    })
    .await
}
pub fn router(state: AppState) -> Router {
    let static_files = ServeDir::new(&state.config.server.static_dir).not_found_service(
        ServeFile::new(state.config.server.static_dir.join("index.html")),
    );
    Router::new()
        .route(
            "/api/health",
            get(|| async {
                Json(json!({"status":"ok","version":env!("CARGO_PKG_VERSION"),"runtime":"rust"}))
            }),
        )
        .route("/api/config", get(public_config))
        .route("/api/login", post(login))
        .route("/api/session", get(session))
        .route("/api/logout", post(logout))
        .route("/api/catalog", get(get_catalog))
        .route("/api/admin", post(admin))
        .route("/api/audit", get(get_audit))
        .route("/api/policy", get(get_policy).put(save_policy))
        .route("/api/policy/run", post(run_policy))
        .route(
            "/api/{*path}",
            get(|| async { AppError::new(404, "接口不存在") })
                .post(|| async { AppError::new(404, "接口不存在") }),
        )
        .fallback_service(static_files)
        .layer(DefaultBodyLimit::max(128 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}
async fn guard(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let mut response = if req.uri().path().starts_with("/api/")
        && !matches!(*req.method(), Method::GET | Method::HEAD)
        && req.headers().get("origin").and_then(|v| v.to_str().ok())
            != Some(&state.config.server.public_url)
    {
        AppError::new(
            403,
            "请求来源不匹配，请检查 config.toml 中的 server.public_url",
        )
        .into_response()
    } else {
        next.run(req).await
    };
    for (name, value) in [
        ("x-content-type-options", "nosniff"),
        ("x-frame-options", "DENY"),
        ("referrer-policy", "no-referrer"),
        ("cache-control", "no-store"),
        (
            "content-security-policy",
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        ),
    ] {
        response
            .headers_mut()
            .insert(name, HeaderValue::from_static(value));
    }
    response
}
async fn public_config(State(state): State<AppState>) -> Json<Value> {
    let matrix = &state.config.matrix;
    Json(
        json!({"homeserver":matrix.homeserver,"locked":matrix.locked,"allowedHomeservers":matrix.allowed_homeservers,"configured":!matrix.locked||!matrix.homeserver.is_empty(),"version":env!("CARGO_PKG_VERSION")}),
    )
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Login {
    homeserver: Option<String>,
    username: Option<String>,
    password: Option<String>,
    access_token: Option<String>,
}
async fn login(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Payload(input): Payload<Login>,
) -> Result<Response> {
    {
        let mut attempts = state.attempts.lock().await;
        let window = state.config.limits.login_window_seconds * 1000;
        attempts.retain(|_, v| {
            v.retain(|t| now().saturating_sub(*t) < window);
            !v.is_empty()
        });
        if attempts.len() >= 4096 && !attempts.contains_key(&addr.ip()) {
            return Err(AppError::new(429, "登录流量过大，请稍后重试"));
        }
        let recent = attempts.entry(addr.ip()).or_default();
        if recent.len() >= state.config.limits.login_attempts {
            return Err(AppError::new(429, "登录尝试过多，请稍后重试"));
        }
        recent.push(now());
    }
    let (origin, _) = state
        .config
        .select_homeserver(input.homeserver.as_deref())?;
    let matrix = Matrix::new(&state.config, &origin)?;
    let (token, owned) = if let Some(token) = input.access_token.filter(|v| !v.is_empty()) {
        (token, false)
    } else {
        let username = input
            .username
            .filter(|v| !v.is_empty())
            .ok_or_else(|| AppError::new(400, "请输入管理员账号"))?;
        let password = input
            .password
            .filter(|v| !v.is_empty())
            .ok_or_else(|| AppError::new(400, "请输入密码"))?;
        let login=matrix.request("",Method::POST,"/_matrix/client/v3/login",Some(&json!({"type":"m.login.password","identifier":{"type":"m.id.user","user":username},"password":password,"initial_device_display_name":"Tuwunel Admin"}))).await?;
        (
            login["access_token"]
                .as_str()
                .ok_or_else(|| AppError::new(502, "上游未返回访问令牌"))?
                .to_owned(),
            true,
        )
    };
    let user_id = match matrix.verify(&token).await {
        Ok(user) => user,
        Err(error) => {
            if owned {
                let _ = matrix
                    .request(
                        &token,
                        Method::POST,
                        "/_matrix/client/v3/logout",
                        Some(&json!({})),
                    )
                    .await;
            }
            return Err(error);
        }
    };
    let session = Session {
        token,
        owned,
        user_id,
        csrf: random_hex(24),
        expires: now() + state.config.limits.session_hours * 3600000,
        verified: now(),
        matrix,
    };
    let id = random_hex(32);
    // Reserve capacity before disk I/O; never hold the session map while awaiting network.
    let old = {
        let mut sessions = state.sessions.write().await;
        if sessions.len() >= state.config.limits.max_sessions {
            drop(sessions);
            revoke(session).await;
            return Err(AppError::new(429, "当前会话数量已达上限，请稍后重试"));
        }
        let old = cookie_id(&headers).and_then(|id| sessions.remove(&id));
        sessions.insert(id.clone(), session.clone());
        old
    };
    if let Some(old) = old {
        if old.token != session.token || old.matrix.origin != session.matrix.origin {
            tokio::spawn(revoke(old));
        }
    }
    if let Err(error) = audit(&state, &session, "管理员登录", "", "success").await {
        state.sessions.write().await.remove(&id);
        revoke(session).await;
        return Err(error);
    }
    state.attempts.lock().await.remove(&addr.ip());
    let mut response = Json(session_json(&session)).into_response();
    response.headers_mut().insert(
        "set-cookie",
        HeaderValue::from_str(&cookie(
            &state,
            &id,
            state.config.limits.session_hours * 3600,
        ))
        .unwrap(),
    );
    Ok(response)
}
async fn revoke(s: Session) {
    if s.owned {
        let _ = s
            .matrix
            .request(
                &s.token,
                Method::POST,
                "/_matrix/client/v3/logout",
                Some(&json!({})),
            )
            .await;
    }
}
async fn session(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<Value>> {
    let (_, s) = auth(&state, &headers, false).await?;
    Ok(Json(session_json(&s)))
}
async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Result<Response> {
    let (id, s) = auth(&state, &headers, true).await?;
    state.sessions.write().await.remove(&id);
    tokio::spawn(revoke(s.clone()));
    audit(&state, &s, "退出登录", "", "success").await?;
    let mut response = Json(json!({"ok":true})).into_response();
    response.headers_mut().insert(
        "set-cookie",
        HeaderValue::from_str(&cookie(&state, "", 0)).unwrap(),
    );
    Ok(response)
}
async fn get_catalog(State(state): State<AppState>, headers: HeaderMap) -> Result<Response> {
    auth(&state, &headers, false).await?;
    Ok((
        [("content-type", "application/json; charset=utf-8")],
        Body::from(catalog::RAW),
    )
        .into_response())
}
async fn admin(
    State(state): State<AppState>,
    headers: HeaderMap,
    Payload(input): Payload<AdminRequest>,
) -> Result<Json<Value>> {
    let (_, s) = auth(&state, &headers, true).await?;
    let endpoint = state
        .catalog
        .get(&input.id)
        .ok_or_else(|| AppError::new(400, "未允许的管理 API"))?;
    let (method, path, body) = catalog::build(endpoint, &input)?;
    let mutating = method != Method::GET;
    let target = input
        .params
        .as_object()
        .unwrap()
        .iter()
        .filter(|(k, _)| {
            !["token", "password", "secret"]
                .iter()
                .any(|s| k.to_lowercase().contains(s))
        })
        .filter_map(|(_, v)| v.as_str())
        .collect::<Vec<_>>()
        .join(" · ")
        .chars()
        .take(512)
        .collect::<String>();
    let result = s
        .matrix
        .request(&s.token, method, &path, body.as_ref())
        .await;
    if mutating {
        audit(
            &state,
            &s,
            &endpoint.label,
            &target,
            if result.is_ok() { "success" } else { "failed" },
        )
        .await?;
    }
    result.map(Json)
}
async fn get_audit(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<Value>> {
    let (_, s) = auth(&state, &headers, false).await?;
    let origin = s.matrix.origin;
    let rows = store::access(&state.store, false, move |store| {
        Ok(store
            .data
            .audit
            .iter()
            .filter(|e| e["homeserver"] == origin)
            .cloned()
            .collect::<Vec<_>>())
    })
    .await?;
    Ok(Json(json!({"entries":rows})))
}
async fn get_policy(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<Value>> {
    let (_, s) = auth(&state, &headers, false).await?;
    let origin = s.matrix.origin;
    let mutex = state.policy_lock(&origin).await;
    let running = mutex.try_lock().is_err();
    let value = store::access(&state.store, false, move |store| {
        Ok(policy::public(store.data.policies.get(&origin), running))
    })
    .await?;
    Ok(Json(value))
}
async fn save_policy(
    State(state): State<AppState>,
    headers: HeaderMap,
    Payload(input): Payload<Value>,
) -> Result<Json<Value>> {
    let (_, s) = auth(&state, &headers, true).await?;
    if input["confirm"] != true {
        return Err(AppError::new(400, "保存策略需要明确确认"));
    }
    let settings: Settings = serde_json::from_value(input.clone())
        .map_err(|_| AppError::new(400, "无效的媒体策略字段"))?;
    settings.validate()?;
    let origin = s.matrix.origin.clone();
    let mutex = state.policy_lock(&origin).await;
    let _guard = mutex
        .try_lock()
        .map_err(|_| AppError::new(409, "清理运行期间不能修改策略"))?;
    let token = input
        .get("schedulerToken")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let owner = match &token {
        Some(token) => Some(s.matrix.verify(token).await?),
        None => None,
    };
    let value = store::access(&state.store, true, move |store| {
        let old = store.data.policies.get(&origin);
        if old.is_none() && store.data.policies.len() >= 128 {
            return Err(AppError::new(400, "媒体策略数量达到上限"));
        }
        let credential = match token {
            Some(token) => Some(store.seal(&token)?),
            None => old.and_then(|p| p.credential.clone()),
        };
        let owner = owner.or_else(|| old.and_then(|p| p.owner.clone()));
        if settings.enabled && credential.is_none() {
            return Err(AppError::new(400, "启用策略需要独立的管理员访问令牌"));
        }
        let enabled = settings.enabled;
        let policy = Policy {
            next_run: now() + settings.interval_hours * 3600000,
            settings,
            credential,
            owner,
            homeserver: origin.clone(),
            last_run: old.and_then(|p| p.last_run),
            last_result: old.and_then(|p| p.last_result.clone()),
        };
        let public = policy::public(Some(&policy), false);
        store.data.policies.insert(origin.clone(), policy);
        store.audit(
            &origin,
            &s.user_id,
            "更新媒体生命周期策略",
            if enabled { "enabled" } else { "disabled" },
            "success",
        );
        Ok(public)
    })
    .await?;
    Ok(Json(value))
}
async fn run_policy(
    State(state): State<AppState>,
    headers: HeaderMap,
    Payload(input): Payload<Value>,
) -> Result<Json<Value>> {
    let (_, s) = auth(&state, &headers, true).await?;
    if input["confirm"] != true {
        return Err(AppError::new(400, "清理需要明确确认"));
    }
    policy::run(state, s.matrix.origin, true).await.map(Json)
}
pub fn maintenance(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            interval.tick().await;
            let expired = {
                let mut sessions = state.sessions.write().await;
                let ids = sessions
                    .iter()
                    .filter(|(_, s)| s.expires <= now())
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                ids.into_iter()
                    .filter_map(|id| sessions.remove(&id))
                    .collect::<Vec<_>>()
            };
            for s in expired {
                tokio::spawn(revoke(s));
            }
        }
    })
}
