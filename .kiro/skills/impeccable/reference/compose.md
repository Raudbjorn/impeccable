Process newly supplied sources into a reviewed design direction. Keep the user's originals in place. Never discover, import, migrate, or rewrite a pre-existing Compose corpus or database.

## Workflow

Use `.kiro/skills/impeccable/scripts/impeccable compose <command> --input request.json` or pipe a JSON object to the same command. Keep cwd at the target project. Commands return JSON; invalid drafts return their retained ID and diagnostics with exit 1. An unsuccessful export retains a draft and leaves previously published outputs intact.

1. Register explicit sources and extract observations.
2. Read those observations and the relevant source pages. Distill a candidate draft without discarding clauses to meet length limits.
3. Validate, review, and adopt exact content revisions.
4. Seed a direction, render it, and assess the actual result.
5. Export validated packages or review specimens from the same project revision.

Do not infer a source's identity from instructional guidance. A declared source tradition is an attributed claim; keyword counts only support routing suggestions. OCR correctness stays unassessed until someone checks it. Missing evidence is not negative evidence, and a missing source accent is not permission to claim an invented accent came from the source.

## Optional tools

`compose setup` materializes bundled workers and reports available executables. Native catalog, selection, and assessment commands do not need Python or Node. Extraction uses a pinned Python script through `uv`; PDF OCR additionally needs an installed `tesseract`. Package validation and specimen PDFs use Node.

Explicit setup request to install optional dependencies:

```json
{"install":["extract","specimen"]}
```

Subsequent extraction uses the locked environment offline. Configure actual parser module files with `themeModule` and `vernacularModule`; `rendererModule` optionally selects an installed `pretext-pdf` entrypoint. Paths are project-local configuration, never hardcoded sibling paths. Setup does not configure a model service. Agent-authored distillation can use the structured observations directly.

## Sources and distillation

Register with `compose source`:

```json
{"target":"manual.pdf","kind":"pdf"}
```

Kinds are `pdf`, `images` (one explicit folder), `url` (HTTP/S), and `structured` (JSON containing `pages`, each with a positive `page`, string `text`, and optional `spans`). Registration returns `sourceId`. URL registration records URI identity; extraction records captured content identity and never claims browser-computed or interactive behavior.

Run `compose derive` with `{"sourceId":"<id>","ocr":false}`. It returns a retained `runId`, page geometry and locations, source renders, triage diagnostics, palette candidates/abstention, and glossary suggestions. OCR is opt-in. A changed local source must be registered again. Identical completed processing inputs reuse the retained run. For a URL, `refresh:true` captures a new run; earlier reviewed evidence keeps its original run identity.

The invoking agent writes the draft; extraction does not fabricate a visual world or approval. Submit `compose validate` with:

```json
{
  "draft": {
    "entries": [],
    "guidance": [],
    "claims": [],
    "evidence": [],
    "tokens": {}
  }
}
```

- Concept entries use the existing catalog fields plus `kind:"concept"`, `familyId`, and `wellTier`. The five `system` rules must retain the exact ordered prefixes `Palette/material:`, `Type/composition:`, `Topology/navigation:`, `Controls/state:`, `Responsive/motion:`. Each is 12–180 characters. Existing form, lineage, strength, tag, spark, and web-leverage validators also apply.
- Composition entries use `kind:"composition"`, `familyId`, `surface`, optional `grain`/`platforms`, and four grammar rules prefixed `Staging/hierarchy:`, `Sequence/attention:`, `Controls/state:`, `Adaptation:`. They are 12–180 characters each. Supply form, spark, and web leverage.
- Guidance has `kind` (`principle`, `constraint`, `verbal`, `medium`), `statement`, and `appliesTo` drawn from `world`, `composition`, `vernacular`, `review`, `copy`. A prose `check` is not executable detector code.
- Claims have `kind` (`observed`, `inferred`, `adapted`, `unsupported`), `statement`, and optional attributed `citation`. Optional `confidenceLabel` is `High`, `Medium`, or `Low`, never a probability. Claims do not carry verified page links.
- Source-level evidence names a registered `sourceId`. Page/span links use the proposal path below.
- Optional `designTokens` uses native DESIGN.md groups (`colors`, `typography`, `rounded`, `spacing`, `components`) for application requirements such as spacing and radii. Adopted values feed Compose assessment through the existing token normalizer; conflicts with DESIGN.md fail adoption.
- Tokens are authored application values, optionally wrapped as `{"$value":"#ffffff","$type":"color"}`. Keep sampled source palettes in their extraction records. Record `accentOrigin` when adopting an accent. Do not turn semantic status colors into theme choices.

## Review and evidence

Review with `compose review`:

```json
{"draftId":"<id>","actor":"reviewer","authority":"human","verdict":"approved","reason":"Reviewed the exact grammar and its source qualification"}
```

An agent's own verdict uses `authority:"machine"`, never a human name as endorsement. Selection defaults to human approval; explicit `approvalPolicy:"human-and-machine"` also admits machine-approved drafts. Invalid drafts cannot be approved. Changed content gets a new draft ID and needs a new review. Reject superseded conflicting definitions rather than silently overriding them.

To propose page evidence, use `compose source` with `op:"propose"`, `sourceId`, `draftId`, `entryId`, positive `page`, optional extracted `span`, and `actor`. This creates no evidence. Review its `proposalId` with `compose review`, recording authority, approved/rejected verdict, and reason. Human bulk acceptance uses `bulk:true` so the machine pre-screen remains visible. Refutations are retained. Evidence is bound to the reviewed draft and extraction run.

Adopt using `compose adopt` with `draftId`, `reason`, and optional explicit approval policy. Conflicting tokens require a resolved draft and `replace:true`. Optional exceptions name `rule`, exact `target`, exact detector `selector`, and `reason`. Only stylistic rules are eligible. Findings remain in the assessment; accessibility checks remain active. An exception never applies to a text scan that cannot establish selector scope. A withdrawn or replaced approval stops its adoption from applying and produces a drift finding.

## Selection and replay

Use the existing seed prompt with a project catalog:

```bash
.kiro/skills/impeccable/scripts/impeccable concept-seed --project-catalog . --brief-file brief.txt --from deadbeef --scope direction --mode read
```

`--project-catalog <path>` names the project directory containing `.impeccable/compose`. `--approval-policy human|human-and-machine` defaults to `human`; `--selection-strategy seeded|ranked-1` defaults to `seeded`.

`--approval-policy human-and-machine` explicitly includes machine-reviewed candidates. `--selection-strategy ranked-1` enables the experimental rank-weighted composition selector; default selection uses the existing seeded algorithm after offline lexical shortlisting. Lexical scores are not quality probabilities. Missing structural coverage cannot be repaired by ranking.

Continue with the same `--project-catalog`, `--session`, and `--reroll`; use `--replay` for a saved round or `--chosen <id> --kind pick` to record its choice. Session settings are fixed. Existing configured retrieval commands keep their protocol-1 contract.

The direct `compose select` API accepts `op:"start"`, `brief`, and `settings` containing an eight-digit hexadecimal `key`, `scope`, optional `mode`/`grain`/`platform`, and approval policy. Later calls use `op:"round"|"replay"|"choose"`, `session`, and `round`. A chosen entry must belong to that saved round.

## Assess and export

`compose assess` accepts `target` and `observation`:

- `static-dom` or `source-text`: run existing Rust detection when `findings` is omitted. Existing DESIGN.md allowlists and active adopted tokens govern actual token usage.
- `browser` or `interaction`: provide findings from an actual browser capture or observed interaction. A source or static scan does not establish these observations.
- `comp-diff`: supply `comp`, `build`, and `spec` file paths; run the existing image comparison against that spec. Generate the measured spec with the existing `comp-spec` command and retain normal build-phase plate gates.

Reports preserve findings, qualified evidence, scoped stylistic exceptions, and hashes for supplied `spec`, `comp`, `build`, and `targetFile` artifacts. Unsupported observations remain unassessed. Keep adopted requirements separate from current detected state.

`compose export` needs `draftId` and `format`:

| Format | Output and gate |
|---|---|
| `bcp` | Five-sector BCP-shaped JSON, with explicit non-certification and evidence qualification. |
| `world-theme` | Explicit `entryId`; validated by the configured theme parser. |
| `vernacular` | Explicit `entryId`; validated by its parser, with unplaced terms reported. |
| `specimen` | Strict PDF review draft and retained semantic/evidence/asset/validation manifest. Optional `assets` names image files to include. |
| `design` | DESIGN.md draft from an adopted revision. Review and merge into the project's DESIGN.md; export never overwrites an existing design document. |

Exported files live in a content-addressed bundle under `.impeccable/compose/exports/`. Missing validators, contrast failures, renderer warnings, or missing assets stop publication and retain failed drafts. Identical verified bundles are reused. Catalog approval is not factual or visual approval of a PDF.

`compose verify` checks state and source availability; `{"deep":true}` also hashes source files and verifies retained artifacts. Boot performs cheap Compose drift checks; doctor includes deep checks. Neither calls a provider or runs extraction. New critique snapshots in Compose projects record their rubric revision. Supply `max_score`, `observation`, and a string `observation_context` (viewport, interaction state, and capture method); incompatible or unassessed histories are marked incomparable.
