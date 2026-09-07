use super::{
    catalog, required,
    state::{self, Result},
    worker,
};
use serde_json::{json, Value};
use std::{fs, path::Path};

pub fn run(cwd: &Path, project: &Value, input: &Value) -> Result<Value> {
    let key = required(input, "draftId")?;
    let policy = input["approvalPolicy"].as_str().unwrap_or("human");
    super::selection::policy(policy)?;
    if !catalog::approved(project, key, policy) {
        return Err("Export requires an eligible reviewed draft".into());
    }
    let draft = catalog::load_draft(cwd, key)?;
    let errors = catalog::validate(&draft, project);
    if !errors.is_empty() {
        return Err(format!("Invalid export draft: {}", errors.join("; ")));
    }
    let format = required(input, "format")?;
    if !["bcp", "world-theme", "vernacular", "specimen", "design"].contains(&format) {
        return Err("Formats: bcp, world-theme, vernacular, specimen, design".into());
    }
    let entries = draft["entries"].as_array().ok_or("Missing entries")?;
    let entry = if matches!(format, "world-theme" | "vernacular") {
        let id = required(input, "entryId")?;
        entries
            .iter()
            .find(|e| e["id"] == id)
            .ok_or("Unknown export entryId")?
    } else {
        &Value::Null
    };
    let evidence = super::assessment::evidence(project, Some(key));
    let assets = input.get("assets").cloned().unwrap_or(json!([]));
    let mut asset_hashes = vec![];
    for asset in assets
        .as_array()
        .ok_or("assets must be an array of paths")?
    {
        let path = cwd
            .join(asset.as_str().ok_or("asset must be a path string")?)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        asset_hashes.push(json!({"path":path,"hash":state::file_hash(&path)?}));
    }
    let revision = state::digest(project);
    let (document, diagnostics) = match format {
        "bcp" => (
            json!({
                "$schema":"https://svnbjrn.dev/schemas/bcp-shaped.v1.json",
                "brand":{"name":input["name"].as_str().unwrap_or("project"),"sources":draft["evidence"]},
                "identity":{"principles":guidance(&draft,"principle"),"lineages":entries.iter().filter_map(|e| e.get("lineage")).collect::<Vec<_>>()},
                "visual":{"tokens":draft["tokens"].as_object().map(|m| m.iter().map(|(k,v)| (k,v.get("$value").unwrap_or(v))).collect::<std::collections::BTreeMap<_,_>>()),"worlds":entries.iter().filter(|e| e["kind"]=="concept").collect::<Vec<_>>(),"compositions":entries.iter().filter(|e| e["kind"]=="composition").collect::<Vec<_>>()},
                "verbal":{"rules":guidance(&draft,"verbal"),"vernacular":entries.iter().filter_map(|e| e.get("vernacular").map(|v| (e["id"].as_str().unwrap_or(""),v))).collect::<std::collections::BTreeMap<_,_>>()},
                "brand_constraints":guidance(&draft,"constraint").into_iter().chain(guidance(&draft,"medium")).chain(entries.iter().flat_map(|e| e["avoid"].as_array().into_iter().flatten().map(|rule| json!({"world":e["id"],"rule":rule})))).collect::<Vec<_>>(),
                "$extensions":{"impose":{"catalogRevision":revision,"evidence":evidence,"claims":draft["claims"],"review":catalog::review(project,key),"note":"BCP-shaped: five sector names; not a certified BCP document."}}
            }),
            json!([]),
        ),
        "world-theme" => {
            if draft["tokens"].as_object().is_none_or(|m| m.is_empty()) {
                return Err("World theme needs explicitly authored or adopted tokens; no accent is invented".into());
            }
            let mut tokens = world_tokens(&draft)?;
            for role in ["sans", "mono"] {
                if let Some(font) = entry["fonts"].get(role) {
                    tokens[format!("font-{role}")] = json!({"$type":"fontFamily","$value":font});
                }
            }
            (
                json!({"$schema":"https://svnbjrn.dev/schemas/world-theme.v1.json","name":entry["id"],"version":"0.1.0","extends":input["extends"].as_str().unwrap_or("light"),"meta":{"generator":"impose/1","catalogRevision":revision,"concept":entry["id"],"accentOrigin":draft["accentOrigin"].as_str().unwrap_or("authored product choice; no source derivation asserted")},"tokens":tokens}),
                json!([]),
            )
        }
        "vernacular" => {
            let terms = entry["vernacular"]
                .as_object()
                .ok_or("Entry has no vernacular")?;
            let mut strings = json!({});
            let mut unplaced = vec![];
            for (slot, term) in terms {
                let mapped = match slot.as_str() {
                    "nav" => Some(("navBar", "navLabel")),
                    "menu" => Some(("navBar", "menuLabel")),
                    "copy" => Some(("codeBlock", "copyLabel")),
                    "copied" => Some(("codeBlock", "copiedLabel")),
                    _ => None,
                };
                if let Some((component, property)) = mapped {
                    if strings.get(component).is_none() {
                        strings[component] = json!({});
                    }
                    strings[component][property] = term.clone();
                } else {
                    unplaced.push(json!({"slot":slot,"term":term}));
                }
            }
            if strings["codeBlock"]["copyLabel"].is_string() {
                strings["codeBlock"]["copyAriaLabel"] = json!(format!(
                    "{} {}",
                    strings["codeBlock"]["copyLabel"].as_str().unwrap(),
                    terms.get("item").and_then(Value::as_str).unwrap_or("text")
                ));
            }
            (
                json!({"$schema":"https://svnbjrn.dev/schemas/vernacular.v1.json","name":entry["id"],"version":"0.1.0","meta":{"generator":"impose/1","catalogRevision":revision},"strings":strings}),
                json!({"unplaced":unplaced}),
            )
        }
        "specimen" => {
            let mut content = vec![
                json!({"type":"paragraph","text":"REVIEW DRAFT — factual and visual approval remain separate from catalog approval","fontSize":9}),
            ];
            for entry in entries {
                content.push(json!({"type":"heading","level":1,"text":entry["name"].as_str().or(entry["id"].as_str()).unwrap_or("Specimen")}));
                for field in ["form", "spark", "lineage", "webLeverage"] {
                    if let Some(text) = entry[field].as_str() {
                        content.push(json!({"type":"paragraph","text":text}));
                    }
                }
                let grammar = entry.get("system").or_else(|| entry.get("grammar"));
                for rule in grammar.and_then(Value::as_array).into_iter().flatten() {
                    content.push(json!({"type":"paragraph","text":rule}));
                }
            }
            for claim in draft["claims"].as_array().into_iter().flatten() {
                content.push(json!({"type":"paragraph","text":format!("Claim ({}): {} — {}",claim["kind"].as_str().unwrap_or("unsupported"),claim["statement"].as_str().unwrap_or(""),claim["citation"].as_str().unwrap_or("no attributed citation")),"fontSize":9}));
            }
            for ev in evidence.as_array().into_iter().flatten() {
                content.push(
                    json!({"type":"paragraph","text":format!("Evidence: {ev}"),"fontSize":8}),
                );
            }
            for asset in &asset_hashes {
                content.push(json!({"type":"image","src":asset["path"],"width":300}));
            }
            (
                json!({"pageSize":"A4","margins":{"top":36,"bottom":36,"left":36,"right":36},"defaultFontSize":10,"content":content}),
                json!([]),
            )
        }
        "design" => {
            if !project["adoptions"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v["draftId"] == key))
            {
                return Err("Adopt this draft before exporting its DESIGN.md requirements".into());
            }
            (json!({"markdown":design_markdown(&draft,key)?}), json!([]))
        }
        _ => unreachable!(),
    };
    let tools = state::root(cwd).join("tools");
    let mut dependencies = json!({"adapter":state::hash(include_bytes!("../../../../skill/scripts/compose-export.mjs"))});
    for file in ["config.json", "package-lock.json"] {
        if tools.join(file).exists() {
            dependencies[file] = json!(state::file_hash(&tools.join(file))?);
        }
    }
    if tools.join("config.json").exists() {
        let cfg = state::read(&tools.join("config.json"))?;
        for field in ["themeModule", "vernacularModule", "rendererModule"] {
            if let Some(path) = cfg[field].as_str() {
                dependencies[field] = json!(state::file_hash(Path::new(path))?);
            }
        }
    }
    if ["world-theme", "vernacular", "specimen"].contains(&format) {
        dependencies["runtime"] = worker::export(cwd, &json!({"format":"identity","for":format}))?;
    }
    let semantic = json!({"schemaVersion":1,"format":format,"draftId":key,"catalogRevision":revision,"review":catalog::review(project,key),"draft":draft,"evidence":evidence,"assets":asset_hashes,"dependencies":dependencies});
    let build_id = state::digest(&json!({"semantic":semantic,"document":document}));
    let base = state::root(cwd).join("exports");
    let destination = base.join(&build_id);
    let filename = match format {
        "specimen" => "specimen.pdf",
        "design" => "DESIGN.md",
        _ => "document.json",
    };
    if destination.exists() {
        verify_bundle(&destination)?;
        return Ok(
            json!({"valid":true,"buildId":build_id,"path":destination.join(filename),"reused":true}),
        );
    }
    let stage = base.join(format!(".{}-{}.tmp", std::process::id(), super::nonce()));
    fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
    let output = (|| {
        state::atomic(&stage.join("document.json"), &state::canonical(&document))?;
        state::atomic(&stage.join("semantic.json"), &state::canonical(&semantic))?;
        let validation = if ["world-theme", "vernacular", "specimen"].contains(&format) {
            worker::export(
                cwd,
                &json!({"format":format,"document":document,"output":stage.join("specimen.pdf")}),
            )?
        } else {
            json!({"valid":true,"status":"draft","factualReview":"required","visualReview":"required"})
        };
        if validation["valid"] != true {
            return Err("Worker did not validate export".into());
        }
        if format == "design" {
            state::atomic(
                &stage.join("DESIGN.md"),
                document["markdown"].as_str().unwrap().as_bytes(),
            )?;
        }
        state::atomic(
            &stage.join("validation.json"),
            &state::canonical(&validation),
        )?;
        let mut files = serde_json::Map::new();
        for file in fs::read_dir(&stage).map_err(|e| e.to_string())? {
            let file = file.map_err(|e| e.to_string())?;
            files.insert(
                file.file_name().to_string_lossy().into(),
                json!(state::file_hash(&file.path())?),
            );
        }
        state::atomic(
            &stage.join("manifest.json"),
            &state::canonical(
                &json!({"schemaVersion":1,"buildId":build_id,"files":files,"diagnostics":diagnostics}),
            ),
        )?;
        fs::rename(&stage, &destination).map_err(|e| e.to_string())?;
        Ok(
            json!({"valid":true,"buildId":build_id,"path":destination.join(filename),"bundle":destination,"diagnostics":diagnostics}),
        )
    })();
    if let Err(error) = &output {
        // Retain the draft and exact diagnostics; do not publish it as an export.
        let failed = state::root(cwd)
            .join("failed-exports")
            .join(format!("{build_id}-{}", super::nonce()));
        state::atomic(
            &stage.join("failure.json"),
            &state::canonical(&json!({"error":error,"buildId":build_id})),
        )?;
        fs::create_dir_all(failed.parent().unwrap()).map_err(|e| e.to_string())?;
        fs::rename(&stage, failed).map_err(|e| e.to_string())?;
    }
    output
}
fn guidance(draft: &Value, kind: &str) -> Vec<Value> {
    draft["guidance"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|g| g["kind"] == kind)
        .cloned()
        .collect()
}
fn world_tokens(draft: &Value) -> Result<Value> {
    let mut out = json!({});
    for (name, token) in draft["tokens"]
        .as_object()
        .ok_or("tokens must be an object")?
    {
        if name.starts_with("status-")
            || ["success", "warning", "error", "danger"].contains(&name.as_str())
        {
            return Err(format!("Status token {name} must not be themed"));
        }
        out[name] = if token.is_object() {
            token.clone()
        } else {
            json!({"$value":token})
        };
    }
    Ok(out)
}
pub(super) fn design_markdown(draft: &Value, key: &str) -> Result<String> {
    let mut colors = String::new();
    let mut fonts = String::new();
    for (name, token) in draft["tokens"].as_object().into_iter().flatten() {
        let value = token.get("$value").unwrap_or(token);
        if let Some(raw) = value
            .as_str()
            .filter(|v| impeccable_core::color::parse_any_color(Some(v)).is_some())
        {
            colors.push_str(&format!(
                "  {}: {}\n",
                serde_json::to_string(name).unwrap(),
                serde_json::to_string(raw).unwrap()
            ));
        } else if token["$type"] == "fontFamily" {
            let stack = if let Some(s) = value.as_str() {
                s.to_string()
            } else if let Some(a) = value.as_array() {
                a.iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(", ")
            } else {
                return Err(format!("Invalid font token {name}"));
            };
            fonts.push_str(&format!(
                "  {}:\n    fontFamily: {}\n",
                serde_json::to_string(name).unwrap(),
                serde_json::to_string(&stack).unwrap()
            ));
        } else if draft.get("designTokens").is_none() {
            return Err(format!(
                "Token {name} has no supported DESIGN.md mapping; retain it in its package instead"
            ));
        }
    }
    let mut text = "---\nname: \"Adopted project design\"\n".to_string();
    if !colors.is_empty() {
        text.push_str(&format!("colors:\n{colors}"));
    }
    if !fonts.is_empty() {
        text.push_str(&format!("typography:\n{fonts}"));
    }
    if let Some(native) = draft.get("designTokens") {
        for (group, tokens) in native.as_object().ok_or("designTokens must be an object")? {
            if !["colors", "typography", "rounded", "spacing", "components"]
                .contains(&group.as_str())
                || !tokens.is_object()
            {
                return Err(format!("Invalid DESIGN.md token group {group}"));
            }
        }
        let mut merged =
            impeccable_detect::design_system::parse_frontmatter(&format!("{text}---\n"))
                .unwrap_or_default();
        for (group, tokens) in native.as_object().unwrap() {
            let existing = merged
                .entry(group.clone())
                .or_insert(json!({}))
                .as_object_mut()
                .ok_or("Invalid token group")?;
            for (name, value) in tokens.as_object().unwrap() {
                if existing.get(name).is_some_and(|old| old != value) {
                    return Err(format!("Conflicting native token {group}.{name}"));
                }
                existing.insert(name.clone(), value.clone());
            }
        }
        fn yaml(map: &serde_json::Map<String, Value>, indent: usize, output: &mut String) {
            for (key, value) in map {
                output.push_str(&format!(
                    "{}{}:",
                    " ".repeat(indent),
                    serde_json::to_string(key).unwrap()
                ));
                if let Some(nested) = value.as_object() {
                    output.push('\n');
                    yaml(nested, indent + 2, output);
                } else {
                    output.push_str(&format!(" {value}\n"));
                }
            }
        }
        text = "---\n".into();
        yaml(&merged, 0, &mut text);
    }
    text.push_str(&format!(
        "---\n\n# Design system\n\n<!-- impose:adopted-draft {key} -->\n\n## Do's and Don'ts\n\n"
    ));
    for guide in draft["guidance"].as_array().into_iter().flatten() {
        text.push_str(&format!(
            "- {}\n",
            guide["statement"].as_str().unwrap_or("")
        ));
    }
    for entry in draft["entries"].as_array().into_iter().flatten() {
        for rule in entry
            .get("system")
            .or_else(|| entry.get("grammar"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            text.push_str(&format!("- {}\n", rule.as_str().unwrap_or("")));
        }
    }
    Ok(text)
}
pub fn verify_bundle(path: &Path) -> Result<()> {
    let manifest = state::read(&path.join("manifest.json"))?;
    let semantic = state::read(&path.join("semantic.json"))?;
    let document = state::read(&path.join("document.json"))?;
    let id = state::digest(&json!({"semantic":semantic,"document":document}));
    if manifest["schemaVersion"] != 1
        || manifest["buildId"] != id
        || path.file_name().and_then(|n| n.to_str()) != Some(id.as_str())
    {
        return Err("Export identity mismatch".into());
    }
    let output = match semantic["format"].as_str() {
        Some("specimen") => "specimen.pdf",
        Some("design") => "DESIGN.md",
        Some("bcp" | "world-theme" | "vernacular") => "document.json",
        _ => return Err("Unknown export format".into()),
    };
    for name in ["semantic.json", "document.json", "validation.json", output] {
        if manifest["files"].get(name).is_none() {
            return Err(format!("Missing export file {name}"));
        }
    }
    if state::read(&path.join("validation.json"))?["valid"] != true {
        return Err("Export validation was not successful".into());
    }
    for (name, hash) in manifest["files"]
        .as_object()
        .ok_or("Invalid export manifest")?
    {
        if name.contains('/') || name.contains('\\') || name == ".." {
            return Err("Invalid bundle filename".into());
        }
        if state::file_hash(&path.join(name))? != hash.as_str().unwrap_or("") {
            return Err(format!("Corrupt export file {name}"));
        }
    }
    Ok(())
}
