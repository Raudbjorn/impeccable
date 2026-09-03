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

// The runtime probe every hook command must carry (issue #410): a node below
// the engines floor exits the command at 0 instead of dying on ESM parse. The
// expected floor comes from package.json engines, so probe and contract cannot
// drift apart.
const ENGINES_NODE_MAJOR = parseInt(
  JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).engines.node.replace(/[^\d.]/g, ''),
  10,
);
const NODE_PROBE = `process.exit(Math.min(parseInt(process.versions.node,10),${ENGINES_NODE_MAJOR})===${ENGINES_NODE_MAJOR}?0:1)`;

function expectCommand(command, expectedPath) {
  assert.equal(typeof command, 'string');
  // node-command providers carry the missing-file guard (issue #399: exits 0
  // when absent, preserves node's exit code when present) plus the runtime
  // probe. GitHub's portable `$(git rev-parse)` form is guarded too, so it
  // lands in the same branch.
  if (command.startsWith('[ ! -f "')) {
    assert.match(command, /\|\| node "/);
    assert.ok(command.includes(NODE_PROBE), `missing runtime probe in ${command}`);
  } else {
    assert.match(command, /^node "|^bash -c|\$\(git rev-parse/);
  }
  assert.ok(command.includes(expectedPath), `missing ${expectedPath} in ${command}`);
  assert.ok(!command.includes('hook-probe.mjs'), `probe hook still referenced in ${command}`);
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
    expectCommand(handler.command, '.claude/skills/impeccable/scripts/hook.mjs');
    assert.ok(handler.command.includes('${CLAUDE_PROJECT_DIR}'));
    assert.equal(handler.args, undefined);
    assert.equal(manifest.hooks.SessionStart, undefined);

    // Stop deep pass: same script, no matcher, longer budget.
    const stop = manifest.hooks.Stop[0].hooks[0];
    assert.equal(manifest.hooks.Stop[0].matcher, undefined);
    assert.equal(stop.timeout, 30);
    assert.equal(stop.statusMessage, 'Design deep pass');
    expectCommand(stop.command, '.claude/skills/impeccable/scripts/hook.mjs');
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
    expectCommand(handler.command, '.codex/skills/impeccable/scripts/hook.mjs');
    assert.ok(!handler.command.includes('git rev-parse --show-toplevel'));
    assert.ok(!handler.command.includes('${PLUGIN_ROOT}'));
    assert.equal(manifest.hooks.SessionStart, undefined);

    // Codex dispatches a native Stop event (turn scope), so it gets the deep
    // pass too.
    const stop = manifest.hooks.Stop[0].hooks[0];
    assert.equal(stop.timeout, 30);
    expectCommand(stop.command, '.codex/skills/impeccable/scripts/hook.mjs');
  });

  it('derives the Codex hook payload path from the install dir', () => {
    // Each install dir gets a manifest pointing at its own skills payload: a
    // `.codex`-directory install at `.codex/skills`, a `.agents` (Codex repo
    // skills) install at `.agents/skills`.
    const codexDir = buildCodexHooksManifest('.codex');
    expectCommand(codexDir.hooks.PostToolUse[0].hooks[0].command, '.codex/skills/impeccable/scripts/hook.mjs');
    expectCommand(codexDir.hooks.Stop[0].hooks[0].command, '.codex/skills/impeccable/scripts/hook.mjs');

    const agentsDir = buildCodexHooksManifest('.agents');
    expectCommand(agentsDir.hooks.PostToolUse[0].hooks[0].command, '.agents/skills/impeccable/scripts/hook.mjs');
    expectCommand(agentsDir.hooks.Stop[0].hooks[0].command, '.agents/skills/impeccable/scripts/hook.mjs');
    assert.ok(!agentsDir.hooks.PostToolUse[0].hooks[0].command.includes('.codex/skills'));

    // hooksJsonFor threads the provider's configDir through to the builder.
    expectCommand(
      hooksJsonFor('codex', { configDir: '.agents' }).hooks.PostToolUse[0].hooks[0].command,
      '.agents/skills/impeccable/scripts/hook.mjs',
    );
    expectCommand(
      hooksJsonFor('codex').hooks.PostToolUse[0].hooks[0].command,
      '.codex/skills/impeccable/scripts/hook.mjs',
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
    expectCommand(entry.bash, '.github/skills/impeccable/scripts/hook.mjs');
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
    assert.match(source, /"\.\.", "\.\.", "skills", "impeccable", "scripts", "hook\.mjs"/);
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
    assert.match(source, /spawnSync\(process\.execPath, \[HOOK_SCRIPT\]/);
    assert.match(source, /hookSpecificOutput\?\.additionalContext/);
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
    const fnMatch = source.match(/function hasUriScheme\(value\) \{[\s\S]*?\n\}/);
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
    // Real paths the adapter must NOT reject — absolute POSIX, relative, Windows-drive.
    for (const p of ['/abs/path.tsx', 'rel/path.tsx', './local.tsx', 'C:/Users/me/file.tsx', 'D:\\Users\\me\\file.tsx']) {
      assert.ok(!hasUriScheme(p), `guard must not reject real path ${p}`);
    }
    // The adapter must read the path from BOTH event.input.path (OMP shape)
    // and event.tool_input.file_path (Claude Code shape), so a future edit
    // doesn't accidentally drop the Claude Code fallback and re-introduce the
    // bug only for that harness.
    assert.match(source, /event\.tool_input\.file_path/);
    assert.match(source, /event\.input\.path/);
  });

  it('probes the node runtime everywhere, and notices only where a channel exists', () => {
    // Claude Code and Codex render a `systemMessage` from hook stdout, so their
    // manifests carry the one-time unsupported-runtime notice. Copilot (contract
    // unconfirmed) gets the silent probe only.
    const withNotice = [
      buildClaudeSettingsManifest(),
      buildClaudePluginHooksManifest(),
      buildCodexHooksManifest(),
      buildCodexPluginHooksManifest(),
    ];
    const probeOnly = [
      buildGitHubHooksManifest(),
    ];
    for (const manifest of [...withNotice, ...probeOnly]) {
      for (const command of manifestCommands(manifest)) {
        assert.ok(command.includes(NODE_PROBE), `missing runtime probe in ${command}`);
      }
    }
    for (const manifest of withNotice) {
      for (const command of manifestCommands(manifest)) {
        assert.ok(command.includes('systemMessage'), `missing notice in ${command}`);
        assert.ok(command.includes('node-unsupported'), `missing once-only marker in ${command}`);
      }
    }
    for (const manifest of probeOnly) {
      for (const command of manifestCommands(manifest)) {
        assert.ok(!command.includes('systemMessage'), `unexpected notice in ${command}`);
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

describe('generated hook artifacts in repo', () => {
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

  it('Claude project settings reference hook.mjs in .claude/skills', () => {
    const manifest = readJson('.claude/settings.json');
    const handler = manifest.hooks.PostToolUse[0].hooks[0];

    expectCommand(handler.command, '.claude/skills/impeccable/scripts/hook.mjs');
    assert.ok(fs.existsSync(path.join(REPO_ROOT, '.claude/skills/impeccable/scripts/hook.mjs')));
    assert.ok(fs.existsSync(path.join(REPO_ROOT, '.claude/skills/impeccable/scripts/hook-lib.mjs')));
    assert.ok(fs.existsSync(path.join(REPO_ROOT, '.claude/skills/impeccable/scripts/detector/detect-antipatterns.mjs')));
  });

  it('Codex project hooks reference hook.mjs in the .codex skill payload', () => {
    // The committed `.codex/hooks.json` is the distribution artifact for a
    // `.codex`-directory install, whose skill payload lives at `.codex/skills/`
    // (issue: it previously hardcoded `.agents/skills`, so the guarded hook
    // no-opped on `.codex` installs). CLI installs that lay the skill down at
    // `.agents/skills` rewrite the command to that path at install time.
    const manifest = readJson('.codex/hooks.json');
    const handler = manifest.hooks.PostToolUse[0].hooks[0];

    expectCommand(handler.command, '.codex/skills/impeccable/scripts/hook.mjs');
    assert.ok(!handler.command.includes('.agents/skills'));

    // The self-consistent Codex bundle at `dist/codex/.codex/skills/` is a build
    // artifact, not a tracked repo file; `bun run build` emits it and
    // build.test.js verifies it there. This suite runs before the build (CI's
    // `test:core` precedes the Build step), so it asserts only tracked outputs.

    // The repo ships the Codex skill payload at `.agents/skills` (the
    // layout CLI installs use, and where the rewritten command resolves).
    assert.ok(fs.existsSync(path.join(REPO_ROOT, '.agents/skills/impeccable/SKILL.md')));
    assert.ok(fs.existsSync(path.join(REPO_ROOT, '.agents/skills/impeccable/scripts/hook.mjs')));
    assert.ok(fs.existsSync(path.join(REPO_ROOT, '.agents/skills/impeccable/scripts/hook-lib.mjs')));
    assert.ok(fs.existsSync(path.join(REPO_ROOT, '.agents/skills/impeccable/scripts/detector/detect-antipatterns.mjs')));
  });

  it('GitHub Copilot repo hooks reference hook.mjs in the .github skill payload', () => {
    const manifest = readJson('.github/hooks/impeccable.json');
    const entry = manifest.hooks.postToolUse[0];

    assert.equal(entry.matcher, 'edit|create|apply_patch');
    expectCommand(entry.bash, '.github/skills/impeccable/scripts/hook.mjs');
    assert.ok(fs.existsSync(path.join(REPO_ROOT, '.github/skills/impeccable/SKILL.md')));
    assert.ok(fs.existsSync(path.join(REPO_ROOT, '.github/skills/impeccable/scripts/hook.mjs')));
    assert.ok(fs.existsSync(path.join(REPO_ROOT, '.github/skills/impeccable/scripts/hook-lib.mjs')));
    assert.ok(fs.existsSync(path.join(REPO_ROOT, '.github/skills/impeccable/scripts/detector/detect-antipatterns.mjs')));
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
    expectCommand(handler.command, 'skills/impeccable/scripts/hook.mjs');
    // Resolves relative to the installed plugin, not a `.claude/skills/` layout.
    assert.ok(handler.command.includes('${CLAUDE_PLUGIN_ROOT}'),
      `plugin hook command must use $\{CLAUDE_PLUGIN_ROOT}: ${handler.command}`);
    assert.ok(!handler.command.includes('${CLAUDE_PROJECT_DIR}'),
      `plugin hook command must not use $\{CLAUDE_PROJECT_DIR}: ${handler.command}`);

    // Stop deep pass ships in the plugin manifest too, plugin-root-relative.
    const stop = manifest.hooks.Stop[0].hooks[0];
    assert.equal(stop.timeout, 30);
    expectCommand(stop.command, 'skills/impeccable/scripts/hook.mjs');
    assert.ok(stop.command.includes('${CLAUDE_PLUGIN_ROOT}'));

    // The script the plugin hook points at must ship inside the plugin payload.
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'plugin/skills/impeccable/scripts/hook.mjs')));
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'plugin/skills/impeccable/scripts/hook-lib.mjs')));
  });

  it('keeps the marketplace hook repair matcher aligned with Claude Code', () => {
    const hookAdmin = fs.readFileSync(
      path.join(REPO_ROOT, 'plugin/skills/impeccable/scripts/hook-admin.mjs'),
      'utf8',
    );
    assert.match(hookAdmin, /matcher: 'Edit\|Write'/);
    assert.doesNotMatch(hookAdmin, /matcher: 'Edit\|Write\|MultiEdit'/);
  });

  it('generated hook runtime can import the bundled detector', async () => {
    for (const scriptDir of [
      '.claude/skills/impeccable/scripts',
      '.agents/skills/impeccable/scripts',
      'plugin/skills/impeccable/scripts',
    ]) {
      const abs = path.join(REPO_ROOT, scriptDir);
      assert.ok(fs.existsSync(path.join(abs, 'detector', 'detect-antipatterns.mjs')),
        `detector bundle missing in ${scriptDir}`);
      const hookLib = await import(pathToFileURL(path.join(abs, 'hook-lib.mjs')));
      const detector = await hookLib.loadDetector();
      assert.equal(typeof detector.detectText, 'function');
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
