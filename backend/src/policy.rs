use crate::{
    app::AppState,
    error::{AppError, Result},
    matrix::Matrix,
    store::{self, now},
};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub enabled: bool,
    pub local_days: u64,
    pub remote_days: u64,
    pub interval_hours: u64,
    pub size_gt: u64,
    pub keep_profiles: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            local_days: 90,
            remote_days: 30,
            interval_hours: 24,
            size_gt: 0,
            keep_profiles: true,
        }
    }
}
impl Settings {
    pub fn validate(&self) -> Result<()> {
        let max_days = now() / 86400000 - 1;
        if self.local_days == 0
            || self.remote_days == 0
            || self.local_days > max_days
            || self.remote_days > max_days
            || !(1..=8760).contains(&self.interval_hours)
            || self.size_gt > 9_007_199_254_740_991
        {
            return Err(AppError::new(
                400,
                "策略参数超出范围：天数必须为正且截止时间晚于 1970 年，间隔为 1–8760 小时",
            ));
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    #[serde(flatten)]
    pub settings: Settings,
    pub credential: Option<String>,
    pub owner: Option<String>,
    pub homeserver: String,
    #[serde(default)]
    pub next_run: u64,
    #[serde(default)]
    pub last_run: Option<u64>,
    #[serde(default)]
    pub last_result: Option<Value>,
}
pub fn public(policy: Option<&Policy>, running: bool) -> Value {
    let mut value = policy
        .map(|p| serde_json::to_value(p).unwrap())
        .unwrap_or_else(|| serde_json::to_value(Settings::default()).unwrap());
    let object = value.as_object_mut().unwrap();
    let credential = object.remove("credential");
    object.insert(
        "hasCredential".into(),
        json!(credential.is_some_and(|v| v.as_str().is_some_and(|v| !v.is_empty()))),
    );
    object.insert("running".into(), json!(running));
    value
}
pub async fn run(state: AppState, origin: String, force: bool) -> Result<Value> {
    let mutex = state.policy_lock(&origin).await;
    let _guard = mutex
        .try_lock()
        .map_err(|_| AppError::new(409, "媒体清理正在执行或策略正在保存"))?;
    let key = origin.clone();
    let policy = store::access(&state.store, false, move |s| {
        Ok(s.data.policies.get(&key).cloned())
    })
    .await?;
    let Some(mut policy) = policy.filter(|p| p.settings.enabled) else {
        return if force {
            Err(AppError::new(400, "请先保存并启用策略"))
        } else {
            Ok(Value::Null)
        };
    };
    if !force && now() < policy.next_run {
        return Ok(Value::Null);
    }
    let started = now();
    let mut counts = json!({});
    let result: Result<()> = async {
        // Reapply current address policy for every run, including migrated jobs.
        let matrix = Matrix::new(&state.config, &origin)?;
        let credential = policy
            .credential
            .clone()
            .ok_or_else(|| AppError::new(400, "请重新保存策略凭据"))?;
        let token = store::access(&state.store, false, move |s| s.unseal(&credential)).await?;
        matrix.verify(&token).await?;
        let cutoff = started.saturating_sub(policy.settings.local_days * 86400000);
        let path = format!(
            "/_synapse/admin/v1/media/delete?before_ts={cutoff}&size_gt={}&keep_profiles={}",
            policy.settings.size_gt, policy.settings.keep_profiles
        );
        let local = matrix
            .request(&token, Method::POST, &path, Some(&json!({})))
            .await?;
        counts["deleteOldMedia"] = local.get("total").cloned().unwrap_or(json!(0));
        let cutoff = started.saturating_sub(policy.settings.remote_days * 86400000);
        let remote = matrix
            .request(
                &token,
                Method::POST,
                &format!("/_synapse/admin/v1/purge_media_cache?before_ts={cutoff}"),
                Some(&json!({})),
            )
            .await?;
        counts["purgeRemote"] = remote.get("deleted").cloned().unwrap_or(json!(0));
        Ok(())
    }
    .await;
    let ok = result.is_ok();
    policy.last_result = Some(match result {
        Ok(()) => json!({"ok":true,"counts":counts}),
        Err(e) => json!({"ok":false,"counts":counts,"error":e.message}),
    });
    policy.last_run = Some(started);
    policy.next_run = now() + policy.settings.interval_hours * 3600000;
    let response = public(Some(&policy), false);
    store::access(&state.store, true, move |s| {
        s.audit(
            &origin,
            policy.owner.as_deref().unwrap_or("scheduler"),
            "媒体生命周期清理",
            &origin,
            if ok { "success" } else { "failed" },
        );
        s.data.policies.insert(origin, policy);
        Ok(())
    })
    .await?;
    Ok(response)
}
pub fn start(state: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(
            state.config.scheduler.poll_seconds,
        ));
        loop {
            interval.tick().await;
            let due = store::access(&state.store, false, |s| {
                Ok(s.data
                    .policies
                    .iter()
                    .filter(|(_, p)| p.settings.enabled && now() >= p.next_run)
                    .map(|(k, _)| k.clone())
                    .collect::<Vec<_>>())
            })
            .await;
            if let Ok(due) = due {
                // Bounded, independent per-origin work. A slow homeserver cannot
                // prevent other servers' jobs or foreground requests from running.
                let mut jobs = tokio::task::JoinSet::new();
                for origin in due {
                    if jobs.len() >= 4 {
                        let _ = jobs.join_next().await;
                    }
                    let state = state.clone();
                    jobs.spawn(async move {
                        let _ = run(state, origin, false).await;
                    });
                }
                while jobs.join_next().await.is_some() {}
            }
        }
    })
}
