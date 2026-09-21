//! Native text-source processing. Source observations never imply rendered-page behavior.
use super::{
    required, source_http,
    state::{self, Result},
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

pub fn text_source(source: &Value) -> Result<Value> {
    let mut pages = Vec::new();
    let hash;
    match required(source, "kind")? {
        "url" => {
            let raw = source_http::fetch(required(source, "url")?)?;
            hash = state::hash(&raw);
            let html = scraper::Html::parse_document(&String::from_utf8_lossy(&raw));
            let text = html
                .tree
                .nodes()
                .filter_map(|node| {
                    let value = node.value().as_text()?;
                    if node.ancestors().any(|a| {
                        a.value()
                            .as_element()
                            .is_some_and(|e| matches!(e.name(), "script" | "style"))
                    }) {
                        None
                    } else {
                        Some(value.text.to_string())
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            pages.push(json!({"page":1,"text":text,"spans":[],"geometry":null,"observation":"source-html; no computed styles or interaction claims"}));
        }
        "structured" => {
            let data = state::read(std::path::Path::new(required(source, "path")?))?;
            let supplied = data["pages"]
                .as_array()
                .ok_or("Structured source needs pages")?;
            if supplied.len() > 1000 {
                return Err("Structured source exceeds 1000 pages".into());
            }
            let mut numbers = BTreeSet::new();
            for (index, page) in supplied.iter().enumerate() {
                if !page.is_object() {
                    return Err("Structured pages must be objects".into());
                }
                let number = page.get("page").cloned().unwrap_or(json!(index + 1));
                if number.as_u64().is_none_or(|n| n == 0)
                    || !numbers.insert(number.as_u64().unwrap())
                {
                    return Err("Structured page numbers must be positive and unique".into());
                }
                let empty_text = json!("");
                let text = page.get("text").unwrap_or(&empty_text);
                if !text.is_string() {
                    return Err("Structured pages need string text".into());
                }
                let empty = json!([]);
                let spans = page.get("spans").unwrap_or(&empty);
                let mut ids = BTreeSet::new();
                for span in spans
                    .as_array()
                    .ok_or("Structured spans must be an array")?
                {
                    let id = required(span, "id")?;
                    if !ids.insert(id) || !span["text"].is_string() {
                        return Err("Structured spans need unique IDs and string text".into());
                    }
                    if !span["bbox"].is_null() {
                        let bbox = span["bbox"].as_array().ok_or("Invalid span bbox")?;
                        if bbox.len() != 4
                            || bbox.iter().any(|v| {
                                v.as_f64()
                                    .is_none_or(|v| !v.is_finite() || !(0.0..=1.0).contains(&v))
                            })
                            || bbox[0].as_f64() > bbox[2].as_f64()
                            || bbox[1].as_f64() > bbox[3].as_f64()
                        {
                            return Err(
                                "Structured span bbox must be ordered normalized coordinates"
                                    .into(),
                            );
                        }
                    }
                }
                pages.push(json!({"page":number,"text":text.as_str().unwrap_or(""),"spans":spans,"geometry":page["geometry"],"observation":"supplied-structured-input"}));
            }
            hash = required(source, "contentHash")?.to_owned();
        }
        _ => return Err("Unsupported text source".into()),
    }
    if pages.is_empty() {
        return Err("Source contains no supported pages".into());
    }
    Ok(
        json!({"schemaVersion":1,"extractor":"compose-native/1","dependencies":{},"sourceHash":hash,
        "triage":triage(&pages),"pages":pages,
        "palette":{"seeds":[],"accentSeed":{"abstained":true,"reason":"No supported chromatic accent in sampled source pixels"},
        "sampledPixels":0,"retainedPixels":0,"discardedPixels":0,"preprocessing":"thumbnail-160/rgb-histogram-16/v1","accentOrigin":"unassigned; any fallback is a product choice"}}),
    )
}

fn triage(pages: &[Value]) -> Value {
    let text = pages
        .iter()
        .filter_map(|p| p["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let available = pages
        .iter()
        .filter(|p| p["text"].as_str().unwrap_or("").chars().count() >= 200)
        .count() as f64
        / pages.len().max(1) as f64;
    let count = |terms: &[&str]| {
        terms
            .iter()
            .map(|term| {
                regex::Regex::new(&format!(r"\b{}\b", regex::escape(term)))
                    .unwrap()
                    .find_iter(&text.to_lowercase())
                    .count()
            })
            .sum::<usize>()
    };
    let identity = count(&[
        "clear space",
        "wordmark",
        "minimum size",
        "reproduction",
        "visual identity",
    ]);
    let guidance = count(&[
        "principle",
        "exercise",
        "technique",
        "case study",
        "bibliography",
    ]);
    let mut words = BTreeMap::new();
    let word_re = regex::Regex::new(r"\w+").unwrap();
    let mut total = 0;
    for word in word_re.find_iter(&text) {
        *words.entry(word.as_str()).or_insert(0usize) += 1;
        total += 1;
    }
    let mut suspicion = vec![];
    if text.chars().count() >= 200
        && text.matches('\u{fffd}').count() as f64 / text.chars().count() as f64 > 0.02
    {
        suspicion.push("replacement-characters");
    }
    if total >= 30 && words.values().max().copied().unwrap_or(0) as f64 / total as f64 > 0.30 {
        suspicion.push("repeated-text");
    }
    let mut terms: Vec<(&str, usize)> = vec![];
    let mut positions = BTreeMap::new();
    for term in regex::Regex::new(r"\b[A-Z][a-z]+(?: [A-Z][a-z]+){0,3}\b")
        .unwrap()
        .find_iter(&text)
    {
        let index = *positions.entry(term.as_str()).or_insert_with(|| {
            terms.push((term.as_str(), 0));
            terms.len() - 1
        });
        terms[index].1 += 1;
    }
    terms.sort_by_key(|e| std::cmp::Reverse(e.1));
    json!({"textAvailability":if available>=0.6 {"text-available"}else if available>=0.25 {"text-sparse"}else{"image-only"},
        "ocrCorrectness":"unassessed","suspicion":suspicion,
        "routeOpinion":if identity>guidance{"identity"}else if guidance>identity{"guidance"}else{"undetermined"},
        "routeApplied":false,"routeCounts":{"identity":identity,"guidance":guidance},
        "glossary":terms.iter().take(30).map(|(term,count)|json!({"term":term,"count":count,"qualification":"candidate"})).collect::<Vec<_>>(),
        "lineage":{"qualification":"unassessed","reason":"Tradition requires attributed source interpretation, not keyword certainty"}})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn triage_retains_route_and_suspicion_without_claiming_approval() {
        let text = format!(
            "Visual Identity\nclear space wordmark {}",
            "word ".repeat(60)
        );
        let report = triage(&[json!({"text":text})]);
        assert_eq!(report["routeOpinion"], "identity");
        assert_eq!(report["routeApplied"], false);
        assert_eq!(report["textAvailability"], "text-available");
        assert_eq!(report["suspicion"], json!(["repeated-text"]));
        assert_eq!(report["glossary"][0]["term"], "Visual Identity");
    }
}
