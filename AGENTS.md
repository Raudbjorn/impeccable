# Repository Guidelines

## Project Structure & Module Organization

`skill/` is the source of truth for the Impeccable skill: `SKILL.src.md`, `reference/`, `scripts/`, and `agents/`. Build logic lives in `scripts/`, with provider configs in `scripts/lib/transformers/`. The CLI and anti-pattern detector live in `cli/`, the browser extension in `extension/`, the Astro website in `site/`, Cloudflare Pages Functions in `functions/`, and regression coverage in `tests/` with fixtures under `tests/fixtures/`. `dist/` and `build/` are generated and gitignored. The root harness folders (`.agents/`, `.claude/`, `.cursor/`, etc.) and `plugin/` are generated distribution artifacts that are tracked for direct repo installs, not hand-authored source.

## Build, Test, and Development Commands

- `bun run dev` - start the local Bun server.
- `bun run build` - source-first build: regenerate `dist/`, derived site assets, and validation output without syncing tracked harness folders.
- `bun run build:release` - release/distribution build: run the full build and sync tracked root harness folders plus `plugin/`.
- `bun run rebuild` - clean and rebuild everything from scratch without syncing tracked harness folders.
- `bun run rebuild:release` - clean and rebuild everything, including tracked harness output sync.
- `bun test tests/build.test.js` - run a focused Bun test.
- `bun run test` - run the full Bun + Node test suite (includes the plugin loader E2E, which installs the committed `plugin/` subtree into a sandboxed real Claude Code and skips cleanly when the `claude` CLI is absent).
- `bun run test:live-e2e` - opt-in live-mode E2E against framework fixtures (~2 min; needs `npx playwright install chromium` once).
- `bun run test:skill-behavior` - opt-in LLM-backed checks that the SKILL.md Setup flow actually drives the agent (runs claude-sonnet-5 / gpt-5.6-luna / gemini-3.5-flash / deepseek-v4-flash; needs `.env` with provider keys).
- `bun run test:plugin-e2e` - just the plugin loader E2E, for fast iteration on `plugin/`, `skill/agents/`, or `scripts/build.js` changes.
- `bun run build:browser` / `bun run build:extension` - rebuild browser-specific bundles.

Run `bun run build` after changing anything in `skill/`, transformer code, or user-facing counts. It validates the generated distribution under `dist/` without touching tracked root harness outputs. Use `bun run build:release` only when intentionally refreshing generated provider permutations for release/main-sync or build-system work.

## Generated Provider Output Policy

The root harness folders (`.agents/skills/`, `.claude/skills/`,  `.codex/skills/`, `.gemini/skills/`, `.github/skills/`,  `.kiro/skills/`, `.opencode/skills/`, `.pi/skills/`,`.vibe/skills/`) and `plugin/` stay tracked so `main` remains installable for direct GitHub, `npx skills`, and submodule users. They are still generated artifacts.

Normal development should be source-first: stage changes in `skill/`, `scripts/`, `cli/`, `site/`, `extension/`, `functions/`, and `tests/`; leave generated harness churn unstaged unless the user asked for it. After source changes land on `main`, `.github/workflows/sync-generated-output.yml` runs `bun run build:release` and commits generated provider output directly back to `main`. Treat generated harness diffs as release artifacts and keep them out of feature PRs unless they are the point of the PR.

## Coding Style & Naming Conventions

Use ESM, semicolons, and the existing two-space indentation style in JS, HTML, and CSS. Prefer small, single-purpose modules over large abstractions. Keep filenames descriptive and lowercase with hyphens where needed; skill entrypoints stay as `SKILL.md`, helper scripts use `.js` or `.mjs`. In source frontmatter, use clear kebab-case names and concise descriptions. There is no dedicated formatter or linter configured here, so match surrounding code closely.
