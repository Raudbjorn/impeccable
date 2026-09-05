# Upstream integration, 2026-09-05

This merge joins fork commit `03eacfe903d46e95e9cdf9c73494a1653eb46990` with upstream main `381d52b3`. The histories diverged by 13 fork commits and 80 upstream commits. A normal merge preserves both histories and avoids replaying overlapping squash imports.

## Runtime decision

The fork's working JavaScript runtime remains the default. Upstream's Rust workspace, native engine, frozen oracle corpus, WASM browser bundle and extension changes are included alongside it. This is an integration of both codebases, **not a claim that the fork features have been ported to Rust**. Retaining the complete JavaScript dependency closure avoids leaving surviving entrypoints with deleted imports.

`node skill/scripts/<command>.mjs` keeps its existing behavior. The new `skill/scripts/impeccable <command>` launcher also runs a sibling JavaScript command when one exists, preserving arguments, working directory and exit status. `hooks` and `signals` retain their aliases. A native-only verb uses upstream's engine discovery and checksum-verified download path. `IMPECCABLE_NATIVE=1` explicitly selects native behavior; an `IMPECCABLE_BIN` override alone does not bypass the fork command path.

The upstream native npm shim is retained separately at `cli/native/bin/cli.js`, with its pinned platform-package manifest and checksum/download tests. It can be invoked explicitly with Node.

The npm CLI remains the fork's JavaScript CLI. Its version is not advanced to the upstream native CLI version. No packages or releases are published by this merge.

## Features retained

| Fork behavior | Implementation and verification |
| --- | --- |
| Local retrieval, reranking backend protocol, stable sessions, replay and choice recording | `concept-seed.mjs`, `lib/retrieval-client.mjs`, retrieval-client and concept-seed tests; launcher retrieval regression |
| Choice validation before a build starts | `build-phase.mjs`, build-phase and new-work end-to-end tests |
| Evidence-item critique scoring and storage | `score-evidence.mjs`, critique evidence data, critique-storage and score-evidence tests |
| Design-context import/export and provenance | `design-context/`, import/export/portability tests |
| Image generation, visual cues and asset production in the consuming project | `image-gen.mjs`, `generate-image.mjs`, `visual-cues.mjs`, source agent guidance and image/visual-cues tests |
| OMP detection, hook installation and safe hook execution | Fork provider configuration, hooks, CLI installer and hook/skills tests |
| Provider exclusions, issue gate, palette guardrails and inverse slop guidance | Fork provider table, issue-gate workflow and tests, source skill/reference guidance |
| JavaScript detector profiling, vendored parser, virtual device paths, gray-on-color and CSP fixes | Complete `cli/engine/` implementation and detector/framework/hook tests |

The fork's `overused-font` fixture is retained as `tests/fixtures/fork/overused-font.html`. Upstream's original fixture remains at `overused-font.html` for its frozen oracle. Neither runtime's findings were weakened to reconcile the different inputs.

## Native evaluation

```sh
cargo test --workspace
cargo build --release -p impeccable
# Cargo may use a configured shared target directory; use the emitted binary path.
IMPECCABLE_BIN=/absolute/path/to/impeccable node tests/oracle/run.mjs
IMPECCABLE_NATIVE=1 IMPECCABLE_BIN=/absolute/path/to/impeccable skill/scripts/impeccable detect --json example.html
```

Native `concept-seed` still has upstream's remote `/roll` behavior and native commands do not yet implement all fork extensions. Do not use native mode for the retrieval workflow. Moving a command to native requires explicit parity coverage for the fork behavior first. The fork launcher defaults and direct JavaScript references prevent an incidental upgrade from replacing local retrieval with remote rolls.

The extension uses upstream's native/WASM pipeline (`cargo xtask bundle`, `bun run build:extension`). The fork JavaScript browser detector is built separately with `bun run build:browser`. Each pipeline keeps its own source and tests.

## Preservation

`backup/lets-roll-before-upstream-20260905` preserves the original branch. The named pre-rebase stash preserves the previously unstaged generated artifacts; it is not applied over the integrated source. Provider artifacts are regenerated from the merged source instead. External catalog databases, embeddings, archives and evaluation caches are outside this merge and are not deleted or rewritten.

## Validation

- Complete default fork suite (`bun run test`): passed, including generated hooks, detector/browser, live, framework, plugin and upstream-helper checks.
- Rust workspace: 391 tests passed, one ignored.
- Native oracle and server-cleanup suite: passed, with no changed goldens or regenerated function vectors. The oracle uses its original platform-reference and reviewed-catalog inputs under `tests/oracle/fixtures/`.
- New-work browser flow: all 22 cases passed.
- A saved session from the real candidate retrieval database replayed through the merged launcher successfully, without an embedding or reranking request.
- Production catalog preservation check: 638 entries, 1,300 pages, 23,948 spans, and 25,886 embeddings.
- Distribution and native Chrome extension builds passed. The upstream Firefox package builds but still lacks its required offscreen API; this merge does not claim Firefox scanning support.

The native oracle probes local framework ports. On a workstation with unrelated services, Linux can give it an isolated loopback network. Dropping namespace capabilities also preserves the unreadable-file cases:

```sh
unshare -Urn -- sh -c 'ip link set lo up && exec setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all env IMPECCABLE_BIN=/absolute/path/to/impeccable node scripts/run-tests.mjs native'
```

The default fork suite is `bun run test`; native parity is separately available as `bun run test:native` with `IMPECCABLE_BIN` set.
