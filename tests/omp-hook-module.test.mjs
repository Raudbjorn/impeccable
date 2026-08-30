/**
 * Behavior tests for the generated oh-my-pi hook module.
 *
 * Everything else about this module is asserted against its SOURCE TEXT, which
 * tests how it looks rather than what it does. These tests import the emitted
 * module and drive it through a stand-in `pi`, so a refactor that keeps the
 * text recognizable but breaks the contract fails here.
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

// A hook.mjs stand-in: echoes back one finding per file it is asked about, in
// the same envelope the real script emits, so the module's parsing is what is
// under test rather than the detector.
const FAKE_HOOK = `
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
    const hookScript = path.join(dir, 'hook.mjs');
    fs.writeFileSync(hookScript, FAKE_HOOK);
    const modulePath = path.join(dir, 'impeccable.mjs');
    fs.writeFileSync(modulePath, buildOmpHookModule({ hookScript }));
    const mod = await import(pathToFileURL(modulePath).href);

    // Stand-in for `pi`: capture the handlers the module registers.
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

  it('covers ast_edit, and ignores tools that do not write files', async () => {
    const handlers = load();
    const edited = await handlers.tool_result(
      { toolName: 'ast_edit', input: { path: 'x.ts' }, content: [] },
      { cwd: dir },
    );
    assert.equal(edited.content.length, 1);

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
