use crate::{
    config::Config,
    error::{AppError, Result},
};
use reqwest::{
    Client, Method,
    dns::{Name, Resolve, Resolving},
};
use serde_json::{Value, json};
use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use url::Url;

pub fn normalize(value: &str) -> Result<String> {
    let url = Url::parse(value.trim())
        .map_err(|_| AppError::new(400, "请输入有效的 Matrix 服务器完整地址"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(AppError::new(
            400,
            "服务器地址必须是 HTTP(S) origin，不能包含路径、凭据或查询参数",
        ));
    }
    Ok(url.origin().ascii_serialization())
}
fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && (b == 168 || b == 0 || (b == 88 && c == 99)))
        || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
        || (a == 203 && b == 0 && c == 113))
}
pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => public_v4(ip),
        IpAddr::V6(ip) => {
            // Only global unicast; exclude mapped/translated, Teredo, 6to4 and documentation ranges.
            let s = ip.segments();
            s[0] & 0xe000 == 0x2000
                && s[0] != 0x2002
                && !(s[0] == 0x2001 && (s[1] < 0x0200 || s[1] == 0xdb8))
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}
struct PublicDns;
impl Resolve for PublicDns {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(async move {
            let addresses: Vec<SocketAddr> =
                tokio::net::lookup_host((name.as_str(), 0)).await?.collect();
            if addresses.is_empty() || addresses.iter().any(|a| !public_ip(a.ip())) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "自定义服务器解析到非公网地址",
                )
                .into());
            }
            Ok(Box::new(addresses.into_iter()) as reqwest::dns::Addrs)
        })
    }
}
#[derive(Clone)]
pub struct Matrix {
    pub origin: String,
    client: Client,
    max_bytes: usize,
}
impl Matrix {
    pub fn new(config: &Config, origin: &str) -> Result<Self> {
        let (origin, trusted) = config.select_homeserver(Some(origin))?;
        let url = Url::parse(&origin).unwrap();
        if !trusted
            && let Some(host) = url.host_str()
            && let Ok(ip) = host.trim_matches(['[', ']']).parse::<IpAddr>()
            && !public_ip(ip)
        {
            return Err(AppError::new(
                403,
                "自定义服务器不能指向内网、回环或保留地址，请在配置文件中明确允许此地址",
            ));
        }
        let mut builder = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(config.limits.request_timeout_seconds))
            .connect_timeout(Duration::from_secs(10))
            .pool_max_idle_per_host(8)
            .user_agent("Tuwunel-Admin/1.1");
        if !trusted {
            builder = builder.dns_resolver(Arc::new(PublicDns));
        }
        let client = builder
            .build()
            .map_err(|_| AppError::new(500, "无法初始化 Matrix HTTP 客户端"))?;
        Ok(Self {
            origin,
            client,
            max_bytes: config.limits.max_response_bytes,
        })
    }
    pub async fn request(
        &self,
        token: &str,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value> {
        let mut request = self
            .client
            .request(method, format!("{}{}", self.origin, path))
            .header("Accept", "application/json");
        if !token.is_empty() {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let mut response = request.send().await.map_err(|_| {
            AppError::new(
                502,
                "无法连接 Matrix 服务器：请检查地址、TLS、网络，或自定义地址是否解析到被禁止的内网",
            )
        })?;
        let status = response.status();
        if status.is_redirection() {
            return Err(AppError::new(
                502,
                "服务器返回重定向，请直接填写最终 Matrix 地址",
            ));
        }
        if response
            .content_length()
            .is_some_and(|n| n > self.max_bytes as u64)
        {
            return Err(AppError::new(502, "上游响应过大，请缩小分页大小"));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| AppError::new(502, "读取 Matrix 响应失败或超时"))?
        {
            if bytes.len() + chunk.len() > self.max_bytes {
                return Err(AppError::new(502, "上游响应过大，请缩小分页大小"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let data: Value = if bytes.is_empty() {
            json!({})
        } else {
            serde_json::from_slice(&bytes)
                .map_err(|_| AppError::new(502, "上游没有返回 JSON，请检查反向代理配置"))?
        };
        if !status.is_success() {
            let code = data["errcode"].as_str().unwrap_or("M_UNKNOWN");
            let message = if status.as_u16() == 404 && code == "M_UNRECOGNIZED" {
                "当前 Tuwunel 版本或认证模式不支持此 API（M_UNRECOGNIZED）"
            } else {
                data["error"].as_str().unwrap_or("Matrix 服务器拒绝了请求")
            };
            return Err(AppError {
                status,
                code: code.into(),
                message: message.chars().take(500).collect(),
            });
        }
        Ok(data)
    }
    pub async fn verify(&self, token: &str) -> Result<String> {
        if token.is_empty() || token.len() > 8192 || token.contains(['\r', '\n']) {
            return Err(AppError::new(400, "访问令牌无效"));
        }
        let who = self
            .request(
                token,
                Method::GET,
                "/_matrix/client/v3/account/whoami",
                None,
            )
            .await?;
        let user = who["user_id"]
            .as_str()
            .filter(|v| v.starts_with('@') && v.contains(':'))
            .ok_or_else(|| AppError::new(502, "上游返回无效的用户 ID"))?;
        let path = format!("/_synapse/admin/v2/users/{}", crate::catalog::encode(user));
        let account = self.request(token, Method::GET, &path, None).await?;
        if account["admin"] != true && account["admin"] != 1 {
            return Err(AppError::new(403, "此账号不是服务器管理员"));
        }
        Ok(user.to_owned())
    }
}
