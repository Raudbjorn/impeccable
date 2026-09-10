# Evidence Collection Prompt

The LLM's only job in Stage 1 of `/impeccable critique-evidence` is to walk the target page and emit a JSON list of evidence items drawn from the catalog. No score. No prose summary. No verdict.

## Input

You will receive:

1. A target page as either rendered HTML, a screenshot, or both.
2. The 10 evidence catalogs (one per Nielsen heuristic, `.gemini/skills/impeccable/scripts/data/critique-evidence/heuristic-*.json`) plus the page-context description (what the interface is trying to accomplish).
3. The detector item list, for reference only. Stage 2 is a separate pass; do not emit detector items here.

## Task

For the target page, emit a JSON list of evidence items you observed. Each item is:

```json
{
  "heuristic_id": "<short_code>",
  "item_id": "<exact id from the catalog>",
  "citation": "<one short sentence pointing to the evidence>"
}
```

Hard constraints:

- `item_id` MUST be drawn from the catalog verbatim. Do not invent items. Do not reword item IDs. Items not in the catalog are dropped before scoring.
- `citation` should name the specific element, action, region, or absence that backs the item. One short sentence, not a paragraph.
- An item may appear multiple times if you observe the evidence multiple times (e.g. three async-save fields each contribute one `vss-pos-async-status` item).
- Do not emit items for things you did not actually observe. Better to miss an item than to invent one.
- Output ONLY the JSON array: no score, total, summary, or prose.

## Output format

```json
[
  {"heuristic_id": "vss", "item_id": "vss-pos-loading-feedback",
   "citation": "Save button shows spinner during async write"},
  {"heuristic_id": "vss", "item_id": "vss-neg-mystery-spinner",
   "citation": "Sidebar spinner during initial render with no label"},
  {"heuristic_id": "amd", "item_id": "amd-pos-clear-hierarchy",
   "citation": "Hero contrasts a 48px headline with 16px body, single primary CTA"}
]
```

## Coverage guidance

You are not required to find items in every heuristic. Some heuristics may have no applicable items for some pages (a marketing landing page may have no error-recovery evidence at all). Emit zero items for that heuristic in that case; the scorer handles low density gracefully via the confidence multiplier.

## Quality over quantity

If you can confidently cite 8 items, that beats guessing at 16. The math penalizes thin evidence via the confidence multiplier and thick noisy evidence via the sqrt normalization. There is no scoring incentive to pad the list.

## What you are not doing

- Not picking a 0-4 score. The scoring step is fully separate and deterministic.
- Not writing a critique report. That is the synthesis step in `/impeccable critique`, not this command.
- Not deciding severity. Each catalog item ships with a fixed signed impact; you do not weight items.
- Not running the detector. Stage 2 is a separate pass.
