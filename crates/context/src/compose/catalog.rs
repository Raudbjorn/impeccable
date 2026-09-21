use super::{
    required,
    state::{self, Result},
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

pub fn validate(draft: &Value, project: &Value) -> Vec<String> {
    let mut errors = Vec::new();
    let Some(entries) = draft["entries"].as_array() else {
        return vec!["draft.entries must be an array".into()];
    };
    let mut ids = HashSet::new();
    let mut forms = HashMap::new();
    for entry in entries {
        let id = entry["id"].as_str().unwrap_or("");
        if id.is_empty()
            || !id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            || !ids.insert(id)
        {
            errors.push(format!("Invalid or duplicate entry ID: {id}"));
        }
        match entry["kind"].as_str() {
            Some("concept") => {
                errors.extend(crate::catalog::validate_concept_entry(entry, &forms));
                forms.insert(
                    crate::catalog::normalize_concept_form(entry.get("form")),
                    id.to_string(),
                );
                if !crate::catalog::WELL_TIERS.contains(&entry["wellTier"].as_str().unwrap_or("")) {
                    errors.push(format!("{id}: invalid wellTier"));
                }
            }
            Some("composition") => {
                for field in ["form", "spark", "webLeverage"] {
                    if required(entry, field).is_err() {
                        errors.push(format!("{id}: missing {field}"));
                    }
                }
                if !["persuade", "operate", "read", "experience"]
                    .contains(&entry["surface"].as_str().unwrap_or(""))
                {
                    errors.push(format!("{id}: invalid surface"));
                }
                if let Some(grain) = entry.get("grain").filter(|v| !v.is_null()) {
                    if !crate::roll_selection::COMPOSITION_GRAINS
                        .contains(&grain.as_str().unwrap_or(""))
                    {
                        errors.push(format!("{id}: invalid grain"));
                    }
                }
                let prefixes = [
                    "Staging/hierarchy:",
                    "Sequence/attention:",
                    "Controls/state:",
                    "Adaptation:",
                ];
                if !entry["grammar"].as_array().is_some_and(|a| {
                    a.len() == 4
                        && a.iter().zip(prefixes).all(|(v, p)| {
                            v.as_str().is_some_and(|s| {
                                s.starts_with(p) && (12..=180).contains(&s.encode_utf16().count())
                            })
                        })
                }) {
                    errors.push(format!("{id}: composition needs four ordered grammar rules, 12–180 characters each"));
                }
            }
            _ => errors.push(format!("{id}: kind must be concept or composition")),
        }
        if required(entry, "familyId").is_err() {
            errors.push(format!("{id}: missing familyId"));
        }
        if let Some(platforms) = entry.get("platforms") {
            if !platforms.as_array().is_some_and(|a| {
                a.iter().all(|p| {
                    crate::roll_selection::COMPOSITION_PLATFORMS.contains(&p.as_str().unwrap_or(""))
                })
            }) {
                errors.push(format!("{id}: invalid platforms"));
            }
        }
        if let Some(terms) = entry.get("vernacular") {
            let allowed = [
                "nav", "menu", "search", "copy", "copied", "home", "index", "section", "item",
                "open", "close", "save", "new", "back", "next", "settings", "help", "empty",
                "loading", "error",
            ];
            if !terms.as_object().is_some_and(|m| {
                m.iter().all(|(k, v)| {
                    allowed.contains(&k.as_str())
                        && v.as_str().is_some_and(|s| {
                            !s.trim().is_empty()
                                && s.chars().count() <= 24
                                && !s.chars().any(char::is_control)
                        })
                })
            }) {
                errors.push(format!("{id}: invalid vernacular terms"));
            }
        }
    }
    for field in ["guidance", "claims", "evidence"] {
        if draft.get(field).is_some_and(|v| !v.is_array()) {
            errors.push(format!("{field} must be an array"));
        }
    }
    for guide in draft["guidance"].as_array().into_iter().flatten() {
        if !["principle", "constraint", "verbal", "medium"]
            .contains(&guide["kind"].as_str().unwrap_or(""))
            || required(guide, "statement").is_err()
            || !guide["appliesTo"].as_array().is_some_and(|a| {
                !a.is_empty()
                    && a.iter().all(|v| {
                        ["world", "composition", "vernacular", "review", "copy"]
                            .contains(&v.as_str().unwrap_or(""))
                    })
            })
        {
            errors.push("Guidance needs kind, statement, and appliesTo".into());
        }
    }
    for claim in draft["claims"].as_array().into_iter().flatten() {
        if !["observed", "inferred", "adapted", "unsupported"]
            .contains(&claim["kind"].as_str().unwrap_or(""))
            || required(claim, "statement").is_err()
        {
            errors.push("Claim needs an explicit qualification and statement".into());
        }
        if claim
            .get("confidenceLabel")
            .is_some_and(|v| !["High", "Medium", "Low"].contains(&v.as_str().unwrap_or("")))
        {
            errors.push("Confidence labels are High, Medium, Low, never probabilities".into());
        }
        // A claim's attributed citation is not a verified page link.
        if claim.get("page").is_some()
            || claim.get("span").is_some()
            || claim.get("confirmed").is_some()
        {
            errors.push("Use source proposal/review for verified links; claims only carry attributed citations".into());
        }
    }
    for evidence in draft["evidence"].as_array().into_iter().flatten() {
        let source = evidence["sourceId"].as_str().unwrap_or("");
        if project["sources"].get(source).is_none() {
            errors.push(format!("Unknown evidence source: {source}"));
        }
        if evidence.get("page").is_some() || evidence.get("span").is_some() {
            errors.push("Page/span evidence must come from a reviewed source proposal".into());
        }
    }
    if draft.get("tokens").is_some_and(|v| !v.is_object()) {
        errors.push("tokens must be an object".into());
    }
    errors
}

pub fn load_draft(cwd: &Path, key: &str) -> Result<Value> {
    state::retained(&state::root(cwd).join("drafts"), key)
}
pub fn review<'a>(project: &'a Value, key: &str) -> Option<&'a Value> {
    project["reviews"]
        .as_array()?
        .iter()
        .rev()
        .find(|r| r["draftId"] == key)
}
pub fn approved(project: &Value, key: &str, policy: &str) -> bool {
    review(project, key).is_some_and(|r| {
        r["verdict"] == "approved" && (r["authority"] == "human" || policy == "human-and-machine")
    })
}
pub fn pools(cwd: &Path, project: &Value, policy: &str) -> Result<(Vec<Value>, Vec<Value>)> {
    let mut by_id: std::collections::BTreeMap<String, (Value, Value, String)> =
        std::collections::BTreeMap::new();
    for (key, status) in project["drafts"]
        .as_object()
        .ok_or("Invalid project drafts")?
    {
        if status["valid"] != true || !approved(project, key, policy) {
            continue;
        }
        let draft = load_draft(cwd, key)?;
        let decision = review(project, key).ok_or("Missing draft review")?.clone();
        for entry in draft["entries"].as_array().ok_or("Invalid draft entries")? {
            let id = required(entry, "id")?;
            if let Some((existing, old_review, _)) = by_id.get(id) {
                if existing != entry {
                    return Err(format!(
                        "Conflicting approved definitions for {id}; reject the superseded draft"
                    ));
                }
                if old_review["authority"] == "human" {
                    continue;
                }
            }
            by_id.insert(
                id.to_string(),
                (entry.clone(), decision.clone(), key.clone()),
            );
        }
    }
    let mut concepts = vec![];
    let mut compositions = vec![];
    let evidence = super::assessment::evidence(project, None);
    for (id, (mut entry, decision, key)) in by_id {
        entry["status"] = json!("approved");
        entry["review"] = decision;
        entry["draftId"] = json!(key);
        let trail: Vec<_> = evidence
            .as_array()
            .into_iter()
            .flatten()
            .filter(|e| e["entryId"] == id && e["draftId"] == key)
            .cloned()
            .collect();
        entry["evidence"] = json!(trail);
        let mut references = vec![];
        for e in &trail {
            if let Some(run) = e["runId"].as_str() {
                let output = state::read(
                    &state::root(cwd)
                        .join("runs")
                        .join(format!("{}.json", state::id(run)?)),
                )?;
                if let Some(page) = output["output"]["pages"]
                    .as_array()
                    .and_then(|pages| pages.iter().find(|p| p["page"] == e["page"]))
                {
                    if let Some(path) = page["render"].as_str() {
                        if state::file_hash(Path::new(path))?
                            != page["renderHash"].as_str().unwrap_or("")
                        {
                            return Err("Source render changed; re-extract before selection".into());
                        }
                        references.push(json!({"path":path,"kind":"source-page","label":format!("Source page {} ({})",e["page"],e["acceptance"].as_str().unwrap_or("qualified evidence"))}));
                    }
                }
            }
        }
        entry["references"] = json!(references);
        if entry["kind"] == "concept" {
            concepts.push(entry);
        } else {
            compositions.push(entry);
        }
    }
    Ok((concepts, compositions))
}
