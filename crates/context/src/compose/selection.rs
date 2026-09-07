use super::{
    catalog, required,
    state::{self, Result},
};
use serde_json::{json, Value};
use std::{collections::HashSet, path::Path};

const SELECTOR: &str = "compose-lexical-seeded/1";
fn fingerprint() -> String {
    state::digest(&json!([
        include_str!("selection.rs"),
        include_str!("catalog.rs"),
        include_str!("../roll_selection.rs")
    ]))
}
pub fn configuration(
    cwd: &str,
    project: Option<&str>,
) -> Result<Option<crate::retrieval::RetrievalConfig>> {
    let Some(project) = project else {
        return crate::retrieval::retrieval_config(cwd);
    };
    let root = Path::new(cwd)
        .join(project)
        .canonicalize()
        .map_err(|e| format!("Invalid project catalog: {e}"))?;
    if !root.is_dir() {
        return Err(
            "--project-catalog must name the project directory containing .impeccable/compose"
                .into(),
        );
    }
    Ok(Some(crate::retrieval::RetrievalConfig {
        command: vec![
            std::env::current_exe()
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .into(),
            "compose".into(),
            "select".into(),
            "--project-root".into(),
            root.to_string_lossy().into(),
        ],
        timeout_ms: 180_000,
    }))
}
pub fn policy(value: &str) -> Result<()> {
    if ["human", "human-and-machine"].contains(&value) {
        Ok(())
    } else {
        Err("approvalPolicy must be human or human-and-machine".into())
    }
}
fn words(text: &str) -> HashSet<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}
pub fn shortlist(
    mut entries: Vec<Value>,
    brief: &str,
    count: usize,
    families: usize,
    grain: Option<&str>,
) -> (Vec<Value>, bool) {
    let query = words(brief);
    let score = |e: &Value| {
        let text = [
            "name",
            "tags",
            "description",
            "form",
            "spark",
            "system",
            "grammar",
        ]
        .iter()
        .filter_map(|k| e.get(k))
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join(" ");
        words(&text).intersection(&query).count()
    };
    entries.sort_by(|a, b| {
        grain
            .is_some_and(|g| a["grain"] != g)
            .cmp(&grain.is_some_and(|g| b["grain"] != g))
            .then_with(|| score(b).cmp(&score(a)))
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });
    let signal = entries.iter().any(|e| score(e) > 0);
    if !signal {
        return (entries, false);
    }
    let mut selected: Vec<_> = entries.iter().take(count).cloned().collect();
    for entry in entries.iter().skip(count) {
        let present: HashSet<_> = selected
            .iter()
            .filter_map(|e| e["familyId"].as_str())
            .collect();
        if present.len() >= families {
            break;
        }
        if !present.contains(entry["familyId"].as_str().unwrap_or("")) {
            selected.push(entry.clone());
        }
    }
    (selected, true)
}
fn normalized_settings(input: &Value) -> Result<Value> {
    let mut s = json!({"key":"","scope":"surface","mode":null,"grain":null,"platform":null,"candidateCount":7,"approvalPolicy":"human","strategy":"seeded"});
    if let Some(m) = input.as_object() {
        for (k, v) in m {
            if s.get(k).is_none() {
                return Err(format!("Unknown selection setting: {k}"));
            }
            s[k] = v.clone();
        }
    }
    let key = required(&s, "key")?;
    if key.len() != 8 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("key must have eight hexadecimal digits".into());
    }
    if !["surface", "direction"].contains(&required(&s, "scope")?) {
        return Err("Invalid scope".into());
    }
    for (field, allowed) in [
        ("mode", crate::catalog::SEED_MODES.as_slice()),
        (
            "grain",
            crate::roll_selection::COMPOSITION_GRAINS.as_slice(),
        ),
        (
            "platform",
            crate::roll_selection::COMPOSITION_PLATFORMS.as_slice(),
        ),
    ] {
        if !s[field].is_null() && !allowed.contains(&s[field].as_str().unwrap_or("")) {
            return Err(format!("Invalid {field}"));
        }
    }
    if !s["candidateCount"]
        .as_u64()
        .is_some_and(|n| (5..=7).contains(&n))
    {
        return Err("candidateCount must be 5–7".into());
    }
    policy(required(&s, "approvalPolicy")?)?;
    if !["seeded", "ranked-1"].contains(&required(&s, "strategy")?) {
        return Err("strategy must be seeded or ranked-1 (experimental)".into());
    }
    Ok(s)
}
pub fn handle(cwd: &Path, input: &Value) -> Result<Value> {
    if input.get("protocol").is_some_and(|p| p != 1) {
        return Err("Unsupported selection protocol".into());
    }
    let op = input["op"].as_str().unwrap_or("start");
    if !["start", "round", "replay", "choose"].contains(&op) {
        return Err("Invalid selection operation".into());
    }
    let _lock = state::Lock::acquire(cwd)?;
    let sessions = state::root(cwd).join("sessions");
    let (session_id, session) = if op == "start" {
        let brief = required(input, "brief")?;
        if brief.len() > 12000 {
            return Err("brief exceeds 12000 UTF-8 bytes".into());
        }
        let settings = normalized_settings(&input["settings"])?;
        let (revision, project) = state::load(cwd)?;
        let (mut concepts, mut compositions) =
            catalog::pools(cwd, &project, required(&settings, "approvalPolicy")?)?;
        let mode = settings["mode"].as_str();
        let platform = settings["platform"].as_str();
        let wanted = if settings["scope"] == "direction" {
            "world"
        } else {
            "composition"
        };
        concepts.retain(|c| {
            (c["strength"] == "dual" || c["strength"] == wanted)
                && mode.is_none_or(|m| {
                    c["review"]["allowedModes"]
                        .as_array()
                        .is_none_or(|a| a.is_empty() || a.iter().any(|v| v == m))
                })
                && platform.is_none_or(|p| {
                    c["platforms"]
                        .as_array()
                        .is_none_or(|a| a.is_empty() || a.iter().any(|v| v == p))
                })
        });
        compositions.retain(|c| {
            mode.is_none_or(|m| c["surface"] == m)
                && platform.is_none_or(|p| {
                    c["platforms"]
                        .as_array()
                        .is_none_or(|a| a.is_empty() || a.iter().any(|v| v == p))
                })
        });
        let mut candidates = vec![];
        let mut signals = vec![];
        for tier in crate::catalog::WELL_TIERS {
            let mut pool: Vec<_> = concepts
                .iter()
                .filter(|c| c["wellTier"] == tier)
                .cloned()
                .collect();
            if pool.iter().any(|c| c["review"]["breadth"] != "niche") {
                pool.retain(|c| c["review"]["breadth"] != "niche");
            }
            let (pool, signal) = shortlist(
                pool,
                brief,
                settings["candidateCount"].as_u64().unwrap() as usize,
                2,
                None,
            );
            candidates.extend(pool);
            signals.push(signal);
        }
        if compositions
            .iter()
            .any(|c| c["review"]["breadth"] != "niche")
        {
            compositions.retain(|c| c["review"]["breadth"] != "niche");
        }
        let (compositions, signal) =
            shortlist(compositions, brief, 20, 3, settings["grain"].as_str());
        signals.push(signal);
        if candidates.is_empty() || compositions.is_empty() {
            return Err("No eligible project candidates; validate and review drafts, or select human-and-machine explicitly".into());
        }
        let session = json!({"settings":settings,"brief":brief,"revision":revision,"selector":fingerprint(),"concepts":candidates,"compositions":compositions,"lexicalSignal":signals});
        let id = state::retain(&sessions, &session)?;
        (id, session)
    } else {
        let id = required(input, "session")?;
        (id.to_string(), state::retained(&sessions, id)?)
    };
    if let Some(settings) = input["settings"].as_object() {
        for (k, v) in settings {
            if session["settings"].get(k) != Some(v) {
                return Err(format!("Session {k} is fixed; start a new session"));
            }
        }
    }
    let round = input
        .get("round")
        .map(|v| v.as_u64().ok_or("round must be a nonnegative integer"))
        .transpose()?
        .unwrap_or(0);
    if round > 1000 || (op == "start" && round != 0) {
        return Err("Invalid round (0–1000; start requires zero)".into());
    }
    let register = input["register"].as_str();
    if !input["register"].is_null() && register.is_none() {
        return Err("Invalid register".into());
    }
    if register.is_some_and(|r| {
        !["safer", "bolder"].contains(&r)
            || round == 0
            || session["settings"]["scope"] != "direction"
    }) {
        return Err("register requires a steered direction reroll".into());
    }
    let path = sessions.join(&session_id).join(format!(
        "round-{round}-{}.json",
        register.unwrap_or("normal")
    ));
    if path.exists() {
        let saved = state::read(&path)?;
        if saved["hash"] != state::digest(&saved["response"]) {
            return Err("Corrupt saved round".into());
        }
        if op == "choose" {
            let entry = required(input, "entry")?;
            let record = &saved["response"]["record"];
            if !["challengers", "compositions"].iter().any(|k| {
                record[*k]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|c| c["id"] == entry))
            }) {
                return Err("Choice must belong to this exact round".into());
            }
            if !["assigned", "pick", "challenger", "canon"].contains(&required(input, "kind")?) {
                return Err("Invalid choice kind".into());
            }
            let choice = state::retain(&sessions.join(&session_id).join("choices"), input)?;
            return Ok(json!({"protocol":1,"recorded":true,"choiceId":choice}));
        }
        return Ok(saved["response"].clone());
    }
    if op == "replay" || op == "choose" {
        return Err("No saved round; replay never runs selection".into());
    }
    if session["selector"] != fingerprint() {
        return Err("Selection code changed; replay a saved round or start a new session".into());
    }
    let s = &session["settings"];
    let scope = required(s, "scope")?;
    let key = required(s, "key")?;
    let concepts = session["concepts"]
        .as_array()
        .ok_or("Invalid session concepts")?;
    let compositions = session["compositions"]
        .as_array()
        .ok_or("Invalid session compositions")?;
    let picks = crate::roll_selection::select_approved_challengers(
        scope,
        key,
        round as usize,
        s["mode"].as_str(),
        concepts,
    )?
    .picks;
    let dealt = if s["strategy"] == "ranked-1" {
        ranked(
            compositions,
            key,
            scope,
            round as usize,
            s["grain"].as_str(),
        )
    } else {
        crate::roll_selection::select_approved_compositions(
            scope,
            key,
            round as usize,
            s["mode"].as_str(),
            s["grain"].as_str(),
            s["platform"].as_str(),
            compositions,
            3,
        )
        .picks
    };
    if picks.is_empty() || dealt.is_empty() {
        return Err("No eligible candidates for this round".into());
    }
    let response = json!({"protocol":1,"session":session_id,"round":round,"register":register,"settings":s,"source":"retrieval","poolRevision":session["revision"],"approvedCount":concepts.len(),"catalogCount":concepts.len()+compositions.len(),"retrieval":{"backend":SELECTOR,"lexicalSignal":session["lexicalSignal"],"quality":"deterministic baseline; not a probability or measured quality gain"},"record":{"slug":format!("{}-{round}",&session_id[..12]),"challengers":picks,"compositions":dealt,"stagings":dealt,"staging":dealt[0],"poolRevision":session["revision"],"approvedCount":concepts.len(),"catalogCount":concepts.len()+compositions.len()}});
    state::atomic(
        &path,
        &state::canonical(&json!({"hash":state::digest(&response),"response":response})),
    )?;
    Ok(response)
}
fn ranked(
    pool: &[Value],
    key: &str,
    scope: &str,
    reroll: usize,
    grain: Option<&str>,
) -> Vec<Value> {
    let mut prior = HashSet::new();
    let mut picks = vec![];
    for round in 0..=reroll {
        let mut available: Vec<_> = pool
            .iter()
            .enumerate()
            .filter(|(_, c)| !prior.contains(c["id"].as_str().unwrap_or("")))
            .collect();
        if available.len() < 3.min(pool.len()) {
            available = pool.iter().enumerate().collect();
        }
        available.sort_by_key(|(rank, c)| (grain.is_some_and(|g| c["grain"] != g), *rank));
        picks = available
            .first()
            .map(|(_, c)| vec![(*c).clone()])
            .unwrap_or_default();
        let mut rest: Vec<_> = available
            .into_iter()
            .skip(1)
            .map(|(rank, c)| {
                let hash = state::hash(
                    format!("{scope}:{key}:{round}:{}", c["id"].as_str().unwrap_or("")).as_bytes(),
                );
                let u = (u64::from_str_radix(&hash[..13], 16).unwrap() as f64 + 1.0)
                    / ((1u64 << 52) as f64 + 1.0);
                (-(u.ln()) * (rank + 1) as f64, c)
            })
            .collect();
        rest.sort_by(|a, b| a.0.total_cmp(&b.0));
        for diverse in [true, false] {
            for (_, c) in &rest {
                if picks.len() == 3 {
                    break;
                }
                if !picks
                    .iter()
                    .any(|p| p["id"] == c["id"] || (diverse && p["familyId"] == c["familyId"]))
                {
                    picks.push((*c).clone());
                }
            }
        }
        if round < reroll {
            for p in &picks {
                prior.insert(p["id"].as_str().unwrap_or("").to_string());
            }
        }
    }
    picks
}
