//! Read-only Linux observer and explicitly scoped server snapshots.
use crate::{
    app::{AppState, auth},
    error::{AppError, Result},
    store::now,
};
use axum::{Json, extract::State, http::HeaderMap};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

#[derive(Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Sources {
    pub sources: Vec<Source>,
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Source {
    pub homeserver: String,
    pub snapshot_file: PathBuf,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Metrics {
    pub at: u64,
    pub pid: u32,
    pub rss_bytes: Option<u64>,
    pub threads: Option<u64>,
    pub cpu_percent: Option<f64>,
    pub read_bytes_per_second: Option<f64>,
    pub write_bytes_per_second: Option<f64>,
    pub received_bytes_per_second: Option<f64>,
    pub sent_bytes_per_second: Option<f64>,
    pub tcp_connections: Option<u64>,
    #[serde(default)]
    pub uptime_seconds: Option<u64>,
    #[serde(default)]
    pub open_fds: Option<u64>,
    #[serde(default)]
    pub max_fds: Option<u64>,
    #[serde(default)]
    pub disk_available_bytes: Option<u64>,
    #[serde(default)]
    pub disk_total_bytes: Option<u64>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct IpCount {
    pub ip: String,
    pub success: u64,
    pub refused: u64,
    pub challenges: u64,
    pub limited: u64,
    pub server_errors: u64,
    pub last_seen: u64,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Creation {
    pub user_id: String,
    pub ip: String,
    pub at: u64,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Registrations {
    pub available: bool,
    pub truncated: bool,
    pub since: Option<u64>,
    pub invalid_lines: u64,
    pub ips: Vec<IpCount>,
    pub accounts: Vec<Creation>,
}
#[derive(Serialize, Deserialize)]
pub struct Snapshot {
    pub schema: u8,
    pub homeserver: String,
    pub server_name: String,
    pub generated_at: u64,
    pub metrics: Option<Metrics>,
    pub history: Vec<Metrics>,
    pub configuration: BTreeMap<String, Value>,
    pub registrations: Registrations,
    pub diagnostics: Vec<String>,
}
const SAFE_KEYS: &[&str] = &[
    "server_name",
    "address",
    "port",
    "allow_registration",
    "allow_federation",
    "allow_guest_registration",
    "max_request_size",
    "max_concurrent_requests",
    "tokio_workers",
    "tokio_blocking_threads",
    "db_pool_workers",
    "db_pool_workers_limit",
    "stream_width_default",
    "stream_width_scale",
    "stream_amplification",
    "rocksdb_parallelism_threads",
    "db_cache_capacity_mb",
    "registration.enable",
    "registration.guests.allow",
    "federation.enable",
    "http.max_request_size",
    "runtime.stream.width_default",
    "runtime.stream.width_scale",
    "runtime.stream.amplification",
    "database.pool.workers",
    "database.pool.workers_limit",
    "rocksdb.parallelism_threads",
    "rocksdb.cache_capacity_mb",
    "server.listen.address",
    "server.listen.port",
    "listening.address",
    "listening.port",
    "registration.allow",
    "federation.allow",
    "media.max_upload_size",
    "database.backend",
    "database.cache_capacity_mb",
    "authentication.oidc.enable",
    "authentication.oidc.native_auth",
    "authentication.oidc.browser_session_ttl",
    "authentication.oidc.require_pkce",
    "authentication.oidc.require_client_approval",
    "authentication.oidc.require_device_scope",
    "authentication.oidc.strict_scope",
    "authentication.oidc.registration_allowed_redirect_hosts",
    "authentication.oidc.issuer_url",
    "authentication.login.with_password",
    "authentication.login.via_token",
    "authentication.login.single_sso",
    "authentication.login.oidc_aware_preferred",
    "authentication.login.via_existing_session",
    "authentication.access_token_ttl",
    "authentication.refresh_token.ttl",
    "authentication.refresh_token.idle_only",
    "oidc_native_auth",
    "oidc_browser_session_ttl",
    "oidc_require_pkce",
    "oidc_require_client_approval",
    "oidc_registration_allowed_redirect_hosts",
    "login_with_password",
    "login_via_token",
    "login_via_existing_session",
    "cache.capacity_modifier",
    "database.pool.affinity",
    "http.compression.zstd",
    "media.storage_providers",
    "media.store_on_providers",
    "well_known.client",
    "well_known.server",
    "well_known.livekit_url",
];
fn allowed(key: &str, value: &Value) -> bool {
    SAFE_KEYS.contains(&key)
        && match value {
            Value::String(v) => v.len() < 256,
            Value::Number(_) | Value::Bool(_) => true,
            Value::Array(v) => {
                v.len() <= 32
                    && v.iter()
                        .all(|s| s.as_str().is_some_and(|s| s.len() < 256) || s.is_number())
            }
            _ => false,
        }
}
pub fn safe_configuration(text: &str) -> std::result::Result<BTreeMap<String, Value>, String> {
    let parsed: toml::Value =
        toml::from_str(text).map_err(|_| "Tuwunel 配置文件格式无法解析".to_owned())?;
    let value = serde_json::to_value(parsed).map_err(|_| "配置读取失败".to_owned())?;
    let root = value.get("global").unwrap_or(&value);
    let mut out = BTreeMap::new();
    for key in SAFE_KEYS {
        let mut v = Some(root);
        for part in key.split('.') {
            v = v.and_then(|v| v.get(part));
        }
        if let Some(v) = v {
            if allowed(key, v) {
                out.insert((*key).into(), v.clone());
            }
        }
    }
    Ok(out)
}
fn read_bounded(path: &Path, limit: u64) -> std::io::Result<Vec<u8>> {
    let mut data = Vec::new();
    File::open(path)?.take(limit + 1).read_to_end(&mut data)?;
    if data.len() as u64 > limit {
        return Err(std::io::Error::other("file too large"));
    }
    Ok(data)
}
pub async fn read(State(state): State<AppState>, headers: HeaderMap) -> Result<Json<Value>> {
    let (_, s) = auth(&state, &headers, false).await?;
    let Some(source) = state
        .config
        .observability
        .sources
        .iter()
        .find(|c| c.homeserver == s.matrix.origin)
    else {
        return Ok(Json(
            json!({"available":false,"message":"此服务器尚未接入只读采集器。Tuwunel HTTP API 不提供进程指标、完整配置或注册 IP 历史。"}),
        ));
    };
    let path = source.snapshot_file.clone();
    let result = tokio::task::spawn_blocking(move || read_bounded(&path, 8 * 1024 * 1024))
        .await
        .map_err(AppError::internal)?;
    let Ok(data) = result else {
        return Ok(Json(
            json!({"available":false,"message":"无法读取采集快照，请检查采集器、共享目录及读取权限。"}),
        ));
    };
    let mut snapshot: Snapshot =
        serde_json::from_slice(&data).map_err(|_| AppError::new(502, "采集快照格式无效"))?;
    if snapshot.schema != 1
        || snapshot.homeserver != s.matrix.origin
        || Some(snapshot.server_name.as_str()) != s.user_id.split_once(':').map(|v| v.1)
    {
        return Err(AppError::new(502, "采集快照的服务器身份与当前登录不一致"));
    }
    snapshot.configuration.retain(|k, v| allowed(k, v));
    snapshot.history.truncate(240);
    snapshot.registrations.ips.truncate(2000);
    snapshot.registrations.accounts.truncate(10000);
    let age = now().saturating_sub(snapshot.generated_at);
    Ok(Json(
        json!({"available":true,"stale":age>30000||snapshot.generated_at>now()+10000,"ageSeconds":age/1000,"snapshot":snapshot}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ObserverConfig {
    pub homeserver: String,
    pub server_name: String,
    pub output_file: PathBuf,
    #[serde(default = "default_proc")]
    pub proc_root: PathBuf,
    #[serde(default = "default_pid")]
    pub pid: u32,
    #[serde(default = "default_name")]
    pub process_name: String,
    #[serde(default)]
    pub tuwunel_config: Option<PathBuf>,
    #[serde(default)]
    pub registration_log: Option<PathBuf>,
    #[serde(default = "default_interval")]
    pub interval_seconds: u64,
}
fn default_proc() -> PathBuf {
    "/proc".into()
}
fn default_pid() -> u32 {
    1
}
fn default_name() -> String {
    "tuwunel".into()
}
fn default_interval() -> u64 {
    5
}
#[derive(Default, Clone)]
pub struct Counters {
    at: u64,
    start: u64,
    ticks: u64,
    read: Option<u64>,
    write: Option<u64>,
    rx: Option<u64>,
    tx: Option<u64>,
}
fn fields(text: &str) -> BTreeMap<&str, u64> {
    text.lines()
        .filter_map(|l| {
            let (k, v) = l.split_once(':')?;
            Some((k, v.split_whitespace().next()?.parse().ok()?))
        })
        .collect()
}
fn rate(new: Option<u64>, old: Option<u64>, elapsed: f64) -> Option<f64> {
    Some(new?.checked_sub(old?)? as f64 / elapsed)
}
pub fn sample(
    config: &ObserverConfig,
    previous: Option<&Counters>,
    ticks_per_second: f64,
) -> std::result::Result<(Metrics, Counters, Vec<String>), String> {
    let path = config.proc_root.join(config.pid.to_string());
    let comm = std::fs::read_to_string(path.join("comm"))
        .map_err(|_| "无法读取目标进程；检查 PID 与共享进程命名空间".to_owned())?;
    if comm.trim() != config.process_name {
        return Err("目标 PID 的进程名称与配置不一致，未采集其他进程".into());
    }
    let status =
        std::fs::read_to_string(path.join("status")).map_err(|_| "进程状态不可读".to_owned())?;
    let status = fields(&status);
    let stat =
        std::fs::read_to_string(path.join("stat")).map_err(|_| "进程 CPU 状态不可读".to_owned())?;
    let stat = stat
        .rsplit_once(") ")
        .ok_or("进程 stat 格式无效")?
        .1
        .split_whitespace()
        .collect::<Vec<_>>();
    let number = |i: usize| {
        stat.get(i)
            .and_then(|v| v.parse::<u64>().ok())
            .ok_or("进程计数器格式无效")
    };
    let mut c = Counters {
        at: now(),
        start: number(19)?,
        ticks: number(11)? + number(12)?,
        ..Default::default()
    };
    let mut diagnostics = Vec::new();
    if let Ok(io) = std::fs::read_to_string(path.join("io")) {
        let io = fields(&io);
        c.read = io.get("read_bytes").copied();
        c.write = io.get("write_bytes").copied();
    } else {
        diagnostics.push("磁盘 I/O 不可读：采集进程需具有读取目标 /proc/PID/io 的权限".into());
    }
    if let Ok(net) = std::fs::read_to_string(path.join("net/dev")) {
        let mut rx = 0;
        let mut tx = 0;
        for l in net.lines() {
            if let Some((name, values)) = l.split_once(':') {
                if name.trim() == "lo" {
                    continue;
                }
                let v = values.split_whitespace().collect::<Vec<_>>();
                if let (Some(r), Some(t)) = (
                    v.first().and_then(|v| v.parse::<u64>().ok()),
                    v.get(8).and_then(|v| v.parse::<u64>().ok()),
                ) {
                    rx += r;
                    tx += t;
                }
            }
        }
        c.rx = Some(rx);
        c.tx = Some(tx);
    } else {
        diagnostics.push("目标网络命名空间统计不可读".into());
    }
    let tcp = ["net/tcp", "net/tcp6"]
        .iter()
        .map(|p| {
            std::fs::read_to_string(path.join(p)).ok().map(|v| {
                v.lines()
                    .skip(1)
                    .filter(|l| l.split_whitespace().nth(3) == Some("01"))
                    .count() as u64
            })
        })
        .collect::<Vec<_>>();
    let uptime_seconds = std::fs::read_to_string(config.proc_root.join("uptime"))
        .ok()
        .and_then(|s| s.split_whitespace().next()?.parse::<f64>().ok())
        .filter(|_| ticks_per_second > 0.)
        .map(|up| (up - (c.start as f64 / ticks_per_second)).max(0.) as u64);
    let open_fds = std::fs::read_dir(path.join("fd"))
        .ok()
        .map(|entries| entries.count() as u64);
    let max_fds = std::fs::read_to_string(path.join("limits"))
        .ok()
        .and_then(|text| {
            text.lines().find_map(|l| {
                l.strip_prefix("Max open files")?
                    .split_whitespace()
                    .next()?
                    .parse::<u64>()
                    .ok()
            })
        });
    let disk_dir = config
        .output_file
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut m = Metrics {
        at: c.at,
        pid: config.pid,
        rss_bytes: status.get("VmRSS").map(|v| v * 1024),
        threads: status.get("Threads").copied(),
        tcp_connections: if tcp.iter().all(Option::is_some) {
            Some(tcp.iter().flatten().sum())
        } else {
            None
        },
        uptime_seconds,
        open_fds,
        max_fds,
        disk_available_bytes: fs2::available_space(disk_dir).ok(),
        disk_total_bytes: fs2::total_space(disk_dir).ok(),
        ..Default::default()
    };
    if let Some(p) = previous.filter(|p| p.start == c.start && p.at < c.at) {
        let seconds = (c.at - p.at) as f64 / 1000.;
        m.cpu_percent =
            rate(Some(c.ticks), Some(p.ticks), seconds).map(|v| v / ticks_per_second * 100.);
        m.read_bytes_per_second = rate(c.read, p.read, seconds);
        m.write_bytes_per_second = rate(c.write, p.write, seconds);
        m.received_bytes_per_second = rate(c.rx, p.rx, seconds);
        m.sent_bytes_per_second = rate(c.tx, p.tx, seconds);
    }
    Ok((m, c, diagnostics))
}
pub fn registration_events(
    text: &str,
    server_name: &str,
    at: u64,
    truncated: bool,
) -> Registrations {
    let mut ips: BTreeMap<String, IpCount> = BTreeMap::new();
    let mut accounts: BTreeMap<String, Creation> = BTreeMap::new();
    let mut out = Registrations {
        available: true,
        truncated,
        ..Default::default()
    };
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            out.invalid_lines += 1;
            continue;
        };
        if v["method"] != "POST"
            || !matches!(
                v["path"].as_str(),
                Some("/_matrix/client/v3/register" | "/_matrix/client/r0/register")
            )
        {
            continue;
        }
        let Some(ip) = v["ip"]
            .as_str()
            .and_then(|s| s.parse::<std::net::IpAddr>().ok())
            .map(|v| v.to_string())
        else {
            out.invalid_lines += 1;
            continue;
        };
        let time = v["time"]
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|v| v.timestamp_millis().max(0) as u64);
        let Some(time) = time.filter(|t| *t <= at + 10000) else {
            out.invalid_lines += 1;
            continue;
        };
        out.since = Some(out.since.map_or(time, |old| old.min(time)));
        let status = v["status"]
            .as_u64()
            .or_else(|| v["status"].as_str().and_then(|s| s.parse().ok()))
            .unwrap_or(0);
        if matches!(status, 200 | 201) {
            if let Some(id) = v["user_id"].as_str().filter(|id| {
                crate::workspace::validate_id(id).is_ok()
                    && id.split_once(':').map(|v| v.1) == Some(server_name)
            }) {
                let row = Creation {
                    user_id: id.into(),
                    ip: ip.clone(),
                    at: time,
                };
                if accounts.get(id).is_none_or(|old| old.at > time) {
                    accounts.insert(id.into(), row);
                }
            }
        }
        if at.saturating_sub(time) > 86400 * 1000 {
            continue;
        }
        let row = ips.entry(ip.clone()).or_insert_with(|| IpCount {
            ip,
            ..Default::default()
        });
        row.last_seen = row.last_seen.max(time);
        match status {
            200 | 201 => row.success += 1,
            401 => row.challenges += 1,
            429 => row.limited += 1,
            400..=499 => row.refused += 1,
            500..=599 => row.server_errors += 1,
            _ => {}
        }
    }
    out.ips = ips.into_values().collect();
    out.ips
        .sort_by_key(|r| std::cmp::Reverse((r.refused + r.limited, r.last_seen)));
    if out.ips.len() > 2000 {
        out.truncated = true;
        out.ips.truncate(2000);
    }
    out.accounts = accounts.into_values().collect();
    out.accounts.sort_by_key(|r| std::cmp::Reverse(r.at));
    if out.accounts.len() > 10000 {
        out.truncated = true;
        out.accounts.truncate(10000);
    }
    out
}
pub fn read_registrations(path: &Path, server: &str) -> std::result::Result<Registrations, String> {
    let mut file = File::open(path).map_err(|_| "注册审计日志不可读".to_owned())?;
    let size = file.metadata().map_err(|_| "无法读取日志信息")?.len();
    let limit = 8 * 1024 * 1024;
    let truncated = size > limit;
    if truncated {
        file.seek(SeekFrom::Start(size - limit))
            .map_err(|_| "无法读取日志尾部")?;
    }
    let mut bytes = Vec::new();
    file.take(limit)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取注册审计日志")?;
    let text = String::from_utf8_lossy(&bytes);
    let text = if truncated {
        text.split_once('\n').map_or("", |v| v.1)
    } else {
        &text
    };
    Ok(registration_events(text, server, now(), truncated))
}
pub fn collect(
    config: &ObserverConfig,
    previous: Option<&Counters>,
    history: &mut Vec<Metrics>,
    ticks: f64,
) -> (Snapshot, Option<Counters>) {
    let mut s = Snapshot {
        schema: 1,
        homeserver: config.homeserver.clone(),
        server_name: config.server_name.clone(),
        generated_at: now(),
        metrics: None,
        history: Vec::new(),
        configuration: BTreeMap::new(),
        registrations: Registrations::default(),
        diagnostics: Vec::new(),
    };
    let counters = match sample(config, previous, ticks) {
        Ok((m, c, diag)) => {
            history.push(m.clone());
            if history.len() > 120 {
                history.remove(0);
            }
            s.metrics = Some(m);
            s.diagnostics.extend(diag);
            Some(c)
        }
        Err(e) => {
            s.diagnostics.push(e);
            history.clear();
            None
        }
    };
    s.history = history.clone();
    if let Some(p) = &config.tuwunel_config {
        match read_bounded(p, 2 * 1024 * 1024)
            .map_err(|_| "配置文件无法读取".to_owned())
            .and_then(|b| safe_configuration(&String::from_utf8_lossy(&b)))
        {
            Ok(v) => s.configuration = v,
            Err(e) => s.diagnostics.push(e),
        }
    }
    if let Some(p) = &config.registration_log {
        match read_registrations(p, &config.server_name) {
            Ok(v) => s.registrations = v,
            Err(e) => s.diagnostics.push(e),
        }
    }
    (s, counters)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn secrets_never_leave_the_collector() {
        let result=safe_configuration("[global]\nserver_name='test'\nregistration_token='secret'\npassword='secret'\n[global.runtime.stream]\nwidth_default=32\n[global.authentication]\nregistration_access_token='secret'\n").unwrap();
        assert_eq!(result["runtime.stream.width_default"], 32);
        assert_eq!(result.len(), 2);
        assert!(!serde_json::to_string(&result).unwrap().contains("secret"));
    }
    #[test]
    fn registration_challenges_are_not_failures_and_only_confirmed_ids_are_mapped() {
        let at = chrono::DateTime::parse_from_rfc3339("2026-11-17T12:00:00Z")
            .unwrap()
            .timestamp_millis() as u64;
        let mut events = Vec::new();
        for status in [401, 401, 403, 429, 500, 200] {
            events.push(json!({"time":"2026-11-17T11:59:00Z","ip":"192.0.2.1","method":"POST","path":"/_matrix/client/v3/register","status":status,"user_id":"@alice:test","password":"never-export"}).to_string());
        }
        events.push(json!({"time":"2026-11-17T11:59:00Z","ip":"192.0.2.2","method":"POST","path":"/_matrix/client/v3/login","status":200,"user_id":"@wrong:test"}).to_string());
        let result = registration_events(&events.join("\n"), "test", at, false);
        assert_eq!(result.ips.len(), 1);
        let ip = &result.ips[0];
        assert_eq!(
            (
                ip.success,
                ip.refused,
                ip.challenges,
                ip.limited,
                ip.server_errors
            ),
            (1, 1, 2, 1, 1)
        );
        assert_eq!(result.accounts.len(), 1);
        assert_eq!(result.accounts[0].ip, "192.0.2.1");
        assert!(
            !serde_json::to_string(&result)
                .unwrap()
                .contains("never-export")
        );
        let denied = registration_events(&events[..5].join("\n"), "test", at, false);
        assert!(denied.accounts.is_empty());
    }
    #[test]
    fn proc_sample_checks_identity_and_computes_rates_only_across_same_process() {
        let dir = tempfile::tempdir().unwrap();
        let proc = dir.path().join("123");
        std::fs::create_dir_all(proc.join("net")).unwrap();
        std::fs::write(proc.join("comm"), "tuwunel\n").unwrap();
        std::fs::write(proc.join("status"), "VmRSS:\t2048 kB\nThreads:\t8\n").unwrap();
        let mut stat = vec!["0"; 20];
        stat[0] = "S";
        stat[11] = "200";
        stat[12] = "100";
        stat[19] = "99";
        std::fs::write(
            proc.join("stat"),
            format!("123 (tuwunel) {}", stat.join(" ")),
        )
        .unwrap();
        std::fs::write(proc.join("io"), "read_bytes: 5000\nwrite_bytes: 1000\n").unwrap();
        std::fs::write(
            proc.join("net/dev"),
            "eth0: 2000 0 0 0 0 0 0 0 8000 0 0 0 0 0 0 0\nlo: 99999 0 0 0 0 0 0 0 99999\n",
        )
        .unwrap();
        std::fs::write(proc.join("net/tcp"), "header\n 0: a b 01\n 1: a b 0A\n").unwrap();
        std::fs::write(proc.join("net/tcp6"), "header\n").unwrap();
        let config = ObserverConfig {
            homeserver: "https://test".into(),
            server_name: "test".into(),
            pid: 123,
            proc_root: dir.path().into(),
            process_name: "tuwunel".into(),
            output_file: dir.path().join("out.json"),
            interval_seconds: 5,
            tuwunel_config: None,
            registration_log: None,
        };
        let (m, c, _) = sample(&config, None, 100.).unwrap();
        assert_eq!(m.rss_bytes, Some(2097152));
        assert_eq!(m.threads, Some(8));
        assert_eq!(m.tcp_connections, Some(1));
        assert_eq!(m.cpu_percent, None);
        assert_eq!(c.rx, Some(2000));
        let previous = Counters {
            at: now() - 1000,
            start: 99,
            ticks: 200,
            read: Some(4000),
            write: Some(900),
            rx: Some(1000),
            tx: Some(7000),
        };
        let (m, _, _) = sample(&config, Some(&previous), 100.).unwrap();
        assert!((m.cpu_percent.unwrap() - 100.).abs() < 3.);
        assert!(m.received_bytes_per_second.unwrap() > 950.);
        let previous = Counters {
            start: 98,
            ..previous
        };
        assert_eq!(
            sample(&config, Some(&previous), 100.)
                .unwrap()
                .0
                .cpu_percent,
            None
        );
        std::fs::write(proc.join("comm"), "another-process").unwrap();
        assert!(sample(&config, None, 100.).is_err());
    }
}
