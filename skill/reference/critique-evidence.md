### Purpose

An opt-in, deterministic-scoring alternative to `{{command_prefix}}impeccable critique`'s heuristic scoring. Vanilla `critique` is unchanged and remains the default; this command is a separate, self-contained path for when an evidence trail matters more than a single blended pass. It ports the `evidence-item-rescoring` design from an upstream fork's methodology note, *"Don't Let the LLM Pick a Number"*: split observation from arithmetic, because blending collect + score + write-prose into one prompt is what produces run-to-run variance.

### Why a separate command

The vanilla critique blends three things into one prompt: collect observations, score each heuristic 0-4, write prose. This command splits that into three stages: the first two run independently and never see each other's output, and the third then consumes their merged result (see Hard rules):

1. **LLM: evidence collection only.** Emits catalog item citations, never a number.
2. **Detector: rule-based items.** Deterministic findings from the bundled anti-pattern detector, mapped to the same catalog.
3. **Math: deterministic scoring.** A fixed formula turns the merged item pool into a 0-100 score.

### Stage 1 (LLM): evidence collection

Send the LLM the target page (HTML and/or screenshot) plus the full evidence catalog: the 10 files under `{{scripts_path}}/data/critique-evidence/heuristic-*.json`, one per Nielsen heuristic. The LLM returns a JSON list of `{heuristic_id, item_id, citation}` triples drawn ONLY from the catalog. No score, no prose summary.

Prompt template: [reference/evidence-collection.md](reference/evidence-collection.md).

### Stage 2 (detector): rule-based items

Run:
```bash
{{scripts_path}}/impeccable detect --json [target]
```

Translate each finding into a detector item: each finding's `antipattern` field (the rule id, e.g. `"side-tab"`, per `cli/engine/findings.mjs`) is the lookup key into the matching `id` in `{{scripts_path}}/data/critique-evidence/detector-items.json`. Each detector hit becomes a negative evidence item with `source: "detector"`, carrying that entry's `impact`, `heuristic_id`, and `impact_source` (see Coverage note below) onto the emitted item.

**Per-rule cap.** A single rule can fire many times across a page (e.g. `low-contrast` hitting every text element in a failing section). Emit one detector item per occurrence, up to 3 occurrences of any single rule; each of those (up to 3) items carries the rule's full catalog `impact`. The 4th and later occurrences of that same rule are noted (e.g. in a summary count) but do not get their own item and do not contribute to the score. This bounds how much one noisy rule can dominate the pool without erasing repeated evidence entirely: a rule firing twice is worth twice its impact, a rule firing 20 times is worth the same as one firing 3 times.

**Coverage note.** Each row in `detector-items.json` carries its own `impact_source` field (glossed under `meta.impact_source`), marked `"authored"` (a reviewed impact/heuristic assignment) or `"default"` (a conservative `-1`/`amd` placeholder for a rule that has not been individually calibrated yet). Both kinds score; only the confidence in the number differs. Treat a report leaning heavily on `"default"` rows as a signal that catalog is due for a real review pass, not as a reason to discard the finding.

### Stage 3 (math): apply the formula

Run:
```bash
node {{scripts_path}}/score-evidence.mjs <merged-items.json>
```

The scorer applies the canonical evidence-item formula: net impact summed across items, normalized by `sqrt(total_items)`, mapped onto a 0-100 scale centered at 50, then scaled by a density-based confidence multiplier (0.75 baseline, up to 1.0 as item count approaches the density denominator, default 20). Zero items returns the center score (50) with the minimum multiplier (0.75) rather than crashing or extrapolating.

Build `<merged-items.json>` from Stage 1's LLM items plus Stage 2's capped detector items before invoking the scorer; the scorer itself does no catalog lookups or capping.

**Stage 1 items arrive with no `impact` field** (`{heuristic_id, item_id, citation}` only, per [reference/evidence-collection.md](reference/evidence-collection.md)). Before invoking the scorer, look up each Stage 1 item's `impact` in its catalog entry: catalog entries are keyed `id` (not `item_id`), so find the entry whose `id` equals the Stage 1 item's `item_id`, under the matching `heuristic_id`'s `positive` / `negative` / `critical_negative` list in `{{scripts_path}}/data/critique-evidence/heuristic-*.json`, and copy that entry's `impact` onto the item, tagging it `"source": "llm"`. A Stage 1 `item_id` with no matching catalog `id` gets dropped here (see Hard rules), not passed through with a missing or guessed impact. The scorer rejects any item whose `impact` isn't a finite number rather than silently producing a garbage score.

### Hard rules

- The LLM never emits a score. If a Stage 1 prompt asks for an integer, stop.
- Item IDs must be drawn from the catalog verbatim. Unknown IDs are dropped with a warning, never coerced into the catalog.
- The detector contributes via items in the same pool, not via a side channel.
- Stages 1 and 2 run independently and never see each other's output. Stage 3 then consumes their merged item pool; this is one-way, nothing Stage 3 computes is fed back into Stage 1 or 2.

### Output

```json
{
  "target": "site/pages/index.astro",
  "items": [
    {"heuristic_id": "vss", "item_id": "vss-pos-loading-feedback",
     "impact": 3, "source": "llm",
     "citation": "Save button shows spinner while submitting, swap to checkmark on success"},
    {"heuristic_id": "amd", "item_id": "gradient-text",
     "impact": -2, "source": "detector", "impact_source": "authored",
     "citation": "gradient-text rule, 1 occurrence"}
  ],
  "score": {
    "final": 54, "raw": 55.66, "multiplier": 0.775,
    "total_items": 2, "net_impact": 1,
    "by_heuristic": { "vss": { "items": 1, "net_impact": 3 }, "amd": { "items": 1, "net_impact": -2 } },
    "by_source": { "llm": { "items": 1, "net_impact": 3 }, "detector": { "items": 1, "net_impact": -2 } }
  }
}
```

Present the score alongside the item list in chat; don't report a bare number without the evidence that produced it.

### Failure modes

- **Unknown item_id from the LLM**: drop the item, note it, do not crash.
- **Detector fails or is unavailable**: treat it as returning an empty finding list, note the failure, continue with LLM items only.
- **LLM returns no items at all**: the scorer returns `final: 50` with `multiplier: 0.75` and empty breakdown maps. Report that plainly; a center score from zero evidence is not the same as a good score.
- **Citation field empty or missing**: keep the item but flag it; a missing citation is a quality signal on the run, not a fatal error.
