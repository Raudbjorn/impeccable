/**
 * Behavior tests for the generated oh-my-pi hook module.
 *
 * Everything else about this module is asserted against its SOURCE TEXT, which
 * tests how it looks rather than what it does. These tests import the emitted
 * module and drive it through a stand-in `pi`, so a refactor that keeps the
 * text recognizable but breaks the contract fails here.
 *
 * The module resolves its launcher two directories up from wherever it sits
 * (`join(dirname(import.meta.url), "..", "..", "skills", "impeccable",
 * "scripts", "impeccable")`), matching the real install layout
 * `.omp/hooks/post/impeccable.js` -> `.omp/skills/impeccable/scripts/impeccable`.
 * The stand-in below reproduces that layout so the module's own path
 * resolution is exercised, not bypassed, and the "launcher" stand-in is an
 * executable script (spawned directly, not via `node`), matching how
 * `runHook()` actually invokes it.
 *
 * The contract comes from oh-my-pi's own source, checked out at
 * ../oh-my-pi when this was written:
 *   packages/coding-agent/src/extensibility/shared-events.ts
 *     ToolResultEventResult.content is a REPLACEMENT (TextContent|ImageContent)[]
 *     SessionStopEventResult needs `continue: true` to carry additionalContext
 *   packages/coding-agent/src/extensibility/tool-event-input.ts
 *     `path` is dropped once an edit targets two or more files; `paths` is the
 *     authoritative list
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildOmpHookModule } from '../scripts/lib/transformers/hooks.js';

// A launcher `hook` verb stand-in: echoes back one finding per file it is
// asked about, in the same envelope the real binary emits, so the module's
// parsing is what is under test rather than the detector.
const FAKE_LAUNCHER = `#!/usr/bin/env node
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const event = JSON.parse(raw);
  const label = event.hook_event_name === 'Stop'
    ? 'stop-finding'
    : \`finding for \${event.tool_input.file_path}\`;
  if (process.env.FAKE_HOOK_SILENT === '1') { process.stdout.write(''); return; }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: label } }));
});
`;

describe('generated oh-my-pi hook module', () => {
  let dir;
  let load;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-omp-mod-'));
    // Mirrors the real install layout: .omp/hooks/post/impeccable.js resolves
    // its launcher at .omp/skills/impeccable/scripts/impeccable.
    const moduleDir = path.join(dir, '.omp', 'hooks', 'post');
    fs.mkdirSync(moduleDir, { recursive: true });
    const launcherDir = path.join(dir, '.omp', 'skills', 'impeccable', 'scripts');
    fs.mkdirSync(launcherDir, { recursive: true });
    const launcherPath = path.join(launcherDir, 'impeccable');
    fs.writeFileSync(launcherPath, FAKE_LAUNCHER, { mode: 0o755 });

    const modulePath = path.join(moduleDir, 'impeccable.js');
    fs.writeFileSync(modulePath, buildOmpHookModule());
    const mod = await import(pathToFileURL(modulePath).href);

    // Stand-in for `pi`: capture the handlers the module registers. No
    // `hasUI`, matching a harness with no UI surface to notify on error.
    load = () => {
      const handlers = {};
      mod.default({ on: (event, fn) => { handlers[event] = fn; } });
      return handlers;
    };
  });

  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('registers exactly the two events it documents', () => {
    assert.deepEqual(Object.keys(load()).sort(), ['session_stop', 'tool_result']);
  });

  it('appends to the tool content instead of replacing it', async () => {
    const original = [{ type: 'text', text: 'the edit output' }];
    const result = await load().tool_result(
      { toolName: 'edit', input: { path: 'src/Card.tsx' }, content: original },
      { cwd: dir },
    );

    assert.equal(result.content.length, 2, 'the tool own output must survive');
    assert.deepEqual(result.content[0], original[0]);
    assert.deepEqual(result.content[1], { type: 'text', text: 'finding for src/Card.tsx' });
  });

  it('scans every file of a multi-file edit, which `path` alone would drop', async () => {
    // The runner supplies only `paths` at two or more targets.
    const result = await load().tool_result(
      { toolName: 'edit', input: { paths: ['a.css', 'b.css'] }, content: [] },
      { cwd: dir },
    );

    assert.equal(result.content.length, 1);
    assert.match(result.content[0].text, /finding for a\.css/);
    assert.match(result.content[0].text, /finding for b\.css/);
  });

  it('scans multiple files concurrently, not one at a time', async () => {
    // A launcher that sleeps before replying. Scanned sequentially, N files
    // would cost N * delay; scanned concurrently (Promise.all), wall time is
    // bounded by one delay regardless of N.
    const slowDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-omp-mod-slow-'));
    const moduleDir = path.join(slowDir, '.omp', 'hooks', 'post');
    fs.mkdirSync(moduleDir, { recursive: true });
    const launcherDir = path.join(slowDir, '.omp', 'skills', 'impeccable', 'scripts');
    fs.mkdirSync(launcherDir, { recursive: true });
    const delayMs = 200;
    fs.writeFileSync(
      path.join(launcherDir, 'impeccable'),
      `#!/usr/bin/env node
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  setTimeout(() => {
    const event = JSON.parse(raw);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: \`finding for \${event.tool_input.file_path}\` } }));
  }, ${delayMs});
});
`,
      { mode: 0o755 },
    );
    const modulePath = path.join(moduleDir, 'impeccable.js');
    fs.writeFileSync(modulePath, buildOmpHookModule());
    const mod = await import(pathToFileURL(modulePath).href);
    const handlers = {};
    mod.default({ on: (event, fn) => { handlers[event] = fn; } });

    const fileCount = 4;
    const paths = Array.from({ length: fileCount }, (_, i) => `f${i}.css`);
    const started = Date.now();
    const result = await handlers.tool_result({ toolName: 'edit', input: { paths }, content: [] }, { cwd: slowDir });
    const elapsed = Date.now() - started;

    assert.equal(result.content.length, 1);
    for (const p of paths) assert.match(result.content[0].text, new RegExp(`finding for ${p}`));
    // The property under test is "not serial": sequential would cost
    // delayMs * fileCount. Bounding at fileCount - 1 delays leaves no room
    // for a fully serial run to sneak under the threshold, while still
    // giving ordinary scheduling jitter (four Node cold starts) a wide
    // margin above the one-delay concurrent case.
    assert.ok(
      elapsed < delayMs * (fileCount - 1),
      `expected roughly one delay's worth of wall time (concurrent), took ${elapsed}ms`,
    );

    fs.rmSync(slowDir, { recursive: true, force: true });
  });

  it('caps how many scans run at once, so a large batch cannot spawn unbounded processes', async () => {
    // Matches MAX_CONCURRENT_SCANS in the module: more targets than the cap
    // (10 vs. 8) must take roughly two delays, not one -- if the cap were
    // removed (plain Promise.all), all 10 would run at once and this would
    // finish in roughly one delay instead, tripping the lower bound below.
    const poolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-omp-mod-pool-'));
    const moduleDir = path.join(poolDir, '.omp', 'hooks', 'post');
    fs.mkdirSync(moduleDir, { recursive: true });
    const launcherDir = path.join(poolDir, '.omp', 'skills', 'impeccable', 'scripts');
    fs.mkdirSync(launcherDir, { recursive: true });
    const delayMs = 100;
    fs.writeFileSync(
      path.join(launcherDir, 'impeccable'),
      `#!/usr/bin/env node
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  setTimeout(() => {
    const event = JSON.parse(raw);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: \`finding for \${event.tool_input.file_path}\` } }));
  }, ${delayMs});
});
`,
      { mode: 0o755 },
    );
    const modulePath = path.join(moduleDir, 'impeccable.js');
    fs.writeFileSync(modulePath, buildOmpHookModule());
    const mod = await import(pathToFileURL(modulePath).href);
    const handlers = {};
    mod.default({ on: (event, fn) => { handlers[event] = fn; } });

    const fileCount = 10;
    const paths = Array.from({ length: fileCount }, (_, i) => `p${i}.css`);
    const started = Date.now();
    const result = await handlers.tool_result({ toolName: 'edit', input: { paths }, content: [] }, { cwd: poolDir });
    const elapsed = Date.now() - started;

    assert.equal(result.content.length, 1);
    for (const p of paths) assert.match(result.content[0].text, new RegExp(`finding for ${p}`));
    assert.ok(
      elapsed > delayMs * 1.5,
      `expected the 10 targets to spill into a second batch past the concurrency cap, took ${elapsed}ms`,
    );
    assert.ok(
      elapsed < delayMs * (fileCount - 1),
      `expected two batches' worth of wall time, not a serial run of ${fileCount}, took ${elapsed}ms`,
    );

    fs.rmSync(poolDir, { recursive: true, force: true });
  });

  it('survives a launcher that closes stdin before the payload is fully written', async () => {
    // Regression: writing to a pipe whose read end has already closed raises
    // EPIPE on the stdin stream itself -- a distinct event from the child
    // process "error"/"close" events, and previously uncaught. The payload
    // path is inflated well past a pipe's kernel buffer (64KiB on Linux) so
    // the write cannot complete in one syscall, forcing a later chunk to
    // land after this launcher (which exits on the very first tick) has
    // already closed its end -- making the EPIPE race deterministic instead
    // of a timing coin flip.
    const deadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-omp-mod-dead-'));
    const moduleDir = path.join(deadDir, '.omp', 'hooks', 'post');
    fs.mkdirSync(moduleDir, { recursive: true });
    const launcherDir = path.join(deadDir, '.omp', 'skills', 'impeccable', 'scripts');
    fs.mkdirSync(launcherDir, { recursive: true });
    fs.writeFileSync(
      path.join(launcherDir, 'impeccable'),
      `#!/usr/bin/env node\nprocess.exit(1);\n`,
      { mode: 0o755 },
    );
    const modulePath = path.join(moduleDir, 'impeccable.js');
    fs.writeFileSync(modulePath, buildOmpHookModule());
    const mod = await import(pathToFileURL(modulePath).href);
    const handlers = {};
    mod.default({ on: (event, fn) => { handlers[event] = fn; } });

    const oversizedPath = `dead-${'x'.repeat(300_000)}.css`;

    // Must resolve (not throw/crash the process) even though the child is
    // gone before the module's stdin.write() finishes landing.
    const result = await handlers.tool_result(
      { toolName: 'edit', input: { path: oversizedPath }, content: [{ type: 'text', text: 'orig' }] },
      { cwd: deadDir },
    );
    assert.equal(result, undefined, 'a failed scan must not fabricate a finding');

    fs.rmSync(deadDir, { recursive: true, force: true });
  });

  it('covers ast_edit, and ignores tools that do not write files', async () => {
    const handlers = load();
    // ast_edit's own result details are authoritative (oh-my-pi's
    // AstEditToolDetails: `applied` + `files`), never input.path/paths --
    // those are the search scopes (directories, globs) the edit ran over,
    // not the files it changed, and a dry-run preview with `applied: false`
    // must not be scanned at all.
    const edited = await handlers.tool_result(
      { toolName: 'ast_edit', input: { paths: ['src/**/*.ts'] }, details: { applied: true, files: ['x.ts'] }, content: [] },
      { cwd: dir },
    );
    assert.equal(edited.content.length, 1);

    assert.equal(
      await handlers.tool_result(
        { toolName: 'ast_edit', input: { paths: ['src/**/*.ts'] }, details: { applied: false, files: ['x.ts'] }, content: [] },
        { cwd: dir },
      ),
      undefined,
      'an unapplied ast_edit preview must not trigger a scan',
    );

    for (const toolName of ['bash', 'read', 'glob']) {
      assert.equal(
        await handlers.tool_result({ toolName, input: { path: 'x.ts' }, content: [] }, { cwd: dir }),
        undefined,
        `${toolName} must not trigger a scan`,
      );
    }
  });

  it('returns nothing when there is no target or no finding', async () => {
    const handlers = load();
    assert.equal(
      await handlers.tool_result({ toolName: 'edit', input: {}, content: [] }, { cwd: dir }),
      undefined,
      'an event with neither path nor paths is not an error',
    );
    assert.equal(
      await handlers.tool_result({ toolName: 'edit', input: { paths: [] }, content: [] }, { cwd: dir }),
      undefined,
    );

    process.env.FAKE_HOOK_SILENT = '1';
    try {
      assert.equal(
        await handlers.tool_result({ toolName: 'edit', input: { path: 'q.css' }, content: [] }, { cwd: dir }),
        undefined,
        'a clean file must leave the tool result untouched',
      );
    } finally {
      delete process.env.FAKE_HOOK_SILENT;
    }
  });

  it('skips a failed tool result rather than guessing targets from its input', async () => {
    const handlers = load();
    // A failed edit's input still names a path, but nothing was written --
    // details carries nothing either, since the tool errored before
    // producing a result. Scanning the input-named path anyway would append
    // an unrelated finding to the error output.
    assert.equal(
      await handlers.tool_result(
        { toolName: 'edit', input: { path: 'q.css' }, isError: true, content: [] },
        { cwd: dir },
      ),
      undefined,
      'a failed edit with no confirmed details must not scan its input path',
    );
    assert.equal(
      await handlers.tool_result(
        { toolName: 'write', input: { path: 'q.css' }, isError: true, content: [] },
        { cwd: dir },
      ),
      undefined,
      'a failed write must not scan its input path either',
    );

    // A partial failure can still carry confirmed per-file results for the
    // files that did succeed; those are real changes and stay worth scanning.
    const partial = await handlers.tool_result(
      {
        toolName: 'edit',
        input: {},
        isError: true,
        details: { perFileResults: [{ path: 'q.css' }] },
        content: [],
      },
      { cwd: dir },
    );
    assert.equal(partial.content.length, 1);
    assert.match(partial.content[0].text, /finding for q\.css/);
  });

  it('asks to continue the session when the Stop pass has findings', async () => {
    // additionalContext on its own is discarded as the session settles.
    const result = await load().session_stop({ stop_hook_active: false }, { cwd: dir });
    assert.deepEqual(result, { continue: true, additionalContext: 'stop-finding' });
  });

  it('stays silent on Stop when there is nothing to report', async () => {
    process.env.FAKE_HOOK_SILENT = '1';
    try {
      assert.equal(await load().session_stop({ stop_hook_active: false }, { cwd: dir }), undefined);
    } finally {
      delete process.env.FAKE_HOOK_SILENT;
    }
  });
});
