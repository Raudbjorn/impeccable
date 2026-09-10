# `.impeccable/config.json` reference

Source of truth for every key `.impeccable/config.json` and `.impeccable/config.local.json`
actually read. Derived directly from the reader/validator code below, not from
intent, so it stays checkable: if a key here stops matching the code, one of
these functions changed and this file didn't.

`config.local.json` has the identical shape and is read second, so its values
win over `config.json` for anything both files set (`readConfig` in
`skill/scripts/hook-lib.mjs`).

## Top-level keys

`KNOWN_CONFIG_KEYS` in `skill/scripts/lib/staleness.mjs`. Any other top-level
key trips the `config-unknown-keys` doctor finding.

| Key | Type | Meaning |
|---|---|---|
| `hook` | object | Hook runtime settings (below) |
| `detector` | object | Detector filter settings (below) |
| `updateCheck` | boolean | `false` disables the daily version-check ping (`context.mjs`) |
| `stalenessCheck` | boolean | `false` disables the artifact-drift check at boot (`staleness-notice.mjs`) |
| `projectRoots` | string[] | Glob patterns naming extra monorepo project roots (`context.mjs`) |
| `buildPath` | `"comp"` \| `"code"` | Comp-first vs code-first direction workflow. Any other value trips `config-invalid-build-path` |
| `$schema` | string | Not read by any code. Pure JSON-schema / editor-autocomplete hint |
| `version` | any | Not read by any code. Reserved, no current check |

## `hook` object

Read by `applyConfigSource()` in `skill/scripts/hook-lib.mjs`; defaults live in
`DEFAULT_CONFIG` in the same file.

| Key | Type | Default | Notes |
|---|---|---|---|
| `enabled` | boolean | `true` | `false` disables the hook entirely |
| `quiet` | boolean | `false` | `true` suppresses findings output |
| `perEditRules` | `"immediate"` \| `"all"` | `"immediate"` | Any other value is ignored, default stands |
| `auditLog` | string (non-empty) | `null` | Path to append an audit log |
| `limits.maxFindings` | number > 0 | `5` | |
| `limits.maxChars` | number > 0 | `8000` | |
| `limits.maxFileBytes` | number > 0 | `131072` | Findings against a file over this size are dropped (bundles, vendored copies) |

`hook` is **not** checked for unknown keys: it is written by several tools
over time, and the false-positive rate from a closed set would outweigh the
catch (comment above `KNOWN_DETECTOR_KEYS` in `staleness.mjs`).

Back-compat: `hook` may also carry any of the `detector` keys below, for
configs written before the `detector` key existed (issue #316). If both
`hook` and `detector` set the same key, `detector`'s value wins.

## `detector` object

`KNOWN_DETECTOR_KEYS` in `skill/scripts/lib/staleness.mjs`. Any other key
trips `config-unknown-detector-keys`.

| Key | Type | Notes |
|---|---|---|
| `ignoreRules` | string[] | Antipattern rule ids to suppress everywhere |
| `ignoreFiles` | string[] | File paths/globs to skip scanning |
| `ignoreValues` | array of `{ rule, value, files?: string[], createdAt?: string, reason?: string }` | Suppress one specific finding value, optionally scoped to `files`. Normalized by `normalizeIgnoreValueEntries()` |
| `designSystem.enabled` | boolean | `false` turns off design-system-color checks |
| `extensions` | array of `string` or `{ ext: string, engine?: "html" \| "text" }` | Extra markup file extensions the hook and Live treat as UI. Bare strings are shorthand for `{ ext, engine: "html" }`. Normalized by `normalizeExtensionEntries()` in `skill/scripts/lib/template-extensions.mjs` |
| `advisoryRules` | `"include"` \| `"exclude"` | Default `"exclude"`. `"include"` opts into advisory-only rules (e.g. em-dash overuse) |

## Checking a project's config

`{{command_prefix}}impeccable doctor` runs `checkConfig()` against both files
and reports every unrecognized top-level key, unrecognized `detector` key, and
invalid `buildPath` value it finds, plus a `--fix` for the ones with a
mechanical repair. See `skill/reference/doctor.md`.
