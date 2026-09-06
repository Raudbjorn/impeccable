import { readFileSync } from 'node:fs';

/**
 * Build-pipeline emitters for the Impeccable design hook.
 *
 * Two emission targets exist:
 *
 * 1. Project-local install (the `npx impeccable skills install` CLI path):
 *      - Claude Code: `.claude/settings.json`   (${CLAUDE_PROJECT_DIR}-relative)
 *      - Codex:       `.codex/hooks.json`
 *
 * 2. Claude Code plugin package (the marketplace / `/plugin install` path):
 *      - `plugin/hooks/hooks.json`              (${CLAUDE_PLUGIN_ROOT}-relative)
 *
 * 3. OpenAI plugin package:
 *      - `hooks/hooks.json`                     (${PLUGIN_ROOT}-relative)
 *
 * The plugin variant resolves the hook script relative to the installed plugin
 * root rather than assuming a `.claude/skills/impeccable/` layout, so it stays
 * correct wherever Claude Code unpacks the plugin.
 */

export const IMPECCABLE_HOOK_COMMAND_MARKER = 'skills/impeccable/scripts/impeccable';

const TIMEOUT_SECONDS = 5;
const STATUS_MESSAGE = 'Checking UI changes';
// The Stop deep pass scans every UI file touched in the session with the
// full rule set, so it gets a longer budget than the single-file per-edit
// pass. Wired only for Claude Code and Codex, which both dispatch a native
// `Stop` hook event; GitHub Copilot's stop-style events do not feed context
// back to the model.
const STOP_TIMEOUT_SECONDS = 30;
const STOP_STATUS_MESSAGE = 'Design deep pass';

// The hook is a verb of the impeccable launcher that ships in the skill's
// scripts dir: `<scripts>/impeccable hook` (per-edit and Stop passes) and
// `<scripts>/impeccable hook-before-edit` (Cursor's preToolUse). The launcher
// runs the platform binary next to it, or downloads it once; no runtime probe
// is needed and there is no Node on the path to check.
export const LAUNCHER_NAME = 'impeccable';
export const LAUNCHER_NAME_WINDOWS = 'impeccable.cmd';

// A hook manifest can be copied into a user-level settings file (issue #399:
// user-level hooks fire in every project, where a project-relative path may
// not exist). Guard the invocation so a missing launcher exits 0 without
// swallowing the hook's real exit code when it is present: the `[ ! -f X ] ||
// X verb` form (not `... || true`) preserves the launcher's exit code, so
// Claude's exit-2 blocking signal still reaches the agent.
export const guardedLauncher = (launcherPath, verb = 'hook') =>
  `[ ! -f "${launcherPath}" ] || "${launcherPath}" ${verb}`;

// cmd.exe form for harnesses that read a `commandWindows` sibling (Codex
// 0.146.0+ selects it on Windows; issue #452). `exit /b` forwards the
// launcher's errorlevel. Paths keep forward slashes; cmd.exe accepts them in
// quoted paths and it is the form the CLI already writes.
export const windowsLauncherCommand = (launcherCmdPath, verb = 'hook') =>
  `if exist "${launcherCmdPath}" ("${launcherCmdPath}" ${verb} & exit /b)`;

function stopEntry(command, commandWindows) {
  return {
    hooks: [
      {
        type: 'command',
        command,
        ...(commandWindows ? { commandWindows } : {}),
        timeout: STOP_TIMEOUT_SECONDS,
        statusMessage: STOP_STATUS_MESSAGE,
      },
    ],
  };
}

const launcherIn = (scriptsDir) => `${scriptsDir}/${LAUNCHER_NAME}`;
const launcherCmdIn = (scriptsDir) => `${scriptsDir}/${LAUNCHER_NAME_WINDOWS}`;

const CLAUDE_PROJECT_SCRIPTS = '${CLAUDE_PROJECT_DIR}/.claude/skills/impeccable/scripts';
const CLAUDE_PLUGIN_SCRIPTS = '${CLAUDE_PLUGIN_ROOT}/skills/impeccable/scripts';
const CODEX_PLUGIN_SCRIPTS = '${PLUGIN_ROOT}/skills/impeccable/scripts';
// Codex reads project hooks from `.codex/hooks.json`, but the skill payload the
// hook invokes lives under the install's own skills dir: a `.codex`-directory
// install keeps it at `.codex/skills/...`, while a `.agents` (Codex repo-skills)
// install keeps it at `.agents/skills/...`. Derive the path from the install dir
// so each generated manifest points at its own payload rather than a hardcoded
// `.agents`; otherwise the guarded hook silently no-ops on `.codex` installs.
const codexProjectScripts = (skillDir) => `${skillDir}/skills/impeccable/scripts`;
const CURSOR_SCRIPTS = '.cursor/skills/impeccable/scripts';
const GITHUB_PROJECT_SCRIPTS = '$(git rev-parse --show-toplevel)/.github/skills/impeccable/scripts';
// Grok project hooks are relative to the git/workspace root. Claude tool names
// in the matcher (Edit|Write|MultiEdit) alias to Grok's search_replace family.
const GROK_PROJECT_SCRIPTS = '.grok/skills/impeccable/scripts';

// `windows: true` adds the `commandWindows` sibling; only Codex-shaped
// consumers honor it, and an unknown key would fail Codex's strict parser if
// it were the other way round, so it stays opt-in per manifest.
function buildClaudeCompatibleHooks(matcher, scriptsDir, { windows = false } = {}) {
  const command = guardedLauncher(launcherIn(scriptsDir));
  const commandWindows = windows ? windowsLauncherCommand(launcherCmdIn(scriptsDir)) : undefined;
  return {
    PostToolUse: [
      {
        matcher,
        hooks: [
          {
            type: 'command',
            command,
            ...(commandWindows ? { commandWindows } : {}),
            timeout: TIMEOUT_SECONDS,
            statusMessage: STATUS_MESSAGE,
          },
        ],
      },
    ],
    Stop: [stopEntry(command, commandWindows)],
  };
}

export function buildClaudeSettingsManifest() {
  return {
    description: 'Impeccable design detector: immediate-tier checks after Edit/Write on UI files, full-rule deep pass on Stop.',
    hooks: buildClaudeCompatibleHooks('Edit|Write', CLAUDE_PROJECT_SCRIPTS),
  };
}

// Plugin-packaged variant of the Claude hook. Claude Code reads the `hooks`
// object from a plugin's `hooks/hooks.json`, and the command resolves relative
// to ${CLAUDE_PLUGIN_ROOT} so it does not depend on the skill being copied into
// `.claude/skills/`. No top-level `description`: Codex also loads bundled plugin
// hooks from `hooks/hooks.json` and its strict parser rejects any field other
// than `hooks`, failing the whole manifest (issue #330).
export function buildClaudePluginHooksManifest() {
  return {
    hooks: buildClaudeCompatibleHooks('Edit|Write', CLAUDE_PLUGIN_SCRIPTS),
  };
}

// OpenAI plugin-packaged variant. Codex exposes ${PLUGIN_ROOT} for resources
// inside the installed plugin, so the public bundle can use the native path
// instead of relying on its Claude compatibility alias.
export function buildCodexPluginHooksManifest() {
  return {
    hooks: buildClaudeCompatibleHooks('Edit|Write|apply_patch', CODEX_PLUGIN_SCRIPTS, { windows: true }),
  };
}

// `skillDir` is the install's own dot-directory (a provider's configDir), so the
// emitted command points at that install's payload. Defaults to `.codex` for the
// Codex provider, whose self-consistent bundle keeps the skill at `.codex/skills`.
export function buildCodexHooksManifest(skillDir = '.codex') {
  return {
    hooks: buildClaudeCompatibleHooks('Edit|Write|apply_patch', codexProjectScripts(skillDir), { windows: true }),
  };
}

// GitHub Copilot reads project hooks from `.github/hooks/*.json`. Its schema
// differs from Claude/Codex: the event key is lowercase `postToolUse`,
// each entry is flat (no nested `hooks` array), the command lives under `bash`
// (with an optional `powershell` sibling), the timeout key is `timeoutSec`, and
// `matcher` is a full-match regex (`^(?:PATTERN)$`) tested against the tool name.
// Copilot's file-editing tool names vary by surface (verified against CLI
// 1.0.63): `copilot -p` runs use `edit` ({path, old_str, new_str}) and `create`
// ({path, file_text}); interactive sessions and the cloud agent use
// `apply_patch` (a raw OpenAI-format patch string). The matcher covers all
// three. The same manifest is honored by both the CLI and the cloud/app agent.
// https://docs.github.com/en/copilot/reference/hooks-reference
export function buildGitHubHooksManifest() {
  return {
    version: 1,
    hooks: {
      postToolUse: [
        {
          type: 'command',
          matcher: 'edit|create|apply_patch',
          bash: guardedLauncher(launcherIn(GITHUB_PROJECT_SCRIPTS)),
          timeoutSec: TIMEOUT_SECONDS,
        },
      ],
    },
  };
}

// oh-my-pi's hook is a loaded JS module (`pi.on(eventName, handler)`), not a
// JSON manifest, so this is the one builder that returns literal file
// content rather than an object every other caller JSON.stringify's — see
// `hooksJsonFor()`'s `isModule` tag below. The exported function's name,
// `impeccableHook`, is load-bearing: it is the marker
// `skill/scripts/context.mjs`, `skill/scripts/hook-admin.mjs`, and
// `cli/bin/commands/skills.mjs` each scan for (as `OMP_HOOK_MODULE_MARKER` or
// its inline equivalent) to detect whether this hook is installed, since the
// path string these markers use for every other provider never appears here
// literally (it is built via `join(...)` with separate segments below).
// Renaming it breaks detection in all three without any test failing here.
// The payload it sends to hook.mjs
// on stdin is deliberately shaped exactly like Claude Code's own
// PostToolUse/Stop JSON: hook-lib.mjs's extraction (`resolveTargetFiles()`,
// `isStopEvent()`, the `stop_hook_active` re-entrancy guard) and its default
// `payload()` output are shape-driven, not harness-gated, and
// `resolveHarness()` has no 'omp' branch — a payload this shape falls
// through to the 'claude' default on both ends, so hook-lib.mjs needs no
// changes at all. `spawnSync` (not `pi.exec()`) is used deliberately:
// `pi.exec()`'s documented options carry no stdin, which hook.mjs requires.
export function buildOmpHookModule() {
  return readFileSync(new URL('../../../crates/context/assets/omp-hook.js', import.meta.url), 'utf8');
}

export function hooksJsonFor(provider, options = {}) {
  switch (provider) {
    case 'claude':
      return buildClaudeSettingsManifest();
    case 'codex':
      return buildCodexHooksManifest(options.configDir || '.codex');
    case 'github':
      return buildGitHubHooksManifest();
    case 'omp':
      return { isModule: true, content: buildOmpHookModule() };
    default:
      return null;
  }
}
