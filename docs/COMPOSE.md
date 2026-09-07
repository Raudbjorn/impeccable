# Impose integration

The operational contract and input examples live in [the Compose reference](../skill/reference/compose.md).

Rust in `crates/context/src/compose/` owns commands, validation, approvals, immutable project revisions, selection sessions, export publication, and assessment. The CLI dispatches `impeccable compose`; the existing retrieval seam connects project selection to `concept-seed`. URL and structured-source extraction run in Rust. URL capture accepts public HTTP(S) destinations only, validates and pins every DNS answer and redirect, disables environment proxies, and limits capture to five redirects, 30 seconds, and 16 MiB. The size limit also applies after gzip or deflate decompression. Export assets must be bounded, decodable images opened within the project directory; exports use retained content-addressed snapshots of the validated bytes. Optional PDF/image extraction and export workers are embedded from `skill/scripts/compose-*` and materialized only in project-local state. Python dependencies are pinned and locked; no new database, model service, or corpus is bundled.

The existing seven boundaries remain distinct:

- Foundation/core rule definitions and observed findings; scoped style exceptions retain their findings.
- Context catalog grammar and reviewed selection history; approvals bind to full draft content.
- DESIGN.md requirements and detected token usage; exported DESIGN.md is a reviewable draft.
- Artifact schema and drift; boot stays cheap, doctor hashes sources.
- CSS syntax/cascade and resolved styles; the existing HTML engine owns both.
- Measured comp specs and rendered builds; Compose calls the existing comparison and hashes its inputs.
- Critique evidence catalog and prior snapshots; rubric/applicability/context changes prevent trend equivalence.

Project state uses immutable JSON revisions plus an atomic current pointer and a single-writer lock. Invalid drafts, failed exports, refutations, and superseded reviews are retained. A leftover lock after process death requires checking its recorded PID before removing it. No command imports or migrates an existing Compose database. Local original sources remain in place; generated renders and processing results belong to the new project.

The offline shortlister is a deterministic lexical baseline, not an asserted replacement for multimodal retrieval. Palette extraction uses a bounded RGB histogram with chroma-support abstention; it does not claim perceptual or print-color equivalence. Tradition attribution stays with the reviewing agent rather than a fixed corpus-specific keyword catalog. Existing external retrieval backends remain available without changed protocol semantics.

Validation:

```bash
cargo test -p impeccable-context --test compose
uv run --offline --locked tests/compose-processing.py
IMPECCABLE_BIN=/path/to/new/impeccable node --test tests/compose.test.mjs
```

The real optional-worker test additionally uses `IMPOSE_PROCESSING_E2E=1`; it explicitly installs the pinned extraction/PDF dependencies into a temporary project. Set `IMPOSE_THEME_MODULE` and `IMPOSE_VERNACULAR_MODULE` to actual parser module files to exercise both downstream formats. No donor data or model API is used. The standard Bun/Node suite includes the offline command and worker-failure tests; Rust regressions exercise storage, approval, selection, and comparison boundaries.
