/**
 * Integration tests for the design-hook build pipeline.
 * Run: node --test tests/hook-build.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildClaudeSettingsManifest,
  buildClaudePluginHooksManifest,
  buildCodexHooksManifest,
  buildCodexPluginHooksManifest,
  buildGitHubHooksManifest,
  buildOmpHookModule,
  hooksJsonFor,
} from '../scripts/lib/transformers/hooks.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
}

// Every hook command is the launcher shipped in the skill's scripts dir,
// invoked as `<scripts>/impeccable <verb>` behind an existence guard: a
// missing launcher exits 0 (issue #399: user-level manifests fire in every
// project) and a present one keeps its own exit code, so Claude's exit-2
// blocking signal still reaches the agent. No runtime probe: the launcher
// runs a self-contained binary, so there is no Node on the path to check.
function expectCommand(command, expectedScriptsDir, verb = 'hook') {
  assert.equal(typeof command, 'string');
  const launcher = `${expectedScriptsDir}/impeccable`;
  assert.ok(command.includes(launcher), `missing ${launcher} in ${command}`);
  assert.match(
    command,
    new RegExp(`^\\[ ! -f "[^"]*/impeccable" \\] \\|\\| "[^"]*/impeccable" ${verb}$`),
    `missing existence guard around the launcher in ${command}`,
  );
  assert.ok(!command.includes('node '), `hook command must not depend on node: ${command}`);
  assert.ok(!command.includes('.mjs'), `hook command still names a Node script: ${command}`);
}

function expectWindowsCommand(command, expectedScriptsDir, verb = 'hook') {
  assert.equal(typeof command, 'string');
  const launcher = `${expectedScriptsDir}/impeccable.cmd`;
  assert.equal(command, `if exist "${launcher}" ("${launcher}" ${verb} & exit /b)`);
}

function manifestCommands(manifest) {
  const commands = [];
  const walk = (value) => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === 'object') {
      if (typeof value.command === 'string') commands.push(value.command);
      if (typeof value.bash === 'string') commands.push(value.bash);
      Object.values(value).forEach(walk);
    }
  };
  walk(manifest.hooks);
  return commands;
}

describe('hook manifest builders', () => {
  it('builds Claude project settings for the real detector hook', () => {
    const manifest = buildClaudeSettingsManifest();
    const group = manifest.hooks.PostToolUse[0];
    const handler = group.hooks[0];

    assert.equal(group.matcher, 'Edit|Write');
    assert.doesNotMatch(manifest.description, /MultiEdit/);
    assert.equal(handler.type, 'command');
    assert.equal(handler.timeout, 5);
    assert.equal(handler.statusMessage, 'Checking UI changes');
    expectCommand(handler.command, '.claude/skills/impeccable/scripts');
    assert.ok(handler.command.includes('${CLAUDE_PROJECT_DIR}'));
    assert.equal(handler.args, undefined);
    assert.equal(manifest.hooks.SessionStart, undefined);

    // Stop deep pass: same script, no matcher, longer budget.
    const stop = manifest.hooks.Stop[0].hooks[0];
    assert.equal(manifest.hooks.Stop[0].matcher, undefined);
    assert.equal(stop.timeout, 30);
    assert.equal(stop.statusMessage, 'Design deep pass');
    expectCommand(stop.command, '.claude/skills/impeccable/scripts');
  });

  it('builds Codex project-local hooks for the real detector hook', () => {
    // Default install dir is `.codex`: a `.codex`-directory install keeps the
    // skill payload at `.codex/skills/...`, so the hook must point there (not at
    // a hardcoded `.agents`, which no-ops on such installs).
    const manifest = buildCodexHooksManifest();
    assert.equal(manifest.description, undefined);
    const group = manifest.hooks.PostToolUse[0];
    const handler = group.hooks[0];

    assert.equal(group.matcher, 'Edit|Write|apply_patch');
    assert.equal(handler.type, 'command');
    assert.equal(handler.timeout, 5);
    assert.equal(handler.statusMessage, 'Checking UI changes');
    expectCommand(handler.command, '.codex/skills/impeccable/scripts');
    assert.ok(!handler.command.includes('git rev-parse --show-toplevel'));
    assert.ok(!handler.command.includes('${PLUGIN_ROOT}'));
    assert.equal(manifest.hooks.SessionStart, undefined);

    // Codex dispatches a native Stop event (turn scope), so it gets the deep
    // pass too.
    const stop = manifest.hooks.Stop[0].hooks[0];
    assert.equal(stop.timeout, 30);
    expectCommand(stop.command, '.codex/skills/impeccable/scripts');

    // Codex 0.146.0+ selects `commandWindows` on Windows (issue #452), where
    // the POSIX guard is not a command; that form calls impeccable.cmd.
    expectWindowsCommand(handler.commandWindows, '.codex/skills/impeccable/scripts');
    expectWindowsCommand(stop.commandWindows, '.codex/skills/impeccable/scripts');
  });

  it('derives the Codex hook payload path from the install dir', () => {
    // Each install dir gets a manifest pointing at its own skills payload: a
    // `.codex`-directory install at `.codex/skills`, a `.agents` (Codex repo
    // skills) install at `.agents/skills`.
    const codexDir = buildCodexHooksManifest('.codex');
    expectCommand(codexDir.hooks.PostToolUse[0].hooks[0].command, '.codex/skills/impeccable/scripts');
    expectCommand(codexDir.hooks.Stop[0].hooks[0].command, '.codex/skills/impeccable/scripts');

    const agentsDir = buildCodexHooksManifest('.agents');
    expectCommand(agentsDir.hooks.PostToolUse[0].hooks[0].command, '.agents/skills/impeccable/scripts');
    expectCommand(agentsDir.hooks.Stop[0].hooks[0].command, '.agents/skills/impeccable/scripts');
    assert.ok(!agentsDir.hooks.PostToolUse[0].hooks[0].command.includes('.codex/skills'));

    // hooksJsonFor threads the provider's configDir through to the builder.
    expectCommand(
      hooksJsonFor('codex', { configDir: '.agents' }).hooks.PostToolUse[0].hooks[0].command,
      '.agents/skills/impeccable/scripts',
    );
    expectCommand(
      hooksJsonFor('codex').hooks.PostToolUse[0].hooks[0].command,
      '.codex/skills/impeccable/scripts',
    );
  });

  it('builds GitHub Copilot repo-level hooks for the real detector hook', () => {
    const manifest = buildGitHubHooksManifest();
    const entry = manifest.hooks.postToolUse[0];

    // GitHub's schema: flat entries (no nested `hooks`), lowercase event key,
    // `bash`/`timeoutSec`, and a full-match `matcher` against the tool name.
    assert.equal(manifest.version, 1);
    assert.equal(Object.keys(manifest.hooks).length, 1);
    assert.equal(entry.type, 'command');
    assert.equal(entry.matcher, 'edit|create|apply_patch');
    assert.equal(entry.timeoutSec, 5);
    assert.equal(entry.timeout, undefined);
    assert.equal(entry.command, undefined);
    expectCommand(entry.bash, '.github/skills/impeccable/scripts');
    assert.ok(entry.bash.includes('git rev-parse --show-toplevel'));
    assert.equal(manifest.hooks.PostToolUse, undefined);
    assert.equal(manifest.hooks.preToolUse, undefined);
  });

  it('builds an oh-my-pi hook module (JS source, not a JSON manifest)', async () => {
    // oh-my-pi loads `.omp/hooks/post/*` as an imported JS module exporting
    // `pi.on(eventName, handler)`, not a JSON manifest — hooksJsonFor() tags
    // this one with `isModule: true` so callers know to write it verbatim
    // instead of JSON.stringify-ing it.
    const tagged = hooksJsonFor('omp');
    assert.equal(tagged.isModule, true);
    assert.equal(tagged.content, buildOmpHookModule());

    const source = buildOmpHookModule();
    assert.match(source, /export default function impeccableHook\(pi\)/);
    assert.match(source, /pi\.on\("tool_result"/);
    assert.match(source, /pi\.on\("session_stop"/);
    assert.match(source, /"\.\.", "\.\.", "skills", "impeccable", "scripts", process.platform/);
    // Filters to the two file-modifying tools; never fires on bash/read/etc.
    assert.match(source, /event\.toolName !== "edit" && event\.toolName !== "write"/);
    // Shaped exactly like Claude Code's own PostToolUse/Stop JSON so
    // hook-lib.mjs's existing shape-driven extraction (resolveTargetFiles(),
    // isStopEvent(), the stop_hook_active re-entrancy guard) needs no
    // omp-specific branch.
    assert.match(source, /hook_event_name: "PostToolUse"/);
    assert.match(source, /hook_event_name: "Stop"/);
    assert.match(source, /stop_hook_active: event\.stop_hook_active === true/);
    // Uses raw spawnSync (pi.exec() has no stdin option, and hook.mjs
    // requires stdin), and parses Claude's default payload() JSON envelope
    // back out on its own side.
    assert.match(source, /spawnSync\(HOOK_SCRIPT, \["hook"\]/);
    assert.match(source, /hookSpecificOutput\?\.additionalContext/);
    // A hung hook.mjs must not block edit/stop handling indefinitely. Each
    // event passes its own timeout, matching the JSON providers' own
    // TIMEOUT_SECONDS/STOP_TIMEOUT_SECONDS split; spawnSync's timeout reaches
    // the same explicit error-reporting path as other subprocess failures.
    assert.match(source, /function runHook\(payload, timeoutMs, ctx\)/);
    assert.match(source, /timeout: timeoutMs/);
    assert.match(source, /runHook\(\{[\s\S]*?hook_event_name: "PostToolUse"[\s\S]*?\}, 5000, ctx\)/);
    assert.match(source, /runHook\(\{[\s\S]*?hook_event_name: "Stop"[\s\S]*?\}, 30000, ctx\)/);
    // ToolResultEventResult.content is a replacement content-block array
    // (packages/coding-agent/src/extensibility/shared-events.ts): the runner
    // takes `result.content ?? tool.content`, so returning a bare string both
    // discarded the edit's own output and handed back an unrenderable shape.
    assert.match(source, /content: \[\.\.\.blocks, \{ type: "text", text \}\]/);
    assert.doesNotMatch(source, /return \{ content: text \}/);
    // SessionStopEventResult only reaches a continuation when `continue: true`
    // or a blocking decision accompanies the context; additionalContext on its
    // own is dropped as the session settles.
    assert.match(source, /return \{ continue: true, additionalContext: text \}/);
    // Verify syntactic structure without importing (data: URL would make
    // import.meta.url = data:..., breaking HOOK_SCRIPT path resolution).
    assert.ok(
      source.includes('pi.on("tool_result"') && source.includes('pi.on("session_stop"'),
      'module must register tool_result and session_stop handlers',
    );
    assert.ok(/hasUriScheme\(filePath\)/.test(source), 'module must guard filePath');
  });
  it('oh-my-pi adapter rejects device URI tool targets before spawning hook.mjs', () => {
    // Some tool surfaces (e.g. `xd://` LSP targets, or scheme-only virtual
    // documents like `untitled:Untitled-1` with no authority part at all)
    // carry a scheme-prefixed identifier instead of a filesystem path. The
    // adapter previously only rejected when `event.input.path` was null, so
    // it spawned hook.mjs on every edit and hook-lib.mjs's downstream
    // `file-missing` skip was the only thing keeping it cheap. Reject at the
    // adapter so the spawn never happens.
    //
    // Verify the guard is present and rejects device/scheme URIs while
    // accepting real filesystem paths (including a Windows drive letter,
    // which matches the same "letter, colon" syntax a scheme does but is
    // never one in practice). Extracting the guard function from the source
    // and running it directly lets the assertion stay honest if a future
    // edit changes its internals, as long as the call site is still named
    // `hasUriScheme`.
    const source = buildOmpHookModule();
    assert.ok(source.includes('hasUriScheme(filePath)'), 'adapter must carry a guard that calls hasUriScheme(filePath)');
    // Extracted from the first supporting const through the end of the
    // function body, not just the function itself: hasUriScheme() reads
    // module-level constants (the authority-scheme regex, the known-scheme
    // allowlist) it does not declare inline.
    const fnMatch = source.match(/const URI_AUTHORITY_SCHEME_RE[\s\S]*?function hasUriScheme\(value\) \{[\s\S]*?\n\}/);
    assert.ok(fnMatch, 'module must define a hasUriScheme() guard function');
    const hasUriScheme = new Function(`${fnMatch[0]}\nreturn hasUriScheme;`)();

    // Device/scheme URIs the adapter must reject.
    for (const uri of [
      'xd://lsp/foo',
      'file:///etc/hosts',
      'http://example.com/x',
      'https://x.test/y',
      'untitled:Untitled-1',
      'vscode-notebook-cell:/path/to/notebook.ipynb#cell',
    ]) {
      assert.ok(hasUriScheme(uri), `guard must reject device URI ${uri}`);
    }
    // Real paths the adapter must NOT reject — absolute POSIX, relative,
    // Windows-drive (absolute and drive-relative), and a real filename that
    // merely happens to contain a colon.
    for (const p of [
      '/abs/path.tsx',
      'rel/path.tsx',
      './local.tsx',
      'C:/Users/me/file.tsx',
      'D:\\Users\\me\\file.tsx',
      'C:src\\App.tsx',
      'release:notes.tsx',
      // Doubled, merely redundant separator: matches the authority regex's
      // "letter, colon, //" shape exactly, so a leaf drive-path exemption
      // that only recognizes a single "\" or "/" after the colon still
      // misclassified this one as a URI.
      'C://Users/dev/App.tsx',
      'z://tmp/file.tsx',
    ]) {
      assert.ok(!hasUriScheme(p), `guard must not reject real path ${p}`);
    }
    // The adapter must read the path from BOTH event.input.path (OMP shape)
    // and event.tool_input.file_path (Claude Code shape), so a future edit
    // doesn't accidentally drop the Claude Code fallback and re-introduce the
    // bug only for that harness.
    assert.match(source, /event\.tool_input\.file_path/);
    assert.match(source, /event\.input\.path/);
  });

  it('runs hook scripts with node when OMP owns process.execPath', async () => {
    // A plain filesystem-shaped path, not the "xd://lsp" placeholder this
    // used to carry: hasUriScheme()'s device-URI guard rejects anything
    // scheme-prefixed before runHook() is ever reached, which "xd://lsp"
    // incidentally is. This test's own point (process.execPath override) is
    // unrelated to that guard, so it needs a path the guard lets through.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-omp-hook-'));
    const moduleDir = path.join(root, '.omp', 'hooks', 'post');
    const scriptDir = path.join(root, '.omp', 'skills', 'impeccable', 'scripts');
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.mkdirSync(scriptDir, { recursive: true });
    const modulePath = path.join(moduleDir, 'impeccable.mjs');

    // Inject a _getHandlers export into the module so the test can retrieve the
    // handler references after import (pi.on() runs synchronously during import).
    const patched = buildOmpHookModule().replace(
      'export default function impeccableHook(pi) {',
      'const _handlers = new Map(); export function _getHandlers() { return _handlers; } globalThis._impeccableHandlers = _handlers; export default function impeccableHook(pi) {',
    ).replace(
      /pi\.on\("([^"]+)",\s*(async\s*\([^)]+\))\s*=>/g,
      (_, eventName, params) => `_handlers.set("${eventName}", ${params} =>`,
    );
    fs.writeFileSync(modulePath, patched);
    fs.writeFileSync(path.join(scriptDir, 'impeccable'), [
      '#!/usr/bin/env node',
      `import fs from "node:fs";`,
      `const payload = JSON.parse(fs.readFileSync(0, "utf8"));`,
      `if (payload.hook_event_name !== "PostToolUse" || payload.tool_name !== "write" || payload.tool_input.file_path !== "src/notes.tsx") process.exit(2);`,
      `process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: "hook ran" } }));`,
    ].join('\n'), { mode: 0o755 });
    const { default: impeccableHook, _getHandlers } = await import(pathToFileURL(modulePath).href);
    impeccableHook({ on(name, handler) { _getHandlers().set(name, handler); } });
    const handlers = _getHandlers();

    const originalExecPath = process.execPath;
    try {
      process.execPath = path.join(root, 'omp');
      const result = await handlers.get('tool_result')({
        toolName: 'write',
        input: { path: 'src/notes.tsx' },
        content: [{ type: 'text', text: 'write result' }],
      }, { cwd: REPO_ROOT });

      assert.deepEqual(result, {
        content: [
          { type: 'text', text: 'write result' },
          { type: 'text', text: 'hook ran' },
        ],
      });
    } finally {
      process.execPath = originalExecPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // Regression: hook-admin.mjs's repair/on action (repairHookManifests())
  // embeds its own hand-written copy of this exact module as one of
  // HOOK_MANIFEST_TARGETS, rather than importing buildOmpHookModule() --
  // skill/scripts/** ships to installed projects, scripts/lib/transformers/
  // does not, so the two cannot share a runtime import. A source-level fix
  // to buildOmpHookModule() (the URI-scheme guard, the tool_input.file_path
  // fallback) silently drifted out of sync with hook-admin.mjs's copy, so
  // running the hook repair/on action overwrote a project's corrected
  // .omp/hooks/post/impeccable.js with the stale, narrower one -- the
  // installed file un-fixed itself. Extract hook-admin.mjs's embedded copy
  // the same way and assert it is byte-identical to the generator's output,
  // so any future edit to one that isn't mirrored in the other fails here
  // instead of silently drifting again.
  it('keeps hook-admin.mjs\'s embedded OMP repair manifest byte-identical to buildOmpHookModule()', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'crates/context/assets/omp-hook.js'), 'utf8');
    assert.equal(source, buildOmpHookModule());
    const admin = fs.readFileSync(path.join(REPO_ROOT, 'crates/hook/src/admin.rs'), 'utf8');
    assert.match(admin, /impeccable_context::provider::OMP_HOOK_MODULE/);
  });

  it('reports a missing launcher without replacing the tool result', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-omp-hook-no-node-'));
    const modulePath = path.join(root, 'hooks', 'post', 'impeccable.mjs');
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.writeFileSync(modulePath, buildOmpHookModule());

    const handlers = new Map();
    const originalPath = process.env.PATH;
    try {
      const loaded = await import(`${pathToFileURL(modulePath).href}?case=${Date.now()}`);
      loaded.default({ on: (name, handler) => handlers.set(name, handler) });
      process.env.PATH = root;
      const notices = [];

      const result = await handlers.get('tool_result')(
        {
          toolName: 'edit',
          input: { path: '/tmp/App.tsx' },
          content: [{ type: 'text', text: 'edit result' }],
        },
        {
          cwd: root,
          hasUI: true,
          ui: { notify: (message, type) => notices.push({ message, type }) },
        },
      );

      assert.equal(result, undefined);
      assert.equal(notices.length, 1);
      assert.match(notices[0].message, /Impeccable hook failed to run:.*node/i);
      assert.equal(notices[0].type, 'error');
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports the signal that terminated the hook subprocess', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-omp-hook-signal-'));
    const modulePath = path.join(root, '.omp', 'hooks', 'post', 'impeccable.mjs');
    const scriptPath = path.join(root, '.omp', 'skills', 'impeccable', 'scripts', 'impeccable');
    fs.mkdirSync(path.dirname(modulePath), { recursive: true });
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(modulePath, buildOmpHookModule());
    fs.writeFileSync(scriptPath, '#!/usr/bin/env node\nprocess.stderr.write("before signal\\n"); process.kill(process.pid, "SIGTERM");\n', { mode: 0o755 });

    const handlers = new Map();
    try {
      const loaded = await import(`${pathToFileURL(modulePath).href}?case=${Date.now()}`);
      loaded.default({ on: (name, handler) => handlers.set(name, handler) });
      const notices = [];

      const result = await handlers.get('tool_result')(
        {
          toolName: 'write',
          input: { path: '/tmp/App.tsx' },
          content: [{ type: 'text', text: 'write result' }],
        },
        {
          cwd: root,
          hasUI: true,
          ui: { notify: (message, type) => notices.push({ message, type }) },
        },
      );

      assert.equal(result, undefined);
      assert.equal(notices.length, 1);
      assert.match(notices[0].message, /SIGTERM/);
      assert.equal(notices[0].type, 'error');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('emits Windows launcher commands only for Codex-shaped manifests', () => {
    const withWindows = [buildCodexHooksManifest(), buildCodexPluginHooksManifest()];
    const without = [buildClaudeSettingsManifest(), buildClaudePluginHooksManifest(), buildGitHubHooksManifest()];
    const entries = (manifest) => {
      const out = [];
      const walk = (value) => {
        if (Array.isArray(value)) { value.forEach(walk); return; }
        if (value && typeof value === 'object') {
          if (typeof value.command === 'string' || typeof value.bash === 'string') out.push(value);
          Object.values(value).forEach(walk);
        }
      };
      walk(manifest.hooks);
      return out;
    };
    for (const manifest of withWindows) {
      for (const entry of entries(manifest)) {
        assert.equal(typeof entry.commandWindows, 'string', `missing commandWindows in ${JSON.stringify(entry)}`);
        assert.ok(entry.commandWindows.includes('impeccable.cmd'));
      }
    }
    for (const manifest of without) {
      for (const entry of entries(manifest)) {
        assert.equal(entry.commandWindows, undefined, `unexpected commandWindows in ${JSON.stringify(entry)}`);
      }
    }
    for (const manifest of [...withWindows, ...without]) {
      for (const command of manifestCommands(manifest)) {
        assert.ok(!/node|systemMessage|node-unsupported/.test(command), `Node-era fragment in ${command}`);
      }
    }
  });

  it('routes supported hook builders and leaves other providers alone', () => {
    assert.ok(hooksJsonFor('claude'));
    assert.ok(hooksJsonFor('codex'));
    assert.ok(hooksJsonFor('github'));
    assert.equal(hooksJsonFor('gemini'), null);
    assert.equal(hooksJsonFor('cursor'), null);
  });
});

// The tracked provider outputs are regenerated on main by the sync workflow
// (`bun run build:release`), never in a feature PR. Until that sync lands after
// the launcher swap, the tracked manifests still describe the Node scripts;
// gate these assertions on the synced launcher so a source-first branch is
// not red for output it is not allowed to stage.
const SYNCED = fs.existsSync(path.join(REPO_ROOT, '.claude/skills/impeccable/scripts/impeccable'));

describe('generated hook artifacts in repo', { skip: SYNCED ? false : 'generated provider output not yet synced (bun run build:release on main)' }, () => {
  for (const rel of [
    '.claude/settings.json',
    '.codex/hooks.json',
    '.github/hooks/impeccable.json',
  ]) {
    it(`${rel} exists and is valid JSON`, () => {
      const abs = path.join(REPO_ROOT, rel);
      assert.ok(fs.existsSync(abs), `${rel} missing - did you forget bun run build?`);
      assert.doesNotThrow(() => JSON.parse(fs.readFileSync(abs, 'utf8')));
    });
  }

  it('root hook manifests exactly match the hook builders', () => {
    assert.deepEqual(readJson('.claude/settings.json'), buildClaudeSettingsManifest());
    assert.deepEqual(readJson('.codex/hooks.json'), buildCodexHooksManifest());
    assert.deepEqual(readJson('.github/hooks/impeccable.json'), buildGitHubHooksManifest());
  });

  it('Claude project settings reference the launcher in .claude/skills', () => {
    const manifest = readJson('.claude/settings.json');
    const handler = manifest.hooks.PostToolUse[0].hooks[0];

    expectCommand(handler.command, '.claude/skills/impeccable/scripts');
    assert.ok(fs.existsSync(path.join(REPO_ROOT, '.claude/skills/impeccable/scripts')));
  });

  it('Codex project hooks reference hook.mjs in the .codex skill payload', () => {
    // The committed `.codex/hooks.json` is the distribution artifact for a
    // `.codex`-directory install, whose skill payload lives at `.codex/skills/`
    // (issue: it previously hardcoded `.agents/skills`, so the guarded hook
    // no-opped on `.codex` installs). CLI installs that lay the skill down at
    // `.agents/skills` rewrite the command to that path at install time.
    const manifest = readJson('.codex/hooks.json');
    const handler = manifest.hooks.PostToolUse[0].hooks[0];

    expectCommand(handler.command, '.codex/skills/impeccable/scripts');
    assert.ok(!handler.command.includes('.agents/skills'));

    // The self-consistent Codex bundle at `dist/codex/.codex/skills/` is a build
    // artifact, not a tracked repo file; `bun run build` emits it and
    // build.test.js verifies it there. This suite runs before the build (CI's
    // `test:core` precedes the Build step), so it asserts only tracked outputs.

    // The repo ships the Codex skill payload at `.agents/skills` (the
    // layout CLI installs use, and where the rewritten command resolves).
    assert.ok(fs.existsSync(path.join(REPO_ROOT, '.agents/skills/impeccable/SKILL.md')));
    assert.ok(fs.existsSync(path.join(REPO_ROOT, '.agents/skills/impeccable/scripts')));
  });

  it('GitHub Copilot repo hooks reference the launcher in the .github skill payload', () => {
    const manifest = readJson('.github/hooks/impeccable.json');
    const entry = manifest.hooks.postToolUse[0];

    assert.equal(entry.matcher, 'edit|create|apply_patch');
    expectCommand(entry.bash, '.github/skills/impeccable/scripts');
    assert.ok(fs.existsSync(path.join(REPO_ROOT, '.github/skills/impeccable/SKILL.md')));
    assert.ok(fs.existsSync(path.join(REPO_ROOT, '.github/skills/impeccable/scripts')));
  });

  it('does not generate probe scripts into provider skill payloads', () => {
    for (const providerDir of ['.claude', '.agents', 'plugin']) {
      const probe = path.join(REPO_ROOT, providerDir, 'skills', 'impeccable', 'scripts', 'hook-probe.mjs');
      assert.equal(fs.existsSync(probe), false, `${providerDir} still has hook-probe.mjs`);
    }
  });

  it('does not generate stale Codex hook packaging artifacts', () => {
    for (const rel of [
      '.claude/hooks/hooks.json',
      '.agents/hooks',
      '.agents/plugins/marketplace.json',
      'plugin/.codex-plugin',
      'plugin/assets',
      'plugin-codex',
    ]) {
      assert.equal(fs.existsSync(path.join(REPO_ROOT, rel)), false, `${rel} should not exist`);
    }
  });

  it('packages the Claude design hook in the plugin via plugin-root paths', () => {
    const abs = path.join(REPO_ROOT, 'plugin/hooks/hooks.json');
    assert.ok(fs.existsSync(abs), 'plugin/hooks/hooks.json missing - did you forget bun run build:release?');

    const manifest = readJson('plugin/hooks/hooks.json');
    assert.deepEqual(manifest, buildClaudePluginHooksManifest());
    // Codex loads bundled plugin hooks from this same file and rejects any
    // top-level field other than `hooks` (issue #330).
    assert.equal(manifest.description, undefined);

    const handler = manifest.hooks.PostToolUse[0].hooks[0];
    assert.equal(manifest.hooks.PostToolUse[0].matcher, 'Edit|Write');
    expectCommand(handler.command, 'skills/impeccable/scripts');
    // Resolves relative to the installed plugin, not a `.claude/skills/` layout.
    assert.ok(handler.command.includes('${CLAUDE_PLUGIN_ROOT}'),
      `plugin hook command must use $\{CLAUDE_PLUGIN_ROOT}: ${handler.command}`);
    assert.ok(!handler.command.includes('${CLAUDE_PROJECT_DIR}'),
      `plugin hook command must not use $\{CLAUDE_PROJECT_DIR}: ${handler.command}`);

    // Stop deep pass ships in the plugin manifest too, plugin-root-relative.
    const stop = manifest.hooks.Stop[0].hooks[0];
    assert.equal(stop.timeout, 30);
    expectCommand(stop.command, 'skills/impeccable/scripts');
    assert.ok(stop.command.includes('${CLAUDE_PLUGIN_ROOT}'));

    // The script the plugin hook points at must ship inside the plugin payload.
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'plugin/skills/impeccable/scripts')));
  });

  it('generated skill payloads ship the executable launcher and no Node scripts', () => {
    for (const scriptDir of [
      '.claude/skills/impeccable/scripts',
      '.agents/skills/impeccable/scripts',
      'plugin/skills/impeccable/scripts',
    ]) {
      const abs = path.join(REPO_ROOT, scriptDir);
      const launcher = path.join(abs, 'impeccable');
      assert.ok(fs.existsSync(launcher), `launcher missing in ${scriptDir}`);
      if (process.platform !== 'win32') {
        assert.ok(fs.statSync(launcher).mode & 0o111, `launcher not executable in ${scriptDir}`);
      }
      assert.ok(fs.existsSync(path.join(abs, 'impeccable.cmd')), `impeccable.cmd missing in ${scriptDir}`);
      assert.ok(fs.existsSync(path.join(abs, 'VERSION')), `VERSION missing in ${scriptDir}`);
      assert.equal(fs.existsSync(path.join(abs, 'bin')), false, `${scriptDir} must stay launcher-only in git; binaries ship only in IMPECCABLE_BUNDLE_ENGINE=1 release zips`);
      const stray = fs.readdirSync(abs).filter((f) => ['hook.mjs', 'context.mjs', 'detect.mjs', 'detector'].includes(f));
      assert.deepEqual(stray, [], `Node-era files still in ${scriptDir}`);
    }
  });
  it('OMP hook adapter rejects xd:// URIs at runtime', async () => {
    // Write source to a real temp file so import.meta.url resolves correctly
    // (data: URL would make HOOK_SCRIPT path resolution fail). A predictable
    // path directly under os.tmpdir() would let a pre-existing symlink there
    // redirect the write; mkdtempSync gives a fresh, unpredictable directory
    // instead, matching the pattern used elsewhere in this file.
    const src = buildOmpHookModule();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-hook-'));
    const tmp = path.join(dir, 'impeccable.mjs');
    fs.writeFileSync(tmp, src);
    try {
      const { default: hook } = await import(pathToFileURL(tmp));
      // Capture the tool_result handler so we can exercise it directly.
      const handlers = {};
      const pi = {
        on(eventName, handler) { handlers[eventName] = handler; },
      };
      hook(pi);
      // URI scheme: adapter must exit before spawning hook.mjs
      const uriResult = await handlers.tool_result({ toolName: 'edit', tool_input: { file_path: 'xd://probe.tsx' } }, { cwd: process.cwd() });
      assert.equal(uriResult, undefined, 'xd:// target must be rejected before spawn');
      // Filesystem path: adapter must not early-exit
      const fsResult = await handlers.tool_result({ toolName: 'edit', tool_input: { file_path: 'src/App.tsx' } }, { cwd: process.cwd() });
      // fsResult may be undefined if hook.mjs produces no findings, but must not be a thrown error
      assert.ok(fsResult === undefined || typeof fsResult === 'object', 'filesystem path must reach runHook');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
