//! Source-to-design processing with explicit provenance and project-local state.
pub mod assessment;
pub mod catalog;
mod export;
pub mod selection;
pub mod state;
mod worker;
use serde_json::{json, Value};
use state::Result;
use std::{fs, path::Path};

pub fn required<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("{key} must be a nonempty string"))
}
pub fn nonce() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}
fn array_push(v: &mut Value, key: &str, item: Value) -> Result<()> {
    v[key]
        .as_array_mut()
        .ok_or_else(|| format!("Invalid project {key}"))?
        .push(item);
    Ok(())
}

pub fn execute(cwd: &Path, command: &str, input: &Value) -> Result<Value> {
    if !input.is_object() {
        return Err("Command input must be a JSON object".into());
    }
    if command == "setup" {
        return worker::setup(cwd, input);
    }
    if command == "verify" {
        return assessment::verify(cwd, input["deep"] == true);
    }
    if command == "assess" {
        return assessment::assess(cwd, input);
    }
    if command == "select" {
        return selection::handle(cwd, input);
    }
    let _lock = state::Lock::acquire(cwd)?;
    let (_, mut project) = state::load(cwd)?;
    if command == "export" {
        return export::run(cwd, &project, input);
    }
    let mut result = match command {
        "source" => source(cwd, &mut project, input)?,
        "derive" => {
            let source_id = required(input, "sourceId")?;
            if input["refresh"] == true {
                let source = project["sources"]
                    .get_mut(source_id)
                    .ok_or("Unknown sourceId")?;
                if source["kind"] != "url" {
                    return Err(
                        "refresh applies only to URL captures; register changed local sources"
                            .into(),
                    );
                }
                source["captureRevision"] = json!(nonce().to_string());
            }
            let source = project["sources"]
                .get(source_id)
                .ok_or("Unknown sourceId")?;
            if source["kind"] != "url" {
                let fresh = source_fingerprint(Path::new(required(source, "path")?))?;
                if fresh != source["contentHash"] {
                    return Err(
                        "Source changed; register its new revision before processing".into(),
                    );
                }
            }
            let mut registered = source.clone();
            registered
                .as_object_mut()
                .ok_or("Invalid source")?
                .remove("run");
            registered
                .as_object_mut()
                .unwrap()
                .remove("runWorkerRevision");
            let request = json!({"op":"extract","source":registered,"ocr":input["ocr"] == true,"pixelCap":4_000_000,"outputDir":state::root(cwd).join("renders").join(source_id)});
            let identity =
                state::digest(&json!({"request":request,"worker":worker::extract_revision()}));
            let run_path = state::root(cwd)
                .join("runs")
                .join(format!("{identity}.json"));
            let run = if run_path.exists() {
                let saved = state::read(&run_path)?;
                if saved["inputHash"] != identity
                    || saved["outputHash"] != state::digest(&saved["output"])
                {
                    return Err("Corrupt extraction run".into());
                }
                saved
            } else {
                match worker::extract(cwd, &request) {
                    Ok(output) => {
                        if source["kind"] != "url"
                            && source_fingerprint(Path::new(required(source, "path")?))?
                                != source["contentHash"]
                        {
                            return Err(
                                "Source changed during extraction; results were not published"
                                    .into(),
                            );
                        }
                        let run = json!({"schemaVersion":1,"inputHash":identity,"sourceId":source_id,"sourceHash":output["sourceHash"],"workerRevision":worker::extract_revision(),"outputHash":state::digest(&output),"output":output});
                        state::atomic(&run_path, &state::canonical(&run))?;
                        run
                    }
                    Err(error) => {
                        state::retain(
                            &state::root(cwd).join("failures"),
                            &json!({"request":request,"error":error,"at":nonce().to_string()}),
                        )?;
                        return Err(error);
                    }
                }
            };
            project["sources"][source_id]["run"] = json!(identity);
            project["sources"][source_id]["runWorkerRevision"] = json!(worker::extract_revision());
            json!({"runId":identity,"output":run["output"]})
        }
        "validate" => {
            let draft = input.get("draft").ok_or("draft is required")?;
            let key = state::retain(&state::root(cwd).join("drafts"), draft)?;
            let errors = catalog::validate(draft, &project);
            project["drafts"][&key] = json!({"valid":errors.is_empty(),"errors":errors});
            json!({"draftId":key,"valid":errors.is_empty(),"errors":errors})
        }
        "review" => {
            let actor = required(input, "actor")?;
            let authority = required(input, "authority")?;
            let verdict = required(input, "verdict")?;
            required(input, "reason")?;
            if !["human", "machine"].contains(&authority)
                || !["approved", "rejected"].contains(&verdict)
            {
                return Err("Invalid review authority or verdict".into());
            }
            if let Some(proposal) = input["proposalId"].as_str() {
                let proposed = project["proposals"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|p| p["id"] == proposal)
                    .ok_or("Unknown proposalId")?;
                if authority == "human" && proposed["actor"] == actor {
                    return Err(
                        "A proposing actor cannot be recorded as independent human confirmation"
                            .into(),
                    );
                }
                let mut record = input.clone();
                record["proposal"] = proposed.clone();
                record["id"] = json!(state::digest(input));
                record["acceptance"] = json!(if authority == "machine" {
                    "machine assessment; not human confirmation"
                } else if input["bulk"] == true {
                    "human bulk acceptance of machine pre-screen"
                } else {
                    "human page review"
                });
                array_push(&mut project, "decisions", record.clone())?;
                record
            } else {
                let key = required(input, "draftId")?;
                let draft = catalog::load_draft(cwd, key)?;
                if verdict == "approved" && !catalog::validate(&draft, &project).is_empty() {
                    return Err("Invalid drafts cannot be approved".into());
                }
                if project["drafts"].get(key).is_none() {
                    return Err("Validate this draft before reviewing it".into());
                }
                let mut record = input.clone();
                record["contentHash"] = json!(state::digest(&draft));
                record["id"] = json!(state::digest(input));
                if project["reviews"].as_array().unwrap().last() != Some(&record) {
                    array_push(&mut project, "reviews", record.clone())?;
                }
                record
            }
        }
        "adopt" => {
            let key = required(input, "draftId")?;
            let policy = input["approvalPolicy"].as_str().unwrap_or("human");
            selection::policy(policy)?;
            if !catalog::approved(&project, key, policy) {
                return Err("Adoption requires an eligible content-bound approval".into());
            }
            let draft = catalog::load_draft(cwd, key)?;
            assessment::validate_exceptions(input.get("exceptions"))?;
            required(input, "reason")?;
            for adoption in project["adoptions"].as_array().unwrap() {
                let previous = catalog::load_draft(cwd, required(adoption, "draftId")?)?;
                for (name, value) in draft["tokens"]
                    .as_object()
                    .into_iter()
                    .flatten()
                    .filter(|_| input["replace"] != true)
                {
                    if previous["tokens"].get(name).is_some_and(|old| old != value) {
                        return Err(format!("Conflicting adopted token {name}; supply a resolved draft using adopt with replace:true"));
                    }
                }
            }
            let mut adoption = input.clone();
            adoption["reviewId"] = catalog::review(&project, key).unwrap()["id"].clone();
            adoption["id"] = json!(state::digest(&adoption));
            if input["replace"] == true {
                project["adoptions"] = json!([]);
            }
            array_push(&mut project, "adoptions", adoption.clone())?;
            assessment::effective_design_system(cwd, &project)?;
            adoption
        }
        _ => return Err(format!("Unknown compose command: {command}")),
    };
    result["revision"] = json!(state::save(cwd, &project)?);
    Ok(result)
}

fn source(cwd: &Path, project: &mut Value, input: &Value) -> Result<Value> {
    if input["op"] == "propose" {
        let key = required(input, "sourceId")?;
        let source = project["sources"].get(key).ok_or("Unknown sourceId")?;
        let run = state::read(
            &state::root(cwd)
                .join("runs")
                .join(format!("{}.json", state::id(required(source, "run")?)?)),
        )?;
        if run["outputHash"] != state::digest(&run["output"]) {
            return Err("Corrupt extraction run".into());
        }
        let page = input["page"]
            .as_u64()
            .filter(|n| *n > 0)
            .ok_or("page must be a positive integer")?;
        let observed = run["output"]["pages"]
            .as_array()
            .ok_or("Source has no extracted pages")?
            .iter()
            .find(|p| p["page"].as_u64() == Some(page))
            .ok_or("No such extracted source page")?;
        if let Some(span) = input.get("span") {
            if !observed["spans"]
                .as_array()
                .is_some_and(|a| a.iter().any(|s| &s["id"] == span))
            {
                return Err("No such extracted source span".into());
            }
        }
        required(input, "actor")?;
        let draft = catalog::load_draft(cwd, required(input, "draftId")?)?;
        if !draft["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["id"] == input["entryId"])
        {
            return Err("Unknown proposal entryId".into());
        }
        let mut proposal = input.clone();
        proposal["sourceHash"] = run["sourceHash"].clone();
        proposal["runId"] = source["run"].clone();
        proposal["id"] = json!(state::digest(&proposal));
        if !project["proposals"].as_array().unwrap().contains(&proposal) {
            array_push(project, "proposals", proposal.clone())?;
        }
        return Ok(proposal);
    }
    if input.get("op").is_some_and(|op| op != "register") {
        return Err("Source op must be register or propose".into());
    }
    let target = required(input, "target")?;
    let kind = required(input, "kind")?;
    if !["pdf", "url", "images", "structured"].contains(&kind) {
        return Err("kind must be pdf, url, images, or structured".into());
    }
    let record = if kind == "url" {
        if !(target.starts_with("https://") || target.starts_with("http://")) {
            return Err("Source URL must use HTTP(S)".into());
        }
        // Capture is explicit. The URI hash is an identity, never a claim about remote content.
        json!({"kind":kind,"url":target,"contentHash":null,"identityHash":state::hash(target.as_bytes()),"state":"not-captured"})
    } else {
        let path = cwd.join(target).canonicalize().map_err(|e| e.to_string())?;
        if (kind == "images") != path.is_dir() {
            return Err("images requires a directory; other source kinds require a file".into());
        }
        json!({"kind":kind,"path":path,"contentHash":source_fingerprint(&path)?,"state":"registered"})
    };
    let key = state::digest(&record);
    if project["sources"].get(&key).is_none() {
        project["sources"][&key] = record.clone();
    }
    Ok(json!({"sourceId":key,"source":record}))
}
pub fn source_fingerprint(path: &Path) -> Result<String> {
    if !path.is_dir() {
        return state::file_hash(path);
    }
    let mut files = std::collections::BTreeMap::new();
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_file() {
            files.insert(
                entry.file_name().to_string_lossy().to_string(),
                state::file_hash(&entry.path())?,
            );
        }
        if files.len() > 10000 {
            return Err("Source folder exceeds 10000 files".into());
        }
    }
    Ok(state::digest(&json!(files)))
}
pub fn run(args: &[String], io: &mut impeccable_common::Io) -> i32 {
    if args.is_empty() || args[0] == "--help" {
        io.out("impeccable compose <setup|source|derive|validate|review|adopt|select|export|assess|verify> [--input file|-]\nCommands accept one JSON object on stdin or --input. See reference/compose.md.\n");
        return 0;
    }
    if args.len() == 3 && args[1] == "--project-root" {
        let root = io.cwd.join(&args[2]);
        let text = io.stdin();
        let input = serde_json::from_str(text).map_err(|e| e.to_string());
        return match input.and_then(|input| execute(&root, &args[0], &input)) {
            Ok(value) => {
                io.out(&format!("{value}\n"));
                0
            }
            Err(error) => {
                io.err(&format!("{error}\n"));
                1
            }
        };
    }
    let input = if args.len() == 3 && args[1] == "--input" && args[2] != "-" {
        state::read(&io.cwd.join(&args[2]))
    } else if args.len() == 1 || (args.len() == 3 && args[1] == "--input" && args[2] == "-") {
        let text = io.stdin();
        if text.trim().is_empty() {
            Ok(json!({}))
        } else {
            serde_json::from_str(text).map_err(|e| e.to_string())
        }
    } else {
        Err("Use --input file or JSON stdin".into())
    };
    match input.and_then(|v| execute(&io.cwd, &args[0], &v)) {
        Ok(value) => {
            let failed = value["valid"] == false;
            io.out(&format!(
                "{}\n",
                serde_json::to_string_pretty(&value).unwrap()
            ));
            i32::from(failed)
        }
        Err(error) => {
            io.err(&format!("{}\n", json!({"error":error})));
            1
        }
    }
}
