//! Immutable project revisions. No donor catalog is opened or migrated.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub type Result<T> = std::result::Result<T, String>;
pub const VERSION: u64 = crate::artifact_schema::COMPOSE_SCHEMA_VERSION;
pub const MAX_BYTES: u64 = 16 * 1024 * 1024;
pub fn root(cwd: &Path) -> PathBuf {
    cwd.join(".impeccable/compose")
}
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn canonical(value: &Value) -> Vec<u8> {
    fn sorted(v: &Value) -> Value {
        match v {
            Value::Object(m) => {
                let mut keys: Vec<_> = m.keys().collect();
                keys.sort();
                Value::Object(
                    keys.into_iter()
                        .map(|k| (k.clone(), sorted(&m[k])))
                        .collect(),
                )
            }
            Value::Array(a) => Value::Array(a.iter().map(sorted).collect()),
            _ => v.clone(),
        }
    }
    serde_json::to_vec(&sorted(value)).expect("JSON value serializes")
}
pub fn digest(value: &Value) -> String {
    hash(&canonical(value))
}
pub fn id(value: &str) -> Result<&str> {
    if value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        Ok(value)
    } else {
        Err("Expected a lowercase SHA-256 identifier".into())
    }
}
pub fn bytes(path: &Path) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| format!("{}: {e}", path.display()))?
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(format!("{} exceeds 16 MiB", path.display()));
    }
    Ok(bytes)
}
pub fn read(path: &Path) -> Result<Value> {
    serde_json::from_slice(&bytes(path)?).map_err(|e| format!("{}: {e}", path.display()))
}
pub fn file_hash(path: &Path) -> Result<String> {
    let mut reader = fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut sha = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        sha.update(&buf[..n]);
    }
    Ok(format!("{:x}", sha.finalize()))
}
pub fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or("Output needs a parent directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temp = parent.join(format!(".{}-{}.tmp", std::process::id(), super::nonce()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        fs::rename(&temp, path).map_err(|e| e.to_string())
    })();
    let _ = fs::remove_file(temp);
    result
}
pub fn retain(dir: &Path, value: &Value) -> Result<String> {
    let content = canonical(value);
    if content.len() as u64 > MAX_BYTES {
        return Err("JSON artifact exceeds 16 MiB; split this processing batch".into());
    }
    let key = hash(&content);
    let path = dir.join(format!("{key}.json"));
    if path.exists() {
        if bytes(&path)? != content {
            return Err(format!("Corrupt retained artifact: {}", path.display()));
        }
    } else {
        atomic(&path, &content)?;
    }
    Ok(key)
}
pub fn retained(dir: &Path, key: &str) -> Result<Value> {
    let value = read(&dir.join(format!("{}.json", id(key)?)))?;
    if digest(&value) != key {
        return Err(format!("Corrupt retained artifact: {key}"));
    }
    Ok(value)
}
pub fn empty() -> Value {
    json!({"schemaVersion":VERSION,"sources":{},"drafts":{},"reviews":[],"adoptions":[],"proposals":[],"decisions":[]})
}
pub fn load(cwd: &Path) -> Result<(String, Value)> {
    let base = root(cwd);
    let head = base.join("current.json");
    if !head.exists() {
        return Ok((digest(&empty()), empty()));
    }
    let pointer = read(&head)?;
    let key = super::required(&pointer, "revision")?;
    let value = retained(&base.join("revisions"), key)?;
    if value["schemaVersion"].as_u64() != Some(VERSION) {
        return Err("Unsupported Compose project schema; no migration was performed".into());
    }
    for field in ["sources", "drafts"] {
        if !value[field].is_object() {
            return Err(format!("Invalid project {field}"));
        }
    }
    for field in ["reviews", "adoptions", "proposals", "decisions"] {
        if !value[field].is_array() {
            return Err(format!("Invalid project {field}"));
        }
    }
    Ok((key.into(), value))
}
pub fn save(cwd: &Path, value: &Value) -> Result<String> {
    let key = retain(&root(cwd).join("revisions"), value)?;
    atomic(
        &root(cwd).join("current.json"),
        &canonical(&json!({"schemaVersion":VERSION,"revision":key})),
    )?;
    Ok(key)
}
pub struct Lock(PathBuf);
impl Lock {
    pub fn acquire(cwd: &Path) -> Result<Self> {
        let base = root(cwd);
        fs::create_dir_all(&base).map_err(|e| e.to_string())?;
        let path = base.join("writer.lock");
        // ponytail: one writer per project; introduce finer locks only if parallel processing needs them.
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&path)
            .map_err(|e| format!("Cannot acquire {}: {e}. For an interrupted run, verify its recorded PID has exited before removing this lock.", path.display()))?;
        file.write_all(std::process::id().to_string().as_bytes())
            .map_err(|e| e.to_string())?;
        Ok(Self(path))
    }
}
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
