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

export const IMPECCABLE_HOOK_COMMAND_MARKER = 'skills/impeccable/scripts/hook.mjs';

const TIMEOUT_SECONDS = 5;
const STATUS_MESSAGE = 'Checking UI changes';
// The Stop deep pass scans every UI file touched in the session with the
// full rule set, so it gets a longer budget than the single-file per-edit
// pass. Wired only for Claude Code and Codex, which both dispatch a native
// `Stop` hook event; GitHub Copilot's stop-style events do not feed context
// back to the model.
const STOP_TIMEOUT_SECONDS = 30;
const STOP_STATUS_MESSAGE = 'Design deep pass';

function stopEntry(command) {
  return {
    hooks: [
      {
        type: 'command',
        command,
        timeout: STOP_TIMEOUT_SECONDS,
        statusMessage: STOP_STATUS_MESSAGE,
      },
    ],
  };
}

const CLAUDE_PROJECT_HOOK = '${CLAUDE_PROJECT_DIR}/.claude/skills/impeccable/scripts/hook.mjs';
// The Node major the hook runtime requires, kept equal to the engines floor in
// package.json. The probe and the notice both derive from it so they cannot
// disagree about the supported version.
const NODE_MAJOR_FLOOR = 22;
// A hook manifest can be copied into a user-level settings file (issue #399:
// user-level hooks fire in every project, where a project-relative path may
// not exist). Guard node invocations so a missing file exits 0 without
// swallowing node's real exit code when the file is present.
//
// The runtime is guarded too (issue #410): a `node` on PATH too old for the
// hook's ESM syntax dies while hook.mjs is still being parsed, before the
// script's own always-exit-0 contract can run, so the harness reported a hook
// error on every edit and every Stop. Nothing written in ESM can report that
// condition, so the command string itself checks the version floor first, in
// ES5-only syntax that parses on any node old enough to fail it, and exits 0
// when the runtime is unsupported or missing.
//
// `notice` reports the dead runtime to the user. It is passed per harness
// because only some have a channel for it, checked against each harness's own
// hook reference on the events we hook:
//   Claude Code / Codex: `systemMessage` on stdout is shown to the user -> notice
//   Copilot: output contract unconfirmed; do not guess a shape -> probe only
//
// The clamp avoids `<` and `>` deliberately: Volta's Windows shims run through
// `cmd /C`, which reads an angle bracket in the `-e` payload as redirection, so
// `>=` failed before node ran at all and the guard reported a missing runtime on
// a machine that had a supported one (volta-cli/volta#1791). Newlines break the
// same way, so this payload also has to stay on one line.
const NODE_PROBE = `node -e "process.exit(Math.min(parseInt(process.versions.node,10),${NODE_MAJOR_FLOOR})===${NODE_MAJOR_FLOOR}?0:1)" 2>/dev/null`;
const guardedNode = (hookPath, notice = '') => {
  const probe = notice
    ? `! { ${NODE_PROBE} || { ${notice}; exit 0; }; }`
    : `! ${NODE_PROBE}`;
  return `[ ! -f "${hookPath}" ] || ${probe} || node "${hookPath}"`;
};

function buildClaudeCompatibleHooks(matcher, hookPath, notice = '') {
  const command = guardedNode(hookPath, notice);
  return {
    PostToolUse: [
      {
        matcher,
        hooks: [
          {
            type: 'command',
            command,
            timeout: TIMEOUT_SECONDS,
            statusMessage: STATUS_MESSAGE,
          },
        ],
      },
    ],
    Stop: [stopEntry(command)],
  };
}

// The message says `on PATH` deliberately: the common cause is a hook shell
// whose PATH misses the version manager, so a user already running Node 22
// needs to know the hook's PATH is at issue and not their install. Apostrophes
// cannot appear in it, since it travels inside a single-quoted shell string.
const NODE_NOTICE_TEXT = `The impeccable design hook is not running: no Node ${NODE_MAJOR_FLOOR} or newer on PATH. `
  + 'Install one, or remove the impeccable hook from your harness settings.';
// Claude Code and Codex both read `systemMessage`, so one payload serves both.
// The marker under ~/.impeccable holds it to one notice per machine (not per
// harness or per edit), and printf runs only after the marker write succeeds,
// so an unwritable HOME degrades to silence rather than a notice on every edit.
const SYSTEM_MESSAGE_NOTICE = 'D="$HOME/.impeccable"; [ -f "$D/node-unsupported" ] || '
  + '{ mkdir -p "$D" 2>/dev/null && : > "$D/node-unsupported" 2>/dev/null && '
  + `printf '%s' '{"systemMessage":"${NODE_NOTICE_TEXT}"}'; }`;
const CLAUDE_PLUGIN_HOOK = '${CLAUDE_PLUGIN_ROOT}/skills/impeccable/scripts/hook.mjs';
const CODEX_PLUGIN_HOOK = '${PLUGIN_ROOT}/skills/impeccable/scripts/hook.mjs';
// Codex reads project hooks from `.codex/hooks.json`, but the skill payload the
// hook invokes lives under the install's own skills dir: a `.codex`-directory
// install keeps it at `.codex/skills/...`, while a `.agents` (Codex repo-skills)
// install keeps it at `.agents/skills/...`. Derive the path from the install dir
// so each generated manifest points at its own payload rather than a hardcoded
// `.agents` — otherwise the guarded hook silently no-ops on `.codex` installs.
const codexProjectHook = (skillDir) => `${skillDir}/skills/impeccable/scripts/hook.mjs`;
const GITHUB_PROJECT_HOOK = '$(git rev-parse --show-toplevel)/.github/skills/impeccable/scripts/hook.mjs';

export function buildClaudeSettingsManifest() {
  return {
    description: 'Impeccable design detector: immediate-tier checks after Edit/Write on UI files, full-rule deep pass on Stop.',
    hooks: buildClaudeCompatibleHooks(
      'Edit|Write',
      CLAUDE_PROJECT_HOOK,
      SYSTEM_MESSAGE_NOTICE,
    ),
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
    hooks: buildClaudeCompatibleHooks(
      'Edit|Write',
      CLAUDE_PLUGIN_HOOK,
      SYSTEM_MESSAGE_NOTICE,
    ),
  };
}

// OpenAI plugin-packaged variant. Codex exposes ${PLUGIN_ROOT} for resources
// inside the installed plugin, so the public bundle can use the native path
// instead of relying on its Claude compatibility alias.
export function buildCodexPluginHooksManifest() {
  return {
    hooks: buildClaudeCompatibleHooks(
      'Edit|Write|apply_patch',
      CODEX_PLUGIN_HOOK,
      SYSTEM_MESSAGE_NOTICE,
    ),
  };
}

// `skillDir` is the install's own dot-directory (a provider's configDir), so the
// emitted command points at that install's payload. Defaults to `.codex` for the
// Codex provider, whose self-consistent bundle keeps the skill at `.codex/skills`.
export function buildCodexHooksManifest(skillDir = '.codex') {
  const hookPath = codexProjectHook(skillDir);
  return {
    hooks: buildClaudeCompatibleHooks(
      'Edit|Write|apply_patch',
      hookPath,
      SYSTEM_MESSAGE_NOTICE,
    ),
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
          bash: guardedNode(GITHUB_PROJECT_HOOK),
          timeoutSec: TIMEOUT_SECONDS,
        },
      ],
    },
  };
}

// oh-my-pi's hook is a loaded JS module (`pi.on(eventName, handler)`), not a
// JSON manifest, so this is the one builder that returns literal file
// content rather than an object every other caller JSON.stringify's — see
// `hooksJsonFor()`'s `isModule` tag below. The payload it sends to hook.mjs
// on stdin is deliberately shaped exactly like Claude Code's own
// PostToolUse/Stop JSON: hook-lib.mjs's extraction (`resolveTargetFiles()`,
// `isStopEvent()`, the `stop_hook_active` re-entrancy guard) and its default
// `payload()` output are shape-driven, not harness-gated, and
// `resolveHarness()` has no 'omp' branch — a payload this shape falls
// through to the 'claude' default on both ends, so hook-lib.mjs needs no
// changes at all. `spawnSync` (not `pi.exec()`) is used deliberately:
// `pi.exec()`'s documented options carry no stdin, which hook.mjs requires.
// Stamped as the first line of every generated module so the installer and
// hook-admin can recognize their own file without parsing it as JSON. Kept
// OUT of IMPECCABLE_HOOK_COMMAND_MARKERS on purpose: that array is scanned
// against raw text to decide "wired but unparseable JSON", and a module is
// never valid JSON, so listing it there would make every omp reset throw.
export const IMPECCABLE_HOOK_MODULE_MARKER = '@impeccable-hook-module';

// Modules emitted before the marker existed carry no stamp. They are already
// tracked and already shipping, so detection has to accept them too or reset
// would report success while leaving the hook armed (the issue #512 class).
export const IMPECCABLE_HOOK_MODULE_LEGACY_SIGNATURE = 'export default function impeccableHook(pi)';

/**
 * True when `text` is a module we generated: the current stamped form, or the
 * pre-marker form still present in older installs.
 */
export function isImpeccableHookModule(text) {
  if (typeof text !== 'string') return false;
  if (text.includes(IMPECCABLE_HOOK_MODULE_MARKER)) return true;
  return text.includes(IMPECCABLE_HOOK_MODULE_LEGACY_SIGNATURE) && text.includes('hook.mjs');
}

// oh-my-pi's hook is a loaded JS module (`pi.on(eventName, handler)`), not a
// JSON manifest, so this is the one builder that returns literal file
// content rather than an object every other caller JSON.stringify's — see
// `hooksJsonFor()`'s `isModule` tag below. The payload it sends to hook.mjs
// on stdin is deliberately shaped exactly like Claude Code's own
// PostToolUse/Stop JSON: hook-lib.mjs's extraction (`resolveTargetFiles()`,
// `isStopEvent()`, the `stop_hook_active` re-entrancy guard) and its default
// `payload()` output are shape-driven, not harness-gated, and
// `resolveHarness()` has no 'omp' branch — a payload this shape falls
// through to the 'claude' default on both ends, so hook-lib.mjs needs no
// changes at all. `spawnSync` (not `pi.exec()`) is used deliberately:
// `pi.exec()`'s documented options carry no stdin, which hook.mjs requires.
//
// `hookScript` is null for a project install, where the module sits a fixed
// two levels above the skill and can find hook.mjs from its own URL. A
// user-scope install puts the skill under ~/.omp/agent/skills while the hook
// still lands in the project, so that case passes a resolved absolute path.
export function buildOmpHookModule({ hookScript = null } = {}) {
  const resolveScript = hookScript
    ? `const HOOK_SCRIPT = ${JSON.stringify(hookScript)};`
    : `import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HOOK_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "impeccable", "scripts", "hook.mjs");`;

  return `// ${IMPECCABLE_HOOK_MODULE_MARKER} v1 — generated by impeccable; edits are overwritten.
import { spawnSync } from "node:child_process";
${resolveScript}

function runHook(payload) {
  const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  if (!result.stdout) return null;
  try {
    return JSON.parse(result.stdout)?.hookSpecificOutput?.additionalContext || null;
  } catch {
    return null;
  }
}

export default function impeccableHook(pi) {
  pi.on("tool_result", async (event, ctx) => {
    // ast_edit mutates files like edit and write do; omitting it left a whole
    // class of edits unscanned. apply_patch is deliberately absent: that is a
    // Claude/Codex tool name, not one oh-my-pi has.
    if (event.toolName !== "edit" && event.toolName !== "write" && event.toolName !== "ast_edit") return;
    // \`paths\` is the authoritative target list. \`path\` is a single-target
    // convenience the runner drops entirely once an edit touches two or more
    // files, so reading only \`path\` skipped every multi-file edit.
    const input = event.input || {};
    const targets = Array.isArray(input.paths)
      ? input.paths.filter((entry) => typeof entry === "string" && entry.length > 0)
      : typeof input.path === "string" && input.path.length > 0
        ? [input.path]
        : [];
    if (targets.length === 0) return;
    const findings = [];
    for (const filePath of targets) {
      const text = runHook({
        hook_event_name: "PostToolUse",
        tool_name: event.toolName,
        tool_input: { file_path: filePath },
        cwd: ctx.cwd,
      });
      if (text) findings.push(text);
    }
    if (findings.length === 0) return;
    // ToolResultEventResult.content is a replacement content-block array, not
    // a string: the runner takes \`result.content ?? tool.content\`, so a bare
    // string both discards the edit's own output and hands back a shape the
    // provider cannot render. Append a text block to what the tool produced.
    const blocks = Array.isArray(event.content) ? event.content : [];
    return { content: [...blocks, { type: "text", text: findings.join("\\n\\n") }] };
  });

  pi.on("session_stop", async (event, ctx) => {
    const text = runHook({
      hook_event_name: "Stop",
      stop_hook_active: event.stop_hook_active === true,
      cwd: ctx.cwd,
    });
    // additionalContext alone is dropped. The runner only carries it into a
    // continuation when \`continue: true\` (or a blocking decision) rides along,
    // so without this the Stop findings are discarded as the session settles.
    if (text) return { continue: true, additionalContext: text };
  });
}
`;
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
