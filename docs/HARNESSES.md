# Harness Skills Capabilities Reference

Source of truth for what each AI coding harness supports in terms of agent skills.
Used to inform provider configs in `scripts/lib/transformers/providers.js`.

Last verified: 2026-04-28 (subagent landscape spot-checked 2026-06-28; Mistral Vibe row verified 2026-07-16; oh-my-pi row added 2026-08-30)

> This file is point-in-time. Capabilities move fast; verify live before relying
> on any "only X supports Y" claim. Notably, the subagent table below lists
> Impeccable's *emission targets*, not the support landscape (see its note).

## Official Documentation

| Harness | Docs URL |
|---------|----------|
| Claude Code | https://code.claude.com/docs/en/skills |
| Gemini CLI | https://geminicli.com/docs/cli/skills/ |
| Codex CLI | https://developers.openai.com/codex/skills |
| GitHub Copilot (Agents) | https://code.visualstudio.com/docs/copilot/customization/agent-skills |
| Kiro | https://kiro.dev/docs/skills/ |
| OpenCode | https://opencode.ai/docs/skills/ |
| Pi | https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md |
| Mistral Vibe | https://docs.mistral.ai/vibe/code/cli/skills |
| Antigravity | https://antigravity.google/docs/skills |
| oh-my-pi | https://github.com/can1357/oh-my-pi/blob/main/docs/skills.md |

## Spec Compliance

All harnesses follow the [Agent Skills specification](https://agentskills.io/specification) to varying degrees. The spec defines these frontmatter fields: `name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`.

Provider-specific extensions beyond the spec: `user-invocable`, `argument-hint`, `disable-model-invocation`, `allowed-tools` (extended syntax), `model`, `effort`, `context`, `agent`, `hooks`, `subtask`, `mcp`.

## Frontmatter Support

Fields marked with * are spec-standard. Others are provider extensions.

| Field | Claude Code | Gemini | Codex | Copilot | Kiro | OpenCode | Pi | Mistral Vibe | Antigravity | oh-my-pi |
|-------|:-----------:|:------:|:-----:|:-------:|:----:|:--------:|:--:|:------------:|:-----------:|:--------:|
| `name`* | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| `description`* | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| `license`* | Yes | Ignored | No | Yes | Yes | Yes | Yes | Yes | Yes | Ignored |
| `compatibility`* | Yes | Ignored | No | Yes | Yes | Yes | Yes | Yes | Yes | Ignored |
| `metadata`* | Yes | Ignored | No | Yes | Yes | Yes | Yes | Yes | Yes | Ignored |
| `allowed-tools`* | Yes | Ignored | No | No | No | Yes | Yes | Yes | Yes | Ignored |
| `user-invocable` | Yes | No | No | Yes | No | Yes | No | Yes | No | No |
| `argument-hint` | Yes | No | No | Yes | No | Yes | No | No | No | No |
| `disable-model-invocation` | Yes | No | No | Yes | No | Yes | Yes | No | No | Yes |
| `model` | Yes | No | No | No | No | Yes | No | No | No | No |
| `effort` | Yes | No | No | No | No | No | No | No | No | No |
| `context` | Yes | No | No | No | No | No | No | No | No | No |
| `agent` | Yes | No | No | No | No | Yes | No | No | No | No |
| `hooks` | Yes | No | Yes | No | No | No | No | No | No | No |

Notes:
- Gemini CLI validates only `name` and `description`; other spec fields are parsed but ignored.
- Codex CLI uses a separate `agents/openai.yaml` sidecar for skill metadata (icons, branding, MCP tools, invocation control). Codex also auto-discovers subagents bundled inside an installed skill's `agents/` folder (TOML), which is how Impeccable ships its asset-producer. Standalone custom agents can still live under `.codex/agents/` or `~/.codex/agents/`, but Impeccable no longer installs anything there.
- Codex CLI hooks ship under `[features].hooks = true` (still flagged), require `/hooks` trust ceremony per-update, and are disabled on Windows.
- Kiro recognizes `user-invocable` and `disable-model-invocation` per community reports but does not formally document them.
- Antigravity supports standard Agent Skills spec frontmatter fields (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`).
- Impeccable does not emit `allowed-tools` for oh-my-pi: the field is parsed and never enforced there, and the value would have to name a scripts path that differs between a project and a user install.
- oh-my-pi's own supported frontmatter set is `name`, `description`, `globs`, `alwaysApply`, `hide`, `disableModelInvocation` (kebab-case `disable-model-invocation` is normalized to this); everything else is parsed and preserved as unknown metadata but not interpreted, same as Gemini's spec fields.
- Unknown fields are silently ignored by all harnesses.

## Hook surface used by Impeccable

| Harness | Edit hook | Startup hook | Manifest location | Notes |
|---------|:---------:|:------------:|-------------------|-------|
| Claude Code | Yes (`PostToolUse`) | No | `.claude/settings.json` | Project-local settings entry installed by `npx impeccable skills install/update`. Runs `.claude/skills/impeccable/scripts/hook.mjs`. |
| Codex CLI | Yes (`PostToolUse`) | No | `.codex/hooks.json` | Project-local manifest installed with the `.agents/skills/impeccable` payload. Runs `.agents/skills/impeccable/scripts/hook.mjs` from the git root. Requires normal `/hooks` trust approval. |
| GitHub Copilot | Yes (`PostToolUse`) | No | `.github/hooks/impeccable.json` | Team-shared, committed repo-level manifest. Runs `.github/skills/impeccable/scripts/hook.mjs`. |
| oh-my-pi | Yes (`tool_result`) | Yes (`session_stop`) | `.omp/hooks/post/impeccable.js` | The only module-shaped target: a loaded JS module, not a JSON manifest, so it is recognized by an `@impeccable-hook-module` stamp rather than a command string. Matches `edit`, `write`, and `ast_edit`, and scans every entry of the event's `paths`. The Stop pass returns `continue: true` alongside `additionalContext`, which is what oh-my-pi requires to schedule the continuation. |
| All other harnesses | No | No | n/a | No documented hook surface today. Skill and commands still ship. |

## Skill Directory Structure

| Harness | Native directory | Also reads |
|---------|-----------------|------------|
| Claude Code | `.claude/skills/` | - |
| Gemini CLI | `.gemini/skills/` | `.agents/skills/` |
| Codex CLI | `.agents/skills/` (primary) | - |
| GitHub Copilot | `.github/skills/` | `.agents/skills/`, `.claude/skills/` |
| Kiro | `.kiro/skills/` | - |
| OpenCode | `.opencode/skills/` | `.agents/skills/`, `.claude/skills/` |
| Pi | `.pi/skills/` (project), `~/.pi/agent/skills/` (global) | `.agents/skills/` |
| Mistral Vibe | `.vibe/skills/` (project), `~/.vibe/skills/` (global) | `.agents/skills/` (project), `~/.agents/skills/` (global) |
| Antigravity | `.agent/skills/` (project), `~/.gemini/config/skills/` (global) | `.agents/skills/` (project), `~/.agents/skills/` (global) |
| oh-my-pi | `.omp/skills/` (project, highest discovery priority), `~/.omp/agent/skills/` (global; note the `agent` segment, as with Pi) | `.claude/skills/`, `.agent/skills/`, `.agents/skills/`, `.codex/skills/`, `.opencode/skills/`, `.github/skills/` (all lower priority; already picked up before this row existed) |

All harnesses support the `{skill-name}/SKILL.md` directory structure with optional `reference/`, `scripts/`, and `assets/` subdirectories.

## Native Subagent Directory Structure (Impeccable emission targets)

> **Scope:** this table is **where Impeccable emits native subagent files**, not a
> map of which harnesses support subagents. Subagents are broadly supported now:
> GitHub Copilot and Google Antigravity ship them too. Impeccable only writes
> native files where there is a stable, documented on-disk format to target.

| Harness | Native directory | File format |
|---------|------------------|-------------|
| Claude Code | `.claude/agents/` (installed plugin) | Markdown with YAML frontmatter |
| Codex CLI | `<skill>/agents/` (nested, auto-discovered) | TOML |

oh-my-pi also has a documented format (`.omp/agents/*.md` project, `~/.omp/agent/agents/*.md` user, markdown with frontmatter including `autoloadSkills`), but Impeccable does not emit there yet.

Impeccable keeps canonical agent prompts under `skill/agents/` and emits provider-native files only for harnesses with a documented on-disk subagent format. Claude reads its agents from the installed plugin; Codex auto-discovers the TOML bundled inside the installed skill's own `agents/` folder, so the normal skills install carries it with no separate sidecar.

**Spawn / permission model** (matters more than directory support when building skills):

| Harness | Who can spawn a subagent |
|---------|--------------------------|
| Claude Code | Programmatically, from within the skill/agent flow. |
| Codex CLI | Only if the user has allowed sub-agents / parallel work; otherwise the skill must ask once, then stop (see `skill/reference/critique.md` `<codex>` gate). |
| Others | Varies; treat as unavailable unless verified, and degrade loudly. |

## Placeholder / Variable Substitution

Claude Code supports runtime variable substitution directly in SKILL.md bodies: `$ARGUMENTS`, `$0`-`$N`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_SESSION_ID}`. No other harness supports substitution in skills.

Some harnesses have separate "custom commands" systems (distinct from skills) with their own substitution:

| Harness | Command system | Substitution syntax |
|---------|---------------|-------------------|
| Gemini CLI | `.gemini/commands/` (TOML) | `{{args}}`, `!{shell}`, `@{file}` |
| Codex CLI | `.codex/prompts/` | `$ARGNAME` |
| OpenCode | `.opencode/commands/` | `$ARGUMENTS`, `$1`-`$N`, `` !`shell` `` |

Our build system handles cross-provider placeholders at compile time via `replacePlaceholders()` for `{{model}}`, `{{config_file}}`, `{{ask_instruction}}`, and `{{available_commands}}`.
