use crate::{
    error::{AppError, Result},
    matrix::normalize,
};
use serde::Deserialize;
use std::{
    net::SocketAddr,
    path::{Path, PathBuf},
};

#[derive(Clone, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub server: Server,
    pub matrix: MatrixConfig,
    pub storage: Storage,
    pub limits: Limits,
    pub scheduler: Scheduler,
    pub auth: AuthConfig,
    pub bridges: crate::bridges::BridgeConfig,
}
#[derive(Clone, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct AuthConfig {
    pub allowed_origins: Vec<String>,
    pub clients: Vec<AuthClient>,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthClient {
    pub issuer: String,
    pub client_id: String,
}
#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Server {
    pub listen: SocketAddr,
    pub public_url: String,
    pub cookie_secure: bool,
    pub static_dir: PathBuf,
}
impl Default for Server {
    fn default() -> Self {
        Self {
            listen: "0.0.0.0:8080".parse().unwrap(),
            public_url: "http://localhost:8080".into(),
            cookie_secure: false,
            static_dir: "dist".into(),
        }
    }
}
#[derive(Clone, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct MatrixConfig {
    pub locked: bool,
    pub homeserver: String,
    pub allowed_homeservers: Vec<String>,
}
#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Storage {
    pub data_dir: PathBuf,
    pub encryption_key_file: PathBuf,
}
impl Default for Storage {
    fn default() -> Self {
        Self {
            data_dir: "data".into(),
            encryption_key_file: PathBuf::new(),
        }
    }
}
#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Limits {
    pub session_hours: u64,
    pub login_attempts: usize,
    pub login_window_seconds: u64,
    pub max_sessions: usize,
    pub request_timeout_seconds: u64,
    pub max_response_bytes: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            session_hours: 12,
            login_attempts: 10,
            login_window_seconds: 600,
            max_sessions: 1024,
            request_timeout_seconds: 30,
            max_response_bytes: 8 * 1024 * 1024,
        }
    }
}
#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Scheduler {
    pub enabled: bool,
    pub poll_seconds: u64,
}
impl Default for Scheduler {
    fn default() -> Self {
        Self {
            enabled: true,
            poll_seconds: 60,
        }
    }
}
impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path).map_err(|_| {
            AppError::new(
                500,
                "无法读取配置文件；请复制 config.example.toml 为 config.toml，或指定 --config 路径",
            )
        })?;
        // TOML parser errors may include the offending line (possibly a secret).
        let mut config: Self = toml::from_str(&text).map_err(|_| {
            AppError::new(
                500,
                "配置文件格式或字段无效，请检查 TOML 配置与示例是否一致",
            )
        })?;
        let parent = path.parent().unwrap_or(Path::new("."));
        for p in [
            &mut config.server.static_dir,
            &mut config.storage.data_dir,
            &mut config.storage.encryption_key_file,
        ] {
            if !p.as_os_str().is_empty() && p.is_relative() {
                *p = parent.join(&*p);
            }
        }
        config.validate()?;
        Ok(config)
    }
    pub fn validate(&mut self) -> Result<()> {
        self.bridges.validate()?;
        self.server.public_url = normalize(&self.server.public_url)?;
        if self.server.public_url.starts_with("https:") && !self.server.cookie_secure {
            return Err(AppError::new(
                500,
                "HTTPS public_url 必须启用 cookie_secure",
            ));
        }
        if !self.matrix.homeserver.is_empty() {
            self.matrix.homeserver = normalize(&self.matrix.homeserver)?;
        }
        if self.matrix.locked && self.matrix.homeserver.is_empty() {
            return Err(AppError::new(
                500,
                "locked=true 时必须设置 matrix.homeserver",
            ));
        }
        for server in &mut self.matrix.allowed_homeservers {
            *server = normalize(server)?;
        }
        for origin in &mut self.auth.allowed_origins {
            *origin = normalize(origin)?;
        }
        for client in &self.auth.clients {
            let url = url::Url::parse(&client.issuer)
                .map_err(|_| AppError::new(500, "auth.clients 的 issuer 无效"))?;
            if !matches!(url.scheme(), "http" | "https")
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
                || client.client_id.is_empty()
                || client.client_id.len() > 1024
            {
                return Err(AppError::new(500, "auth.clients 配置无效"));
            }
        }
        if !(1..=168).contains(&self.limits.session_hours)
            || !(1..=10000).contains(&self.limits.login_attempts)
            || !(1..=86400).contains(&self.limits.login_window_seconds)
            || !(1..=100000).contains(&self.limits.max_sessions)
            || !(1..=300).contains(&self.limits.request_timeout_seconds)
            || !(1024..=64 * 1024 * 1024).contains(&self.limits.max_response_bytes)
            || !(1..=3600).contains(&self.scheduler.poll_seconds)
        {
            return Err(AppError::new(500, "limits / scheduler 配置超出允许范围"));
        }
        Ok(())
    }
    pub fn select_homeserver(&self, input: Option<&str>) -> Result<(String, bool)> {
        let candidate = input
            .filter(|v| !v.trim().is_empty())
            .unwrap_or(&self.matrix.homeserver);
        let origin = normalize(candidate)?;
        if self.matrix.locked && origin != self.matrix.homeserver {
            return Err(AppError::new(403, "服务器地址已锁定，不能使用其他地址登录"));
        }
        let trusted =
            origin == self.matrix.homeserver || self.matrix.allowed_homeservers.contains(&origin);
        if !self.matrix.allowed_homeservers.is_empty() && !trusted {
            return Err(AppError::new(403, "该服务器不在允许登录的地址列表中"));
        }
        if !trusted && !origin.starts_with("https://") {
            return Err(AppError::new(
                400,
                "自定义服务器必须使用 HTTPS；内网 HTTP 地址须先写入配置文件",
            ));
        }
        Ok((origin, trusted))
    }
}
