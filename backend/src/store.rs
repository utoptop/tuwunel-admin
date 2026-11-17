use crate::{
    config::Config,
    error::{AppError, Result},
    policy::Policy,
};
use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

pub fn now() -> u64 {
    chrono::Utc::now().timestamp_millis().max(0) as u64
}
pub fn random_hex(size: usize) -> String {
    let mut bytes = vec![0u8; size];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Data {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub policies: BTreeMap<String, Policy>,
    #[serde(default)]
    pub oauth_clients: BTreeMap<String, String>,
    pub audit: Vec<Value>,
}
pub struct Store {
    pub data: Data,
    path: PathBuf,
    key: [u8; 32],
    _lock: File,
}
pub type SharedStore = Arc<Mutex<Store>>;

fn private_file(path: &Path, exclusive: bool) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true);
    if exclusive {
        options.create_new(true);
    } else {
        options.create(true).truncate(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}
impl Store {
    pub fn open(config: &Config) -> Result<Self> {
        let dir = &config.storage.data_dir;
        fs::create_dir_all(dir).map_err(AppError::internal)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(dir.join("state.lock"))
            .map_err(AppError::internal)?;
        fs2::FileExt::try_lock_exclusive(&lock)
            .map_err(|_| AppError::new(500, "此数据目录已有另一个管理实例使用"))?;
        let key_path = if config.storage.encryption_key_file.as_os_str().is_empty() {
            dir.join("encryption.key")
        } else {
            config.storage.encryption_key_file.clone()
        };
        if !key_path.exists() {
            if !config.storage.encryption_key_file.as_os_str().is_empty() {
                return Err(AppError::new(500, "指定的加密密钥文件不存在"));
            }
            let mut key = [0u8; 32];
            OsRng.fill_bytes(&mut key);
            let mut file = private_file(&key_path, true).map_err(AppError::internal)?;
            file.write_all(&key).map_err(AppError::internal)?;
            file.sync_all().map_err(AppError::internal)?;
        }
        let key: [u8; 32] = fs::read(&key_path)
            .map_err(AppError::internal)?
            .try_into()
            .map_err(|_| AppError::new(500, "加密密钥文件必须包含 32 字节原始数据"))?;
        let path = dir.join("state.json");
        let mut migration = false;
        let data = if path.exists() {
            let bytes = fs::read(&path).map_err(AppError::internal)?;
            let mut value: Value = serde_json::from_slice(&bytes)
                .map_err(|_| AppError::new(500, "数据文件损坏，拒绝覆盖"))?;
            if value.get("schemaVersion").is_none() {
                let legacy = value.get("policy").filter(|p| !p.is_null()).cloned();
                let origin = legacy
                    .as_ref()
                    .and_then(|p| p["homeserver"].as_str())
                    .filter(|s| !s.is_empty())
                    .unwrap_or(&config.matrix.homeserver)
                    .to_owned();
                let audit = value["audit"]
                    .as_array_mut()
                    .ok_or_else(|| AppError::new(500, "旧数据文件格式无效"))?;
                if origin.is_empty() && !audit.is_empty() {
                    return Err(AppError::new(
                        500,
                        "迁移旧版审计前，请将 matrix.homeserver 设置为原服务器地址",
                    ));
                }
                for row in audit.iter_mut() {
                    row["homeserver"] = Value::String(origin.clone());
                }
                let audit = audit.clone();
                let mut policies = BTreeMap::new();
                if let Some(p) = legacy {
                    let mut p: Policy = serde_json::from_value(p)
                        .map_err(|_| AppError::new(500, "旧媒体策略格式无效"))?;
                    p.homeserver = crate::matrix::normalize(&p.homeserver)?;
                    policies.insert(p.homeserver.clone(), p);
                }
                let backup = dir.join("state.v1.backup.json");
                if !backup.exists() {
                    let mut file = private_file(&backup, true).map_err(AppError::internal)?;
                    file.write_all(&bytes).map_err(AppError::internal)?;
                    file.sync_all().map_err(AppError::internal)?;
                }
                migration = true;
                Data {
                    schema_version: 2,
                    policies,
                    audit,
                    ..Data::default()
                }
            } else {
                let data: Data = serde_json::from_value(value)
                    .map_err(|_| AppError::new(500, "数据文件格式无效"))?;
                if data.schema_version != 2 {
                    return Err(AppError::new(500, "不支持的数据文件版本"));
                }
                data
            }
        } else {
            Data {
                schema_version: 2,
                ..Data::default()
            }
        };
        let store = Self {
            data,
            path,
            key,
            _lock: lock,
        };
        if migration {
            store.save()?;
        }
        Ok(store)
    }
    pub fn save(&self) -> Result<()> {
        let temporary = self.path.with_extension("json.tmp");
        let mut file = private_file(&temporary, false).map_err(AppError::internal)?;
        serde_json::to_writer(&mut file, &self.data).map_err(AppError::internal)?;
        file.sync_all().map_err(AppError::internal)?;
        fs::rename(&temporary, &self.path).map_err(AppError::internal)?;
        Ok(())
    }
    pub fn seal(&self, value: &str) -> Result<String> {
        let mut iv = [0u8; 12];
        OsRng.fill_bytes(&mut iv);
        let cipher = Aes256Gcm::new_from_slice(&self.key).unwrap();
        let bytes = cipher
            .encrypt(Nonce::from_slice(&iv), value.as_bytes())
            .map_err(|_| AppError::new(500, "无法加密计划凭据"))?;
        let split = bytes.len() - 16;
        let mut out = iv.to_vec();
        out.extend_from_slice(&bytes[split..]);
        out.extend_from_slice(&bytes[..split]);
        Ok(STANDARD.encode(out))
    }
    pub fn unseal(&self, value: &str) -> Result<String> {
        let bytes = STANDARD
            .decode(value)
            .map_err(|_| AppError::new(500, "计划凭据格式无效，请重新保存"))?;
        if bytes.len() < 28 {
            return Err(AppError::new(500, "计划凭据格式无效"));
        }
        let cipher = Aes256Gcm::new_from_slice(&self.key).unwrap();
        let mut data = bytes[28..].to_vec();
        data.extend_from_slice(&bytes[12..28]);
        let plain = cipher
            .decrypt(Nonce::from_slice(&bytes[..12]), data.as_ref())
            .map_err(|_| AppError::new(500, "计划凭据无法解密，请重新保存"))?;
        String::from_utf8(plain).map_err(|_| AppError::new(500, "无效的计划凭据"))
    }
    pub fn audit(&mut self, origin: &str, actor: &str, action: &str, target: &str, status: &str) {
        self.data.audit.insert(0,json!({"id":random_hex(8),"at":chrono::Utc::now().to_rfc3339(),"homeserver":origin,"actor":actor,"action":action,"target":target,"status":status}));
        self.data.audit.truncate(2000);
    }
}
// Disk writes and encryption never block a Tokio async worker. Roll back memory
// when an atomic write fails, so the live scheduler cannot run an unsaved policy.
pub async fn access<T: Send + 'static>(
    store: &SharedStore,
    write: bool,
    f: impl FnOnce(&mut Store) -> Result<T> + Send + 'static,
) -> Result<T> {
    let store = store.clone();
    tokio::task::spawn_blocking(move || {
        let mut store = store
            .lock()
            .map_err(|_| AppError::new(500, "存储锁不可用"))?;
        let old = write.then(|| store.data.clone());
        let result = f(&mut store);
        if let Err(error) = &result {
            if let Some(old) = old {
                store.data = old;
            }
            return Err(AppError {
                status: error.status,
                message: error.message.clone(),
                code: error.code.clone(),
            });
        }
        if write && let Err(error) = store.save() {
            if let Some(old) = old {
                store.data = old;
            }
            return Err(error);
        }
        result
    })
    .await
    .map_err(|_| AppError::new(500, "存储任务失败"))?
}
