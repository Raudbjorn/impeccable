use super::{
    required,
    state::{self, Result},
};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    path::Path,
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};

const EXTRACT: &str = include_str!("../../../../skill/scripts/compose-extract.py");
const EXTRACT_LOCK: &str = include_str!("../../../../skill/scripts/compose-extract.py.lock");
const EXPORT: &str = include_str!("../../../../skill/scripts/compose-export.mjs");
pub fn extract_revision() -> String {
    state::digest(&json!([
        EXTRACT,
        EXTRACT_LOCK,
        include_str!("source_http.rs"),
        include_str!("extract.rs")
    ]))
}
fn tools(cwd: &Path) -> Result<std::path::PathBuf> {
    let path = state::root(cwd).join("tools");
    for (name, source) in [
        ("compose-extract.py", EXTRACT),
        ("compose-extract.py.lock", EXTRACT_LOCK),
        ("compose-export.mjs", EXPORT),
    ] {
        let dest = path.join(name);
        if std::fs::read(&dest).ok().as_deref() != Some(source.as_bytes()) {
            state::atomic(&dest, source.as_bytes())?;
        }
    }
    Ok(path)
}
/// Concurrent capped drains prevent a worker's stderr or stdout from blocking stdin.
fn process(cwd: &Path, argv: &[String], input: &[u8], timeout: Duration) -> Result<Vec<u8>> {
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    impeccable_common::proc::worker_group(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("missing-executable or spawn failure ({}): {e}", argv[0]))?;
    let mut stdin = child.stdin.take().ok_or("Worker stdin unavailable")?;
    let input = input.to_vec();
    std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let (tx, rx) = mpsc::channel();
    fn drain(
        mut pipe: impl Read + Send + 'static,
        tx: mpsc::Sender<(bool, Vec<u8>, bool)>,
        stderr: bool,
    ) {
        std::thread::spawn(move || {
            let limit = if stderr {
                16000
            } else {
                state::MAX_BYTES as usize
            };
            let mut retained = Vec::new();
            let mut overflow = false;
            let mut buf = [0u8; 8192];
            loop {
                let Ok(n) = pipe.read(&mut buf) else { break };
                if n == 0 {
                    break;
                }
                let keep = n.min(limit.saturating_sub(retained.len()));
                retained.extend_from_slice(&buf[..keep]);
                overflow |= keep < n;
            }
            let _ = tx.send((stderr, retained, overflow));
        });
    }
    drain(
        child.stdout.take().ok_or("Worker stdout unavailable")?,
        tx.clone(),
        false,
    );
    drain(
        child.stderr.take().ok_or("Worker stderr unavailable")?,
        tx,
        true,
    );
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
            break s;
        }
        if Instant::now() >= deadline {
            impeccable_common::proc::kill_worker(&mut child);
            return Err("timeout: processing stopped; completed runs remain reusable".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let mut stdout = vec![];
    let mut stderr = vec![];
    let mut oversized = false;
    for _ in 0..2 {
        let (err, bytes, overflow) = match rx.recv_timeout(Duration::from_secs(2)) {
            Ok(output) => output,
            Err(_) => {
                impeccable_common::proc::kill_worker(&mut child);
                return Err("Worker pipes did not close".into());
            }
        };
        if err {
            stderr = bytes;
        } else {
            stdout = bytes;
            oversized = overflow;
        }
    }
    if !status.success() {
        return Err(format!(
            "nonzero-exit {status}: {}",
            String::from_utf8_lossy(&stderr)
        ));
    }
    if oversized {
        return Err("Worker response exceeds 16 MiB".into());
    }
    Ok(stdout)
}
pub fn extract(cwd: &Path, input: &Value) -> Result<Value> {
    if matches!(input["source"]["kind"].as_str(), Some("url" | "structured")) {
        return super::extract::text_source(&input["source"]);
    }
    let dir = tools(cwd)?;
    let result = process(
        cwd,
        &[
            "uv".into(),
            "run".into(),
            "--offline".into(),
            "--locked".into(),
            "--quiet".into(),
            "--script".into(),
            dir.join("compose-extract.py").to_string_lossy().into(),
        ],
        &state::canonical(input),
        Duration::from_secs(180),
    )?;
    serde_json::from_slice(&result).map_err(|e| format!("Invalid extraction response: {e}"))
}
pub fn export(cwd: &Path, input: &Value) -> Result<Value> {
    let dir = tools(cwd)?;
    let config = state::read(&dir.join("config.json")).unwrap_or(json!({}));
    let mut request = input.clone();
    request["config"] = config;
    let result = process(
        cwd,
        &[
            "node".into(),
            dir.join("compose-export.mjs").to_string_lossy().into(),
        ],
        &state::canonical(&request),
        Duration::from_secs(180),
    )?;
    serde_json::from_slice(&result).map_err(|e| format!("Invalid export response: {e}"))
}
pub fn setup(cwd: &Path, input: &Value) -> Result<Value> {
    let _lock = state::Lock::acquire(cwd)?;
    let dir = tools(cwd)?;
    let mut config = if dir.join("config.json").exists() {
        state::read(&dir.join("config.json"))?
    } else {
        json!({})
    };
    for field in ["themeModule", "vernacularModule", "rendererModule"] {
        if input.get(field).is_some() {
            let path = cwd
                .join(required(input, field)?)
                .canonicalize()
                .map_err(|e| format!("{field}: {e}"))?;
            if !path.is_file() {
                return Err(format!("{field} must name an importable module file"));
            }
            config[field] = json!(path);
        }
    }
    if let Some(installs) = input.get("install") {
        for lane in installs.as_array().ok_or("install must be an array")? {
            match lane.as_str() {
                Some("extract") => {
                    process(
                        cwd,
                        &[
                            "uv".into(),
                            "run".into(),
                            "--locked".into(),
                            "--quiet".into(),
                            "--script".into(),
                            dir.join("compose-extract.py").to_string_lossy().into(),
                            "--check".into(),
                        ],
                        b"",
                        Duration::from_secs(180),
                    )?;
                }
                Some("specimen") => {
                    // pretext's PDF inflater needs these tested compatibility pins.
                    state::atomic(
                        &dir.join("package.json"),
                        &state::canonical(
                            &json!({"name":"impose-workers","private":true,"type":"module","dependencies":{"pretext-pdf":"2.2.6","@napi-rs/canvas":"0.1.100"},"overrides":{"@cantoo/pdf-lib":"2.6.5","pako":"1.0.11"}}),
                        ),
                    )?;
                    process(
                        &dir,
                        &["npm".into(), "install".into(), "--ignore-scripts".into()],
                        b"",
                        Duration::from_secs(180),
                    )?;
                }
                _ => return Err("Install lanes are extract and specimen".into()),
            }
        }
    }
    state::atomic(&dir.join("config.json"), &state::canonical(&config))?;
    Ok(
        json!({"tools":dir,"uv":impeccable_common::proc::tool_on_path("uv"),"node":impeccable_common::proc::tool_on_path("node"),"ocr":impeccable_common::proc::tool_on_path("tesseract"),"configuration":config,"extractRevision":extract_revision(),"exportRevision":state::hash(EXPORT.as_bytes()),"note":"Only explicit install lanes fetch dependencies; normal extraction uses uv --offline. Configure actual theme/vernacular parser modules before publishing packages."}),
    )
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn worker_drains_both_pipes_and_times_out_process_groups() {
        let cwd = std::env::temp_dir();
        let noisy = process(
            &cwd,
            &[
                "sh".into(),
                "-c".into(),
                "head -c 100000 /dev/zero >&2; cat".into(),
            ],
            b"{}",
            Duration::from_secs(3),
        )
        .unwrap();
        assert_eq!(noisy, b"{}");
        let start = Instant::now();
        let error = process(
            &cwd,
            &["sh".into(), "-c".into(), "sleep 30 & wait".into()],
            b"",
            Duration::from_millis(50),
        )
        .unwrap_err();
        assert!(error.starts_with("timeout:"));
        assert!(start.elapsed() < Duration::from_secs(3));
    }
}
