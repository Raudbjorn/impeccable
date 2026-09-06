//! Local retrieval: the fork's replacement for the upstream remote roll
//! service.
//!
//! JS: skill/scripts/lib/retrieval-client.mjs, ported so concept-seed keeps
//! working after the JavaScript runtime left the tree. The contract is
//! unchanged: a command named in `.impeccable/config.local.json` receives one
//! JSON request on stdin and answers with one JSON response on stdout.
//!
//! The response is validated rather than trusted. It comes from a process the
//! user configured, but a malformed round that reaches the deck surfaces much
//! later as a confusing render, so every field the caller relies on is checked
//! here where the error can still name what was wrong.

use crate::jsp;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS: u64 = 180_000;
const MAX_STDERR_BYTES: usize = 16_000;
const WELL_TIERS: &[&str] = &["graphic", "interaction", "atmosphere"];

pub struct RetrievalConfig {
    pub command: Vec<String>,
    pub timeout_ms: u64,
}

fn config_path(cwd: &str) -> String {
    jsp::join(&[cwd, ".impeccable/config.local.json"])
}

/// JS: retrievalConfig(cwd). `Ok(None)` means "not configured", which is not
/// an error: most projects never set it. A file that exists but cannot be
/// parsed is an error, because silently falling through to the remote service
/// is the exact behavior this feature exists to prevent.
pub fn retrieval_config(cwd: &str) -> Result<Option<RetrievalConfig>, String> {
    let raw = match std::fs::read_to_string(config_path(cwd)) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Invalid local config: {e}")),
    };
    let parsed: Value =
        serde_json::from_str(&raw).map_err(|e| format!("Invalid local config: {e}"))?;
    let Some(cfg) = parsed.get("retrieval") else {
        return Ok(None);
    };
    if cfg.is_null() {
        return Err(bad_command());
    }
    let command: Vec<String> = match cfg.get("command").and_then(Value::as_array) {
        Some(items) if !items.is_empty() => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                match item.as_str() {
                    Some(s) if !s.is_empty() => out.push(s.to_string()),
                    _ => return Err(bad_command()),
                }
            }
            out
        }
        _ => return Err(bad_command()),
    };
    let timeout_ms = match cfg.get("timeoutMs") {
        None | Some(Value::Null) => DEFAULT_TIMEOUT_MS,
        // as_u64 rejects negatives, floats and non-numbers in one step, which
        // is the set the JS guard refused via Number.isInteger plus `< 1`.
        Some(v) => match v.as_u64() {
            Some(ms) if ms >= 1 => ms,
            _ => return Err(bad_command()),
        },
    };
    Ok(Some(RetrievalConfig {
        command,
        timeout_ms,
    }))
}

fn bad_command() -> String {
    "retrieval.command must be an executable-and-arguments array".to_string()
}

/// JS: callRetrieval(request, { cwd, config }).
pub fn call_retrieval(
    request: &Value,
    cwd: &str,
    config: &RetrievalConfig,
) -> Result<Value, String> {
    let mut payload = match request.clone() {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    payload.insert("protocol".into(), json!(1));
    let body = Value::Object(payload).to_string();

    let mut cmd = Command::new(&config.command[0]);
    cmd.args(&config.command[1..])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    impeccable_common::proc::hide_window(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Local retrieval could not start: {e}"))?;

    // stdin is written on its own thread and closed there. A retrieval command
    // that never drains stdin would otherwise deadlock us before the timeout
    // could fire, since the pipe buffer is smaller than a large request.
    if let Some(mut stdin) = child.stdin.take() {
        std::thread::spawn(move || {
            let _ = stdin.write_all(body.as_bytes());
        });
    }
    let (tx, rx) = mpsc::channel::<(String, String)>();
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    std::thread::spawn(move || {
        let mut out = String::new();
        if let Some(s) = stdout.as_mut() {
            let mut buf = Vec::new();
            let _ = s.take((MAX_RESPONSE_BYTES + 1) as u64).read_to_end(&mut buf);
            out = String::from_utf8_lossy(&buf).into_owned();
        }
        let mut err = String::new();
        if let Some(s) = stderr.as_mut() {
            let mut buf = Vec::new();
            let _ = s.read_to_end(&mut buf);
            err = String::from_utf8_lossy(&buf).into_owned();
            if err.len() > MAX_STDERR_BYTES {
                err = err[err.len() - MAX_STDERR_BYTES..].to_string();
            }
        }
        let _ = tx.send((out, err));
    });

    let deadline = Instant::now() + Duration::from_millis(config.timeout_ms);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("Local retrieval timed out; retry the saved session or check catalog doctor --live".into());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(format!("Local retrieval could not start: {e}")),
        }
    };
    let (stdout, stderr) = rx
        .recv_timeout(Duration::from_secs(5))
        .unwrap_or_else(|_| (String::new(), String::new()));
    if stdout.len() > MAX_RESPONSE_BYTES {
        return Err("Retrieval response exceeds 16 MB".into());
    }
    if !status.success() {
        let detail = if stderr.trim().is_empty() {
            match status.code() {
                Some(code) => format!("exit {code}"),
                None => "exit signal".to_string(),
            }
        } else {
            stderr.trim().to_string()
        };
        return Err(format!("Local retrieval failed: {detail}"));
    }
    let response: Value = serde_json::from_str(&stdout)
        .map_err(|e| format!("Invalid retrieval response: {e}"))?;
    validate(request, &response).map_err(|e| format!("Invalid retrieval response: {e}"))?;
    Ok(response)
}

fn validate(request: &Value, response: &Value) -> Result<(), String> {
    if response.get("protocol").and_then(Value::as_i64) != Some(1) {
        return Err("unsupported response protocol".into());
    }
    if request.get("op").and_then(Value::as_str) == Some("choose") {
        if response.get("recorded") != Some(&Value::Bool(true)) {
            return Err("choice was not recorded".into());
        }
        return Ok(());
    }
    let record = response.get("record");
    let challengers = record
        .and_then(|r| r.get("challengers"))
        .and_then(Value::as_array);
    let compositions = record
        .and_then(|r| r.get("compositions"))
        .and_then(Value::as_array);
    let ok = response.get("session").is_some_and(truthy)
        && response.get("settings").is_some_and(truthy)
        && record.is_some_and(truthy)
        && challengers.is_some_and(|c| !c.is_empty())
        && compositions.is_some_and(|c| !c.is_empty());
    if !ok {
        return Err("missing candidates or session".into());
    }
    let (challengers, compositions) = (challengers.unwrap(), compositions.unwrap());

    if let Some(want) = request.get("session").filter(|v| truthy(v)) {
        if response.get("session") != Some(want) {
            return Err("session mismatch".into());
        }
    }
    let want_round = request.get("round").and_then(Value::as_i64).unwrap_or(0);
    if response.get("round").and_then(Value::as_i64).unwrap_or(-1) != want_round {
        return Err("round mismatch".into());
    }
    let norm = |v: Option<&Value>| match v {
        None | Some(Value::Null) => Value::Null,
        Some(other) => other.clone(),
    };
    if norm(response.get("register")) != norm(request.get("register")) {
        return Err("round mismatch".into());
    }
    if let Some(settings) = request.get("settings").and_then(Value::as_object) {
        for (key, value) in settings {
            if value.is_null() {
                continue;
            }
            if response.get("settings").and_then(|s| s.get(key)) != Some(value) {
                return Err(format!("settings mismatch: {key}"));
            }
        }
    }

    let ids = |items: &[Value]| -> Vec<String> {
        items
            .iter()
            .filter_map(|c| c.get("id").and_then(Value::as_str).map(str::to_string))
            .collect()
    };
    let unique = |items: &[Value]| -> bool {
        let list = ids(items);
        list.len() == items.len()
            && list.iter().collect::<std::collections::BTreeSet<_>>().len() == list.len()
    };
    let challenger_ok = |c: &Value| {
        c.get("id").is_some_and(truthy)
            && c.get("system").is_some_and(|s| s.is_array())
            && c.get("wellTier")
                .and_then(Value::as_str)
                .is_some_and(|t| WELL_TIERS.contains(&t))
    };
    let composition_ok =
        |c: &Value| c.get("id").is_some_and(truthy) && c.get("grammar").is_some_and(|g| g.is_array());
    let staging = record.and_then(|r| r.get("staging"));
    let staging_present = staging.is_some_and(|s| compositions.iter().any(|c| c == s));
    let stagings_ok = match record.and_then(|r| r.get("stagings")) {
        None | Some(Value::Null) => true,
        Some(list) => list.as_array().is_some_and(|l| l == compositions),
    };
    if !unique(challengers)
        || !challengers.iter().all(challenger_ok)
        || !unique(compositions)
        || !compositions.iter().all(composition_ok)
        || !staging_present
        || !stagings_ok
    {
        return Err("invalid candidate roles or staging".into());
    }
    Ok(())
}

fn truthy(v: &Value) -> bool {
    crate::staleness::js_truthy(v)
}

fn hashed_name(bytes: &[u8], source: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(bytes));
    match source.rfind('.') {
        // Node's extname: a leading dot is part of the basename, not an
        // extension, so `.env` contributes nothing here.
        Some(idx) if idx > 0 && !source[idx..].contains('/') => {
            format!("{digest}{}", &source[idx..])
        }
        _ => digest,
    }
}

/// JS: materializeRound(response, cwd). Copies every asset the round points at
/// into `.impeccable/retrieval/<session>/` under a content-addressed name and
/// rewrites the paths, so a later render does not depend on files the
/// retrieval command may have written to a temp dir it since cleaned up.
pub fn materialize_round(response: &Value, cwd: &str) -> Result<Value, String> {
    let session = response
        .get("session")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if session.len() != 64 || !session.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("Invalid session ID".into());
    }
    let directory = jsp::join(&[cwd, ".impeccable/retrieval", session]);
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let mut local = response.clone();

    for group in ["challengers", "compositions"] {
        let Some(entries) = local
            .get_mut("record")
            .and_then(|r| r.get_mut(group))
            .and_then(Value::as_array_mut)
        else {
            continue;
        };
        for entry in entries.iter_mut() {
            if let Some(refs) = entry.get_mut("references").and_then(Value::as_array_mut) {
                for reference in refs.iter_mut() {
                    let Some(path) = reference.get("path").and_then(Value::as_str) else {
                        continue;
                    };
                    let Ok(bytes) = std::fs::read(path) else { continue };
                    let destination = jsp::join(&[&directory, &hashed_name(&bytes, path)]);
                    std::fs::write(&destination, &bytes).map_err(|e| e.to_string())?;
                    reference["path"] = json!(destination);
                }
            }
            for field in ["cardBoard", "cardHero"] {
                let Some(value) = entry.get(field).and_then(Value::as_str) else {
                    continue;
                };
                if value.starts_with("http://") || value.starts_with("https://") {
                    continue;
                }
                let Ok(bytes) = std::fs::read(value) else {
                    entry.as_object_mut().map(|o| o.remove(field));
                    continue;
                };
                let destination = jsp::join(&[&directory, &hashed_name(&bytes, value)]);
                std::fs::write(&destination, &bytes).map_err(|e| e.to_string())?;
                entry[field] = json!(destination);
            }
        }
    }

    let compositions = local
        .get("record")
        .and_then(|r| r.get("compositions"))
        .cloned()
        .unwrap_or(Value::Array(vec![]));
    let staging_id = response
        .get("record")
        .and_then(|r| r.get("staging"))
        .and_then(|s| s.get("id"))
        .cloned();
    if let Some(record) = local.get_mut("record") {
        record["stagings"] = compositions.clone();
        if let (Some(list), Some(id)) = (compositions.as_array(), staging_id) {
            if let Some(found) = list.iter().find(|c| c.get("id") == Some(&id)) {
                record["staging"] = found.clone();
            }
        }
    }

    let register = response
        .get("register")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("normal");
    let round = response.get("round").and_then(Value::as_i64).unwrap_or(0);
    let file = jsp::join(&[&directory, &format!("round-{round}-{register}.json")]);
    let mut text = serde_json::to_string_pretty(&local).map_err(|e| e.to_string())?;
    text.push('\n');
    std::fs::write(&file, text).map_err(|e| e.to_string())?;
    Ok(local)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(config: Option<&str>) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "impeccable-retrieval-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(dir.join(".impeccable")).unwrap();
        if let Some(text) = config {
            std::fs::write(dir.join(".impeccable/config.local.json"), text).unwrap();
        }
        dir
    }

    #[test]
    fn absent_config_is_not_an_error() {
        let ws = workspace(None);
        assert!(retrieval_config(&ws.to_string_lossy()).unwrap().is_none());
    }

    #[test]
    fn config_without_a_retrieval_key_is_not_configured() {
        let ws = workspace(Some(r#"{"hook":{"enabled":true}}"#));
        assert!(retrieval_config(&ws.to_string_lossy()).unwrap().is_none());
    }

    #[test]
    fn malformed_json_is_an_error_rather_than_a_silent_fallback() {
        // Falling through to the remote roll service on a typo is the exact
        // failure this feature exists to prevent, so it has to be loud.
        let ws = workspace(Some("{ nope"));
        assert!(retrieval_config(&ws.to_string_lossy()).is_err());
    }

    #[test]
    fn rejects_command_shapes_the_js_guard_refused() {
        for bad in [
            r#"{"retrieval":{}}"#,
            r#"{"retrieval":{"command":[]}}"#,
            r#"{"retrieval":{"command":["ok",""]}}"#,
            r#"{"retrieval":{"command":["ok",7]}}"#,
            r#"{"retrieval":{"command":["ok"],"timeoutMs":0}}"#,
            r#"{"retrieval":{"command":["ok"],"timeoutMs":-1}}"#,
            r#"{"retrieval":{"command":["ok"],"timeoutMs":1.5}}"#,
        ] {
            let ws = workspace(Some(bad));
            assert!(retrieval_config(&ws.to_string_lossy()).is_err(), "accepted {bad}");
        }
    }

    #[test]
    fn accepts_a_command_and_defaults_the_timeout() {
        let ws = workspace(Some(r#"{"retrieval":{"command":["cat","-"]}}"#));
        let cfg = retrieval_config(&ws.to_string_lossy()).unwrap().unwrap();
        assert_eq!(cfg.command, vec!["cat".to_string(), "-".to_string()]);
        assert_eq!(cfg.timeout_ms, DEFAULT_TIMEOUT_MS);
    }

    #[cfg(unix)]
    fn echo_config(json: &str, timeout_ms: u64) -> RetrievalConfig {
        RetrievalConfig {
            command: vec![
                "sh".into(),
                "-c".into(),
                format!("cat >/dev/null; printf '%s' '{json}'"),
            ],
            timeout_ms,
        }
    }

    #[cfg(unix)]
    fn round_json() -> String {
        serde_json::json!({
            "protocol": 1,
            "session": "a".repeat(64),
            "round": 0,
            "register": null,
            "settings": {"key": "k1"},
            "record": {
                "challengers": [{"id": "c1", "system": [], "wellTier": "graphic"}],
                "compositions": [{"id": "p1", "grammar": []}],
                "staging": {"id": "p1", "grammar": []}
            }
        })
        .to_string()
    }

    #[cfg(unix)]
    #[test]
    fn accepts_a_well_formed_round() {
        let cfg = echo_config(&round_json(), 30_000);
        let request = serde_json::json!({"op": "start", "round": 0, "settings": {"key": "k1"}});
        let out = call_retrieval(&request, ".", &cfg).unwrap();
        assert_eq!(out["session"].as_str().unwrap().len(), 64);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_round_that_answers_a_different_request() {
        let cfg = echo_config(&round_json(), 30_000);
        // The command answered round 0; this asked for round 1.
        let request = serde_json::json!({"op": "round", "round": 1});
        let err = call_retrieval(&request, ".", &cfg).unwrap_err();
        assert!(err.contains("round mismatch"), "{err}");

        let request = serde_json::json!({"op": "start", "round": 0, "settings": {"key": "other"}});
        let err = call_retrieval(&request, ".", &cfg).unwrap_err();
        assert!(err.contains("settings mismatch: key"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_staging_that_is_not_one_of_the_compositions() {
        let mut bad: Value = serde_json::from_str(&round_json()).unwrap();
        bad["record"]["staging"] = serde_json::json!({"id": "nope", "grammar": []});
        let cfg = echo_config(&bad.to_string(), 30_000);
        let request = serde_json::json!({"op": "start", "round": 0});
        let err = call_retrieval(&request, ".", &cfg).unwrap_err();
        assert!(err.contains("invalid candidate roles or staging"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_an_unknown_well_tier() {
        let mut bad: Value = serde_json::from_str(&round_json()).unwrap();
        bad["record"]["challengers"][0]["wellTier"] = serde_json::json!("sparkle");
        let cfg = echo_config(&bad.to_string(), 30_000);
        let request = serde_json::json!({"op": "start", "round": 0});
        assert!(call_retrieval(&request, ".", &cfg).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_nonzero_exit_reports_stderr_rather_than_the_exit_code() {
        let cfg = RetrievalConfig {
            command: vec!["sh".into(), "-c".into(), "echo boom >&2; exit 3".into()],
            timeout_ms: 30_000,
        };
        let err = call_retrieval(&serde_json::json!({"op": "start"}), ".", &cfg).unwrap_err();
        assert!(err.contains("boom"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn a_hung_command_times_out_instead_of_blocking_forever() {
        let cfg = RetrievalConfig {
            command: vec!["sh".into(), "-c".into(), "sleep 30".into()],
            timeout_ms: 300,
        };
        let err = call_retrieval(&serde_json::json!({"op": "start"}), ".", &cfg).unwrap_err();
        assert!(err.contains("timed out"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn a_choose_response_only_has_to_report_that_it_recorded() {
        let cfg = echo_config(r#"{"protocol":1,"recorded":true}"#, 30_000);
        let request = serde_json::json!({"op": "choose", "session": "s"});
        assert!(call_retrieval(&request, ".", &cfg).is_ok());

        let cfg = echo_config(r#"{"protocol":1,"recorded":false}"#, 30_000);
        let err = call_retrieval(&request, ".", &cfg).unwrap_err();
        assert!(err.contains("choice was not recorded"), "{err}");
    }

    #[test]
    fn materialize_refuses_a_session_that_is_not_a_sha256() {
        let ws = workspace(None);
        let bad = serde_json::json!({"session": "../escape", "record": {}});
        assert!(materialize_round(&bad, &ws.to_string_lossy()).is_err());
    }

    #[test]
    fn materialize_copies_assets_under_a_content_addressed_name() {
        let ws = workspace(None);
        let asset = ws.join("hero.png");
        std::fs::write(&asset, b"pixels").unwrap();
        let session = "b".repeat(64);
        let response = serde_json::json!({
            "session": session,
            "round": 0,
            "record": {
                "challengers": [{"id": "c1", "cardHero": asset.to_string_lossy()}],
                "compositions": [{"id": "p1", "grammar": []}],
                "staging": {"id": "p1", "grammar": []}
            }
        });
        let local = materialize_round(&response, &ws.to_string_lossy()).unwrap();
        let moved = local["record"]["challengers"][0]["cardHero"].as_str().unwrap();
        assert!(moved.contains(&session), "asset stays outside the session dir: {moved}");
        assert_eq!(std::fs::read(moved).unwrap(), b"pixels");
        // stagings is filled in from compositions so the renderer sees one list.
        assert_eq!(local["record"]["stagings"], local["record"]["compositions"]);
        assert!(ws.join(".impeccable/retrieval").join(&session).join("round-0-normal.json").exists());
    }
}
