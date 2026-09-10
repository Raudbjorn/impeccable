//! Linux launcher contracts: asset naming, verified downloads, and engine discovery.

use impeccable_skills::engine_binary::{asset_url, DEFAULT_DOWNLOAD_BASE};

/// The launchers ship next to the skill they power.
fn launcher_dir() -> String {
    format!("{}/../../skill/scripts", env!("CARGO_MANIFEST_DIR"))
}

fn launcher_file(name: &str) -> String {
    let path = format!("{}/{name}", launcher_dir());
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

#[test]
fn sh_launcher_asset_naming_matches_engine() {
    let sh = launcher_file("impeccable");
    // The composed URL is <base>/engine-v<version>/impeccable-<os>-<arch>[.exe].
    assert!(sh.contains(&format!("IMPECCABLE_DOWNLOAD_BASE:-{DEFAULT_DOWNLOAD_BASE}")));
    assert!(sh.contains(r#"asset="impeccable-$os-$arch""#));
    assert!(sh.contains(r#"url="$base/engine-v$version/$asset""#));
    // The PATH and unversioned home candidates are probed; trusted paths are not.
    assert!(sh.contains("engine-probe"));
    assert!(sh.contains(r#"probe_ok "$home_bin""#));
    assert!(sh.contains("probe_ok impeccable"));
    // The final error must not recommend the npm package (it still serves 3.x).
    assert!(!sh.contains("npm i -g"));
    assert!(!sh.contains("npm install"));
}

#[test]
fn launchers_fail_closed_on_missing_checksum() {
    // Triage C1: a freshly downloaded binary runs only after verifying
    // against its .sha256 sidecar. A sidecar that cannot be fetched, or a
    // machine with no sha256 tool, refuses the download instead of running
    // an unverified binary; a mismatch stays fatal.
    let sh = launcher_file("impeccable");
    assert!(sh.contains("refusing the unverified download"));
    assert!(sh.contains(r#"if [ -z "$expected" ] || [ -z "$actual" ]; then"#));
    // wget-only environments fetch and require the sidecar too.
    assert!(sh.contains(r#"wget -q -O "$tmp.sha256" "$url.sha256""#));
    // The old lenient path (missing sidecar -> place the binary) is gone.
    for text in [&sh] {
        assert!(text.contains("checksum mismatch downloading"));
    }
}

#[test]
fn launchers_reference_the_same_release_channel() {
    let sh = launcher_file("impeccable");
    for text in [&sh] {
        assert!(text.contains("https://github.com/Raudbjorn/impeccable/releases"));
    }
    // Spot-check the engine's own URL builder against the launcher template.
    assert_eq!(
        asset_url(DEFAULT_DOWNLOAD_BASE, "1.2.3", "linux", "arm64"),
        format!("{DEFAULT_DOWNLOAD_BASE}/engine-v1.2.3/impeccable-linux-arm64")
    );
}

#[test]
fn sh_launcher_exports_skill_dir_before_the_env_bin_exec() {
    // Regression: the launcher used to `exec "$IMPECCABLE_BIN"` BEFORE it
    // exported IMPECCABLE_SKILL_DIR/SELF, so a binary reached via IMPECCABLE_BIN
    // ran with no skill dir and could not inline reference/*.md or read its own
    // version (native platform refs and UPDATE_AVAILABLE silently vanished).
    // The skill-behavior suite caught it; the oracle could not (it sets the env
    // directly). Guard the ordering at the string level and functionally.
    let sh = launcher_file("impeccable");
    let export_pos = sh
        .find("export IMPECCABLE_SKILL_DIR IMPECCABLE_SELF")
        .expect("launcher exports the skill-dir env");
    let env_bin_exec = sh
        .find(r#"exec "${IMPECCABLE_BIN}""#)
        .expect("launcher execs IMPECCABLE_BIN");
    assert!(
        export_pos < env_bin_exec,
        "IMPECCABLE_SKILL_DIR must be exported before the IMPECCABLE_BIN exec"
    );
}

#[cfg(unix)]
#[test]
fn sh_launcher_passes_skill_dir_to_the_env_bin() {
    use std::os::unix::fs::PermissionsExt;
    let launcher = format!("{}/impeccable", launcher_dir());
    let dir = std::env::temp_dir().join(format!("impeccable-launcher-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // A stub "engine binary" that just prints the skill dir it was handed.
    let stub = dir.join("stub");
    std::fs::write(&stub, "#!/bin/sh\nprintf 'SKILL_DIR=%s\\n' \"${IMPECCABLE_SKILL_DIR:-UNSET}\"\n").unwrap();
    std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
    let out = std::process::Command::new("sh")
        .arg(&launcher)
        .arg("context")
        .env("IMPECCABLE_BIN", &stub)
        .env_remove("IMPECCABLE_SKILL_DIR")
        .output()
        .expect("run launcher");
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains("SKILL_DIR=") && !stdout.contains("SKILL_DIR=UNSET") && !stdout.contains("SKILL_DIR=\n"),
        "launcher must export a non-empty IMPECCABLE_SKILL_DIR to the IMPECCABLE_BIN binary; got: {stdout}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
