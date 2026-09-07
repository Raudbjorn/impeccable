use impeccable_context::compose::{execute, state};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};

struct Workspace(PathBuf);
impl Workspace {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "impose-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn run(&self, command: &str, input: Value) -> Value {
        execute(&self.0, command, &input).unwrap()
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn concept(id: &str, tier: &str) -> Value {
    json!({"id":id,"kind":"concept","name":id,"wellTier":tier,"familyId":id,
        "form":format!("A {id} specimen folio, numbered plates around an open reading column"),
        "lineage":"Synthetic specimen created for integration testing", "strength":"dual",
        "tags":["reading","plates","numbering"],
        "system":["Palette/material: black ink on white paper", "Type/composition: serif headings and plain body text", "Topology/navigation: numbered sections follow reading order", "Controls/state: show the active reading section", "Responsive/motion: collapse marginal notes below the text"],
        "spark":"Numbered plates anchor each section while generous reading columns keep the specimen legible across the whole document.",
        "webLeverage":"Use semantic sections with addressable anchors"})
}

fn draft() -> Value {
    json!({"entries":[concept("plate-one","graphic"), concept("plate-two","interaction"), concept("plate-three","atmosphere"),
        {"id":"reading-sequence","kind":"composition","familyId":"reading","form":"Numbered reading sequence with notes", "spark":"An ordered reading sequence", "surface":"read","grain":"view","platforms":["web"],"grammar":["Staging/hierarchy: one reading column", "Sequence/attention: follow numbered sections", "Controls/state: active section anchors", "Adaptation: move notes below reading text"],"webLeverage":"Semantic sections and anchors"}], "guidance":[],"claims":[],"tokens":{}})
}

#[test]
fn invalid_drafts_are_retained_without_trimming_and_reviews_are_content_bound() {
    let ws = Workspace::new();
    let mut invalid = draft();
    invalid["entries"][0]["system"][0] = json!("Palette/material: ".to_string() + &"x".repeat(200));
    let report = ws.run("validate", json!({"draft":invalid}));
    assert_eq!(report["valid"], false);
    assert!(ws
        .0
        .join(".impeccable/compose/drafts")
        .join(format!("{}.json", report["draftId"].as_str().unwrap()))
        .exists());
    assert!(execute(&ws.0, "review", &json!({"draftId":report["draftId"],"actor":"tester","authority":"human","verdict":"approved","reason":"reviewed"})).is_err());
    let valid = ws.run("validate", json!({"draft":draft()}));
    assert_eq!(valid["valid"], true, "{valid}");
    ws.run("review", json!({"draftId":valid["draftId"],"actor":"test-model","authority":"machine","verdict":"approved","reason":"synthetic checks passed"}));
    let request = json!({"op":"start","brief":"reading numbered plates","settings":{"key":"deadbeef","scope":"direction","mode":"read","platform":"web"}});
    assert!(execute(&ws.0, "select", &request).is_err());
    let mut allowed = request.clone();
    allowed["settings"]["approvalPolicy"] = json!("human-and-machine");
    let selected = ws.run("select", allowed);
    assert_eq!(
        selected["record"]["challengers"][0]["review"]["authority"],
        "machine"
    );
    let replay = ws.run(
        "select",
        json!({"op":"replay","session":selected["session"],"round":0}),
    );
    assert_eq!(selected, replay);
    assert_eq!(selected["record"]["staging"]["id"], "reading-sequence");
}

#[test]
fn source_hash_drift_and_corrupt_revisions_are_detected_without_touching_sources() {
    let ws = Workspace::new();
    let source = ws.0.join("source.json");
    fs::write(
        &source,
        r#"{"pages":[{"page":1,"text":"Synthetic reading source"}]}"#,
    )
    .unwrap();
    let before = fs::read(&source).unwrap();
    ws.run("source", json!({"target":source,"kind":"structured"}));
    assert_eq!(fs::read(&source).unwrap(), before);
    assert_eq!(ws.run("verify", json!({"deep":true}))["valid"], true);
    fs::write(&source, "changed").unwrap();
    assert_eq!(ws.run("verify", json!({"deep":true}))["valid"], false);
    let (revision, _) = state::load(&ws.0).unwrap();
    fs::write(
        ws.0.join(".impeccable/compose/revisions")
            .join(format!("{revision}.json")),
        "{}",
    )
    .unwrap();
    assert!(state::load(&ws.0).is_err());
}

#[test]
fn adoption_rejects_accessibility_exceptions_and_exports_are_explicit() {
    let ws = Workspace::new();
    let validated = ws.run("validate", json!({"draft":draft()}));
    ws.run("review", json!({"draftId":validated["draftId"],"actor":"tester","authority":"human","verdict":"approved","reason":"reviewed synthetic specimen"}));
    assert!(execute(&ws.0, "adopt", &json!({"draftId":validated["draftId"],"exceptions":[{"rule":"low-contrast","selector":"body","reason":"style"}]})).is_err());
    ws.run(
        "adopt",
        json!({"draftId":validated["draftId"],"reason":"Use the reading grammar"}),
    );
    let export = ws.run(
        "export",
        json!({"format":"bcp","draftId":validated["draftId"]}),
    );
    assert_eq!(export["valid"], true);
    assert!(fs::read_to_string(export["path"].as_str().unwrap())
        .unwrap()
        .contains("not a certified BCP document"));
}

#[test]
fn lexical_matching_retains_diversity_and_unknown_signal_does_not_claim_relevance() {
    use impeccable_context::compose::selection::shortlist;
    let entries = vec![
        json!({"id":"b","name":"reading","familyId":"same"}),
        json!({"id":"a","name":"reading","familyId":"same"}),
        json!({"id":"c","name":"reading","familyId":"different"}),
    ];
    let (ranked, signal) = shortlist(entries.clone(), "reading", 1, 2, None);
    assert!(signal);
    assert_eq!(
        ranked
            .iter()
            .map(|e| e["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["a", "c"]
    );
    let (all, signal) = shortlist(entries, "unmatched", 1, 2, None);
    assert!(!signal);
    assert_eq!(all.len(), 3);
}

#[test]
fn exact_style_exceptions_keep_findings_and_do_not_apply_to_text_or_other_targets() {
    let ws = Workspace::new();
    let validated = ws.run("validate", json!({"draft":draft()}));
    ws.run("review",json!({"draftId":validated["draftId"],"actor":"tester","authority":"human","verdict":"approved","reason":"reviewed"}));
    ws.run("adopt",json!({"draftId":validated["draftId"],"reason":"Retain the authored tab","exceptions":[{"rule":"side-tab","target":"page.html","selector":".tab","reason":"Adopted reading tab"}]}));
    let finding = json!({"antipattern":"side-tab","selector":".tab","severity":"warning"});
    for (observation, target, accepted) in [
        ("browser", "page.html", true),
        ("source-text", "page.html", false),
        ("browser", "other.html", false),
    ] {
        let report = ws.run(
            "assess",
            json!({"target":target,"observation":observation,"findings":[finding]}),
        );
        assert_eq!(report["report"]["findings"].as_array().unwrap().len(), 1);
        assert_eq!(
            report["report"]["findings"][0]["compositionException"].is_object(),
            accepted
        );
        assert_eq!(report["report"]["findings"][0]["severity"], "warning");
    }
}

#[test]
fn critique_runs_need_matching_rubric_applicability_and_observation_context() {
    use impeccable_context::compose::assessment::comparable;
    let old = json!({"rubric_revision":"one","max_score":40,"observation":"browser","observation_context":"1280x800:initial","target_identity":"page"});
    assert!(comparable(&old, &old));
    for (field, value) in [
        ("rubric_revision", json!("two")),
        ("max_score", json!(36)),
        ("observation_context", json!("375x812:initial")),
    ] {
        let mut next = old.clone();
        next[field] = value;
        assert!(!comparable(&old, &next));
    }
    assert!(!comparable(&json!({}), &json!({})));
}

#[test]
fn failed_package_validation_preserves_existing_export_and_retain_draft() {
    let ws = Workspace::new();
    let mut data = draft();
    data["tokens"] = json!({"bg":"#ffffff","text":"#111111"});
    let validated = ws.run("validate", json!({"draft":data}));
    ws.run("review",json!({"draftId":validated["draftId"],"actor":"tester","authority":"human","verdict":"approved","reason":"reviewed"}));
    let bcp = ws.run(
        "export",
        json!({"draftId":validated["draftId"],"format":"bcp"}),
    );
    let before = fs::read(bcp["path"].as_str().unwrap()).unwrap();
    assert!(execute(
        &ws.0,
        "export",
        &json!({"draftId":validated["draftId"],"format":"world-theme","entryId":"plate-one"})
    )
    .is_err());
    assert_eq!(before, fs::read(bcp["path"].as_str().unwrap()).unwrap());
    assert_eq!(
        fs::read_dir(ws.0.join(".impeccable/compose/failed-exports"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn revoked_adoptions_stop_applying_and_empty_manifests_fail_verification() {
    let ws = Workspace::new();
    let validated = ws.run("validate", json!({"draft":draft()}));
    let approval = json!({"draftId":validated["draftId"],"actor":"tester","authority":"human","verdict":"approved","reason":"reviewed"});
    ws.run("review", approval.clone());
    ws.run("adopt",json!({"draftId":validated["draftId"],"reason":"Use tabs","exceptions":[{"rule":"side-tab","target":"page","selector":".tab","reason":"Reading tabs"}]}));
    let export = ws.run(
        "export",
        json!({"draftId":validated["draftId"],"format":"bcp"}),
    );
    let manifest = PathBuf::from(export["bundle"].as_str().unwrap()).join("manifest.json");
    fs::write(manifest, r#"{"files":{}}"#).unwrap();
    assert_eq!(ws.run("verify", json!({"deep":true}))["valid"], false);
    ws.run("review",json!({"draftId":validated["draftId"],"actor":"tester","authority":"human","verdict":"rejected","reason":"Withdrawn"}));
    let report = ws.run("assess",json!({"target":"page","observation":"browser","findings":[{"antipattern":"side-tab","selector":".tab"}]}));
    assert!(report["report"]["findings"][0]["compositionException"].is_null());
    assert!(execute(
        &ws.0,
        "assess",
        &json!({"target":"page","observation":"browser"})
    )
    .is_err());
    ws.run("review", approval);
    assert!(impeccable_context::compose::catalog::approved(
        &state::load(&ws.0).unwrap().1,
        validated["draftId"].as_str().unwrap(),
        "human"
    ));
}

#[test]
fn native_token_adoption_merges_without_rewriting_design_and_rejects_conflicts() {
    use impeccable_context::compose::assessment::effective_design_system;
    let ws = Workspace::new();
    let design = "---\ncolors:\n  ink: '#111111'\n---\n\n# Design\n";
    fs::write(ws.0.join("DESIGN.md"), design).unwrap();
    let mut data = draft();
    data["designTokens"] = json!({"colors":{"paper":"#ffffff"},"rounded":{"button":"4px"}});
    let valid = ws.run("validate", json!({"draft":data}));
    ws.run("review",json!({"draftId":valid["draftId"],"authority":"human","actor":"tester","verdict":"approved","reason":"Reviewed native tokens"}));
    ws.run(
        "adopt",
        json!({"draftId":valid["draftId"],"reason":"Use documented tokens"}),
    );
    let (_, project) = state::load(&ws.0).unwrap();
    let ds = effective_design_system(&ws.0, &project).unwrap().unwrap();
    assert!(impeccable_detect::design_system::is_allowed_color_raw(
        "#ffffff",
        Some(&ds)
    ));
    assert!(impeccable_detect::design_system::is_allowed_radius_raw(
        "4px",
        Some(&ds)
    ));
    assert!(!impeccable_detect::design_system::is_allowed_radius_raw(
        "18px",
        Some(&ds)
    ));
    assert_eq!(fs::read_to_string(ws.0.join("DESIGN.md")).unwrap(), design);
    data["designTokens"]["colors"]["ink"] = json!("#eeeeee");
    let conflict = ws.run("validate", json!({"draft":data}));
    ws.run("review",json!({"draftId":conflict["draftId"],"authority":"human","actor":"tester","verdict":"approved","reason":"Reviewed alternative"}));
    assert!(execute(
        &ws.0,
        "adopt",
        &json!({"draftId":conflict["draftId"],"reason":"Alternative","replace":true})
    )
    .unwrap_err()
    .contains("conflicts with DESIGN.md"));
    assert_eq!(
        state::load(&ws.0).unwrap().1["adoptions"],
        project["adoptions"]
    );
}

#[test]
fn rendered_comparison_uses_actual_pixels_and_retains_input_hashes() {
    let ws = Workspace::new();
    let comp = impeccable_comp::raster::create_image(32, 32, [255, 255, 255, 255]);
    let changed = impeccable_comp::raster::create_image(32, 32, [0, 0, 0, 255]);
    fs::write(
        ws.0.join("comp.png"),
        impeccable_comp::png_io::encode_png(&comp, &[]).unwrap(),
    )
    .unwrap();
    fs::write(
        ws.0.join("build.png"),
        impeccable_comp::png_io::encode_png(&comp, &[]).unwrap(),
    )
    .unwrap();
    fs::write(ws.0.join("spec.json"), r#"{"regions":[]}"#).unwrap();
    let input = json!({"target":"page","observation":"comp-diff","comp":"comp.png","build":"build.png","spec":"spec.json"});
    let matched = ws.run("assess", input.clone());
    fs::write(
        ws.0.join("build.png"),
        impeccable_comp::png_io::encode_png(&changed, &[]).unwrap(),
    )
    .unwrap();
    let drifted = ws.run("assess", input);
    assert!(
        matched["report"]["comparison"]["overall"].as_f64().unwrap()
            > drifted["report"]["comparison"]["overall"].as_f64().unwrap()
    );
    assert_ne!(
        matched["report"]["artifacts"]["build"]["hash"],
        drifted["report"]["artifacts"]["build"]["hash"]
    );
}

#[test]
fn url_sources_reject_nonpublic_destinations_without_fetching() {
    use impeccable_context::compose::source_http::validate_url;
    for url in [
        "http://169.254.169.254/latest/meta-data",
        "http://localhost/",
        "http://127.1/",
        "http://2130706433/",
        "http://0x7f000001/",
        "http://[::1]/",
        "http://[::ffff:127.0.0.1]/",
        "http://192.168.1.1/",
        "http://user:pass@example.com/",
        "file:///etc/passwd",
    ] {
        assert!(validate_url(url).is_err(), "accepted {url}");
    }
    assert!(validate_url("https://example.com/source").is_ok());
}

#[test]
fn export_assets_cannot_escape_the_project() {
    let ws = Workspace::new();
    let outside = Workspace::new();
    let image = impeccable_comp::raster::create_image(8, 8, [255, 255, 255, 255]);
    let bytes = impeccable_comp::png_io::encode_png(&image, &[]).unwrap();
    fs::write(outside.0.join("private.png"), &bytes).unwrap();
    fs::write(ws.0.join("image.png"), &bytes).unwrap();
    let valid = ws.run("validate", json!({"draft":draft()}));
    ws.run("review",json!({"draftId":valid["draftId"],"actor":"tester","authority":"human","verdict":"approved","reason":"Reviewed"}));
    assert!(execute(
        &ws.0,
        "export",
        &json!({"draftId":valid["draftId"],"format":"bcp","assets":[outside.0.join("private.png")]})
    )
    .is_err());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(outside.0.join("private.png"), ws.0.join("escape.png")).unwrap();
        assert!(execute(
            &ws.0,
            "export",
            &json!({"draftId":valid["draftId"],"format":"bcp","assets":["escape.png"]})
        )
        .is_err());
    }
    let exported = ws.run(
        "export",
        json!({"draftId":valid["draftId"],"format":"bcp","assets":["image.png"]}),
    );
    let semantic =
        state::read(&PathBuf::from(exported["bundle"].as_str().unwrap()).join("semantic.json"))
            .unwrap();
    let snapshot = semantic["assets"][0]["path"].as_str().unwrap();
    fs::write(ws.0.join("image.png"), "changed").unwrap();
    assert_eq!(fs::read(snapshot).unwrap(), bytes);
}

#[test]
fn structured_processing_is_native_and_rejects_invalid_geometry() {
    let ws = Workspace::new();
    let path = ws.0.join("pages.json");
    fs::write(&path, r#"{"pages":[{"text":"Visual Identity: clear space","spans":[{"id":"p1","text":"clear space","bbox":[0,0,1,1]}]}]}"#).unwrap();
    let registered = ws.run(
        "source",
        json!({"action":"register","kind":"structured","target":path}),
    );
    let source_id = registered["sourceId"].clone();
    let output = ws.run("derive", json!({"sourceId":source_id}));
    assert!(output.is_object());
    fs::write(
        &path,
        r#"{"pages":[{"spans":[{"id":"p1","text":"bad","bbox":[1,0,0,1]}]}]}"#,
    )
    .unwrap();
    let registered = ws.run(
        "source",
        json!({"action":"register","kind":"structured","target":path}),
    );
    assert!(execute(&ws.0, "derive", &json!({"sourceId":registered["sourceId"]})).is_err());
}
