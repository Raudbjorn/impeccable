use super::{
    required,
    state::{self, Result},
};
use serde_json::{json, Value};
use std::path::Path;

pub fn rubric_revision() -> String {
    const SOURCES: &[&str] = &[
        include_str!("../../../../skill/scripts/data/critique-evidence/heuristic-01-visibility-of-system-status.json"),
        include_str!("../../../../skill/scripts/data/critique-evidence/heuristic-02-match-real-world.json"),
        include_str!("../../../../skill/scripts/data/critique-evidence/heuristic-03-user-control-and-freedom.json"),
        include_str!("../../../../skill/scripts/data/critique-evidence/heuristic-04-consistency-and-standards.json"),
        include_str!("../../../../skill/scripts/data/critique-evidence/heuristic-05-error-prevention.json"),
        include_str!("../../../../skill/scripts/data/critique-evidence/heuristic-06-recognition-rather-than-recall.json"),
        include_str!("../../../../skill/scripts/data/critique-evidence/heuristic-07-flexibility-and-efficiency.json"),
        include_str!("../../../../skill/scripts/data/critique-evidence/heuristic-08-aesthetic-and-minimalist-design.json"),
        include_str!("../../../../skill/scripts/data/critique-evidence/heuristic-09-error-recovery.json"),
        include_str!("../../../../skill/scripts/data/critique-evidence/heuristic-10-help-and-documentation.json"),
        include_str!("../../../../skill/scripts/data/critique-evidence/detector-items.json"),
        include_str!("../../../../skill/scripts/score-evidence.mjs"),
    ];
    state::digest(&json!(SOURCES))
}
pub fn comparable(a: &Value, b: &Value) -> bool {
    [
        "rubric_revision",
        "max_score",
        "observation",
        "observation_context",
        "target_identity",
    ]
    .iter()
    .all(|key| {
        a.get(*key).is_some_and(|value| {
            !value.is_null() && value != "unassessed" && b.get(*key) == Some(value)
        })
    })
}

pub fn validate_exceptions(exceptions: Option<&Value>) -> Result<()> {
    let Some(exceptions) = exceptions else {
        return Ok(());
    };
    for exception in exceptions.as_array().ok_or("exceptions must be an array")? {
        let rule = required(exception, "rule")?;
        let known =
            impeccable_core::registry::get_antipattern(rule).ok_or("Unknown exception rule")?;
        if known.category != "slop" {
            return Err(format!(
                "Only stylistic slop rules may receive composition exceptions: {rule}"
            ));
        }
        required(exception, "reason")?;
        required(exception, "selector")?;
        required(exception, "target")?;
    }
    Ok(())
}
pub fn evidence(project: &Value, draft: Option<&str>) -> Value {
    let mut latest = std::collections::BTreeMap::new();
    for decision in project["decisions"].as_array().into_iter().flatten() {
        if let Some(id) = decision["proposalId"].as_str() {
            latest.insert(id, decision);
        }
    }
    json!(latest.values().filter(|d| d["verdict"]=="approved" && draft.is_none_or(|k| d["proposal"]["draftId"]==k)).map(|d| json!({"draftId":d["proposal"]["draftId"],"runId":d["proposal"]["runId"],"sourceId":d["proposal"]["sourceId"],"sourceHash":d["proposal"]["sourceHash"],"entryId":d["proposal"]["entryId"],"page":d["proposal"]["page"],"span":d["proposal"]["span"],"authority":d["authority"],"acceptance":d["acceptance"],"reason":d["reason"]})).collect::<Vec<_>>())
}
pub fn active_adoption(project: &Value, adoption: &Value) -> bool {
    adoption["draftId"]
        .as_str()
        .and_then(|key| super::catalog::review(project, key))
        .is_some_and(|review| {
            review["verdict"] == "approved" && review["id"] == adoption["reviewId"]
        })
}
pub fn verify(cwd: &Path, deep: bool) -> Result<Value> {
    let (revision, project) = state::load(cwd)?;
    let mut findings = vec![];
    for (key, source) in project["sources"].as_object().ok_or("Invalid sources")? {
        if let Some(path) = source["path"].as_str() {
            if !Path::new(path).exists() {
                findings.push(json!({"id":"compose-source-missing","sourceId":key,"path":path}));
            } else if deep {
                match super::source_fingerprint(Path::new(path)) { Ok(hash) if source["contentHash"]==hash=>{}, other=>findings.push(json!({"id":"compose-source-drift","sourceId":key,"detail":format!("{other:?}")})) }
            }
        }
        if let Some(run) = source["run"].as_str() {
            let path = state::root(cwd)
                .join("runs")
                .join(format!("{}.json", state::id(run)?));
            if !deep {
                if !path.is_file()
                    || source["runWorkerRevision"] != super::worker::extract_revision()
                {
                    findings
                        .push(json!({"id":"compose-processing-drift","sourceId":key,"runId":run}));
                }
                continue;
            }
            match state::read(&path) {
                Ok(value)
                    if value["schemaVersion"] == 1
                        && value["workerRevision"] == super::worker::extract_revision()
                        && (!deep || value["outputHash"] == state::digest(&value["output"])) =>
                {
                    if deep {
                        for page in value["output"]["pages"].as_array().into_iter().flatten() {
                            if let Some(path) = page["render"].as_str() {
                                if state::file_hash(Path::new(path)).ok().as_deref()
                                    != page["renderHash"].as_str()
                                {
                                    findings.push(json!({"id":"compose-render-drift","sourceId":key,"page":page["page"]}));
                                }
                            }
                        }
                    }
                }
                _ => findings
                    .push(json!({"id":"compose-processing-drift","sourceId":key,"runId":run})),
            }
        }
    }
    for adoption in project["adoptions"].as_array().into_iter().flatten() {
        if !active_adoption(&project, adoption) {
            findings
                .push(json!({"id":"compose-adoption-review-drift","adoptionId":adoption["id"]}));
        }
    }
    if deep {
        for key in project["drafts"]
            .as_object()
            .ok_or("Invalid drafts")?
            .keys()
        {
            if let Err(error) = super::catalog::load_draft(cwd, key) {
                findings.push(json!({"id":"compose-draft-corrupt","draftId":key,"error":error}));
            }
        }
        let exports = state::root(cwd).join("exports");
        if exports.exists() {
            for entry in std::fs::read_dir(exports).map_err(|e| e.to_string())? {
                let path = entry.map_err(|e| e.to_string())?.path();
                if path
                    .file_name()
                    .is_some_and(|n| !n.to_string_lossy().starts_with('.'))
                {
                    if let Err(error) = super::export::verify_bundle(&path) {
                        findings
                            .push(json!({"id":"compose-export-corrupt","path":path,"error":error}));
                    }
                }
            }
        }
    }
    Ok(json!({"valid":findings.is_empty(),"revision":revision,"deep":deep,"findings":findings}))
}
pub fn drift(cwd: &str, deep: bool) -> Vec<crate::staleness::Finding> {
    let root = Path::new(cwd);
    if !state::root(root).join("current.json").exists() {
        return vec![];
    }
    let report = verify(root, deep)
        .unwrap_or_else(|error| json!({"findings":[{"id":"compose-state-invalid","error":error}]}));
    report["findings"].as_array().into_iter().flatten().map(|f| crate::staleness::finding(f["id"].as_str().unwrap_or("compose-drift"),"Compose",Some(state::root(root).to_string_lossy().into()),"mention",f.to_string(),"Run impeccable compose verify with {\"deep\":true}; register changed sources and review new drafts explicitly.".into())).collect()
}
pub fn assess(cwd: &Path, input: &Value) -> Result<Value> {
    let (_, project) = state::load(cwd)?;
    let target = required(input, "target")?;
    let observation = required(input, "observation")?;
    if ![
        "source-text",
        "static-dom",
        "browser",
        "interaction",
        "comp-diff",
    ]
    .contains(&observation)
    {
        return Err("Invalid observation kind".into());
    }
    if ["browser", "interaction"].contains(&observation) && input.get("findings").is_none() {
        return Err("Browser and interaction assessments require captured findings, including an explicit empty array for a clean capture".into());
    }
    let mut warnings = Vec::new();
    let measured = if input.get("findings").is_none()
        && ["source-text", "static-dom"].contains(&observation)
    {
        let path = cwd.join(target);
        let bytes = state::bytes(&path)?;
        let content = std::str::from_utf8(&bytes).map_err(|e| e.to_string())?;
        let ds = effective_design_system(cwd, &project)?;
        let found = if observation == "static-dom" {
            use impeccable_detect::engines::HtmlEngine;
            impeccable_html::StaticHtmlEngine {
                static_rule_pack: None,
            }
            .detect_html(
                &path.to_string_lossy(),
                &impeccable_detect::engines::ScanOptions {
                    inline_ignores: false,
                    design_system: ds.map(std::rc::Rc::new),
                    ..Default::default()
                },
                &mut warnings,
            )
            .map_err(|e| e.message)?
        } else {
            impeccable_detect::detect_text::detect_text(
                content,
                &path.to_string_lossy(),
                &impeccable_detect::detect_text::TextOptions {
                    inline_ignores: false,
                    design_system: ds.as_ref(),
                    ..Default::default()
                },
            )
        };
        serde_json::to_value(found).map_err(|e| e.to_string())?
    } else {
        input.get("findings").cloned().unwrap_or(json!([]))
    };
    let findings = measured
        .as_array()
        .ok_or("findings must be an array of engine observations")?;
    let mut annotated = vec![];
    for finding in findings {
        let mut result = finding.clone();
        if !result.is_object() {
            return Err("Each finding must be an object".into());
        }
        result["observation"] = json!(observation);
        let rule = finding
            .get("antipattern")
            .or_else(|| finding.get("rule"))
            .or_else(|| finding.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("");
        for adoption in project["adoptions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|a| active_adoption(&project, a))
        {
            for exception in adoption["exceptions"].as_array().into_iter().flatten() {
                // Exact detector-emitted selectors only: text matches cannot establish DOM scope.
                if observation != "source-text"
                    && exception["rule"] == rule
                    && exception["target"] == target
                    && finding
                        .get("selector")
                        .is_some_and(|s| s == &exception["selector"])
                {
                    result["compositionException"] = json!({"status":"accepted-style","reason":exception["reason"],"adoptionId":adoption["id"]});
                }
            }
        }
        annotated.push(result);
    }
    let mut hashes = json!({});
    if input.get("findings").is_none() && ["source-text", "static-dom"].contains(&observation) {
        hashes["targetFile"] =
            json!({"path":cwd.join(target),"hash":state::file_hash(&cwd.join(target))?});
    }
    for field in ["spec", "comp", "build", "targetFile"] {
        if let Some(path) = input[field].as_str() {
            hashes[field] =
                json!({"path":cwd.join(path),"hash":state::file_hash(&cwd.join(path))?});
        }
    }
    let comparison = if observation == "comp-diff" {
        let comp = impeccable_comp::png_io::load_raster(&cwd.join(required(input, "comp")?))?.0;
        let build = impeccable_comp::png_io::load_raster(&cwd.join(required(input, "build")?))?.0;
        let spec = state::read(&cwd.join(required(input, "spec")?))?;
        let compared = impeccable_comp_verbs::comp_diff::compare(
            &comp.image,
            &build.image,
            Some(&spec),
            "contain",
            target,
            None,
        );
        impeccable_comp_verbs::comp_diff::build_report(
            &compared,
            None,
            &json!({"artifacts":hashes,"projectRevision":state::digest(&project)}),
        )
    } else {
        Value::Null
    };
    let result = json!({"schemaVersion":1,"target":target,"observation":observation,"projectRevision":state::digest(&project),"artifacts":hashes,"findings":annotated,"warnings":warnings,"comparison":comparison,"evidence":evidence(&project,None),"note":"Findings retain their detector verdict; composition exceptions do not establish accessibility compliance."});
    let _lock = state::Lock::acquire(cwd)?;
    let id = state::retain(&state::root(cwd).join("assessments"), &result)?;
    Ok(json!({"assessmentId":id,"report":result}))
}

pub fn effective_design_system(
    cwd: &Path,
    project: &Value,
) -> Result<Option<impeccable_detect::design_system::DesignSystem>> {
    use impeccable_detect::design_system as ds;
    let existing = ds::load_design_system_for_cwd(&cwd.to_string_lossy());
    if project["adoptions"].as_array().is_none_or(|a| a.is_empty()) {
        return Ok(existing);
    }
    let mut front = existing
        .as_ref()
        .and_then(|d| d.source_path.as_deref())
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| ds::parse_frontmatter(&s))
        .unwrap_or_default();
    for adoption in project["adoptions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| active_adoption(project, a))
    {
        let key = required(adoption, "draftId")?;
        let draft = super::catalog::load_draft(cwd, key)?;
        let md = super::export::design_markdown(&draft, key)?;
        let adopted = ds::parse_frontmatter(&md).ok_or("Invalid adopted design tokens")?;
        for group in ["colors", "typography", "rounded", "spacing", "components"] {
            if let Some(items) = adopted.get(group).and_then(Value::as_object) {
                let current = front
                    .entry(group.to_string())
                    .or_insert(json!({}))
                    .as_object_mut()
                    .ok_or("Invalid existing design token group")?;
                for (name, value) in items {
                    if current.get(name).is_some_and(|v| v != value) {
                        return Err(format!("Adopted {group}.{name} conflicts with DESIGN.md; resolve the documented token explicitly"));
                    }
                    current.insert(name.clone(), value.clone());
                }
            }
        }
    }
    let sidecar_path = existing.as_ref().and_then(|d| d.sidecar_path.as_deref());
    let sidecar = sidecar_path
        .map(|p| state::read(Path::new(p)))
        .transpose()?;
    Ok(Some(ds::normalize_design_system(
        Some(&front),
        sidecar.as_ref(),
        existing.as_ref().and_then(|d| d.source_path.as_deref()),
        sidecar_path,
        false,
    )))
}
