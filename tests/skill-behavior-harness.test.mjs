import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { prepareWorkspace, cleanupWorkspace, makeTools, runTurn, SKILL_BODY, ENGINE_BIN } from './skill-behavior/harness.mjs';
import { assertPlanningFallbackWarning } from './skill-behavior/assertions.mjs';

it('image reads reach the model as image content rather than binary text', async () => {
  const workspace = prepareWorkspace();
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1cAAAAASUVORK5CYII=';
  try {
    fs.writeFileSync(path.join(workspace, 'screen.png'), Buffer.from(png, 'base64'));
    const { tools } = makeTools(workspace);
    const output = await tools.read.execute({ path: 'screen.png' });
    assert.deepEqual(tools.read.toModelOutput({ output }), {
      type: 'content', value: [{ type: 'file', data: { type: 'data', data: png }, mediaType: 'image/png' }],
    });
    assert.deepEqual(tools.read.toModelOutput({ output: 'plain text' }), { type: 'json', value: 'plain text' });
  } finally {
    cleanupWorkspace(workspace);
  }
});

it('model shell commands cannot see host processes or modify files outside the fixture', async () => {
  const workspace = prepareWorkspace();
  const outside = workspace + '-outside';
  fs.writeFileSync(outside, 'unchanged');
  try {
    const { tools } = makeTools(workspace);
    const result = await tools.bash.execute({ command: `test ! -e /proc/${process.pid} && printf inside > result.txt` });
    assert.match(result, /^exit=0/);
    assert.equal(fs.readFileSync(path.join(workspace, 'result.txt'), 'utf8'), 'inside');
    const denied = await tools.bash.execute({ command: `printf changed > ../${path.basename(outside)}` });
    assert.doesNotMatch(denied, /^exit=0/);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'unchanged');
    assert.match(await tools.bash.execute({ command: 'test "$TMPDIR" = /tmp && mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"' }), /^exit=0/);
    if (ENGINE_BIN) assert.match(await tools.bash.execute({ command: '"$IMPECCABLE_BIN" --version' }), /^exit=0/);
  } finally {
    cleanupWorkspace(workspace);
    fs.rmSync(outside, { force: true });
  }
});

it('planning fallback requires an assistant warning between the denial and context reads', () => {
  const call = { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'context', toolName: 'bash', input: { command: '.claude/skills/impeccable/scripts/impeccable context' } }] };
  const denial = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'context', toolName: 'bash', output: { type: 'text', value: 'Error: Bash permission denied by the host. This command was not executed.' } }] };
  const warning = { role: 'assistant', content: 'Context loading did not run because the launcher was denied.' };
  const read = { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'read', toolName: 'read', input: { path: 'PRODUCT.md' } }] };
  assert.doesNotThrow(() => assertPlanningFallbackWarning([call, denial, warning, read]));
  assert.doesNotThrow(() => assertPlanningFallbackWarning([call, denial, { role: 'assistant', content: [{ type: 'text', text: warning.content }, ...read.content] }]));
  for (const messages of [
    [call, denial, read], // Silent continuation.
    [call, denial, read, warning], // Final-only disclosure.
    [warning, call, denial, read], // Not a response to the actual denial.
    [call, denial, { ...warning, role: 'user' }, read],
    [call, { ...denial, content: [{ ...denial.content[0], toolCallId: 'unrelated' }] }, warning, read],
  ]) {
    assert.throws(() => assertPlanningFallbackWarning(messages), assert.AssertionError);
  }
});

it('Compatible providers get an explicit output ceiling instead of the compatibility SDK default', async () => {
  const workspace = prepareWorkspace();
  try {
    for (const modelId of ['deepseek-v4-flash', 'MiniMax-M3', 'claude-sonnet-5']) {
      const model = new MockLanguageModelV3({
        modelId,
        doGenerate: {
          content: [{ type: 'text', text: 'done' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
          warnings: [],
        },
      });
      await runTurn({ workspace, model, userPrompt: 'Test the harness.', maxSteps: 1 });
      const request = model.doGenerateCalls[0];
      assert.equal(request.maxOutputTokens, modelId.startsWith('MiniMax-') ? 32_768 : modelId.startsWith('deepseek-') ? 16_384 : undefined);
      assert.ok(request.prompt.some((message) => message.role === 'system' && message.content === SKILL_BODY));
    }
  } finally {
    cleanupWorkspace(workspace);
  }
});

it('loaded-skill metadata resolves to the staged launcher and readable references', async () => {
  const workspace = prepareWorkspace();
  try {
    const baseDir = SKILL_BODY.match(/^Base directory for this skill \(workspace-relative\): (.+)$/m)?.[1];
    assert.ok(baseDir, 'the host must supply the skill directory separately from its instructions');
    assert.ok(fs.statSync(path.join(workspace, baseDir, 'scripts/impeccable')).isFile());
    const { tools, trace } = makeTools(workspace, {}, {}, { denyBash: true });
    await tools.read.execute({ path: `${baseDir}/reference/polish.md` });
    await tools.read.execute({ path: `${baseDir}/reference/craft-floor.md` });
    assert.ok(trace.toolCalls.every((call) => call.succeeded));
    assert.ok(SKILL_BODY.includes('<skill-base-dir>/scripts/impeccable context'), 'metadata must not rewrite away the path-resolution behavior under test');
  } finally {
    cleanupWorkspace(workspace);
  }
});

it('denied-launcher tools reject every shell attempt without executing or modifying the skill', async () => {
  const workspace = prepareWorkspace({ files: { 'index.html': 'before' } });
  try {
    const { tools, trace } = makeTools(workspace, {}, {}, { denyBash: true });
    for (const command of [
      '.claude/skills/impeccable/scripts/impeccable context',
      '.claude/skills/impeccable/scripts/impeccable context; echo bad > index.html',
      'echo bad > index.html',
    ]) {
      assert.match(await tools.bash.execute({ command }), /permission denied/i);
    }
    assert.equal(fs.readFileSync(path.join(workspace, 'index.html'), 'utf8'), 'before');
    assert.ok(trace.toolCalls.every((call) => call.denied && call.mutatedPaths.length === 0));
    const skillPath = '.claude/skills/impeccable/reference/polish.md';
    const before = await tools.read.execute({ path: skillPath });
    assert.match(await tools.write.execute({ path: skillPath, contents: 'bad' }), /^Error:/);
    assert.equal(await tools.read.execute({ path: skillPath }), before);
    await tools.read.execute({ path: 'missing.md' });
    assert.deepEqual(trace.toolCalls.filter((call) => call.name === 'read').map((call) => call.succeeded), [true, true, false]);
    await tools.write.execute({ path: 'index.html', contents: 'after' });
    assert.deepEqual(trace.toolCalls.flatMap((call) => call.mutatedPaths), ['index.html']);
  } finally {
    cleanupWorkspace(workspace);
  }
});

it('context-only routing tools reject shell searches and compound commands before execution', async () => {
  const workspace = prepareWorkspace({ files: { 'index.html': 'before' } });
  try {
    const { tools, trace } = makeTools(workspace, {}, {}, { contextOnlyBash: true });
    for (const command of [
      'find / -name routing.md',
      '.claude/skills/impeccable/scripts/impeccable context; echo bad > index.html',
      'echo bad > index.html',
    ]) {
      assert.match(await tools.bash.execute({ command }), /^Error:/);
    }
    assert.equal(fs.readFileSync(path.join(workspace, 'index.html'), 'utf8'), 'before');
    assert.equal(trace.bashCommands.length, 3, 'rejected attempts remain observable');
    assert.ok(trace.toolCalls.every((call) => call.mutatedPaths.length === 0));
  } finally {
    cleanupWorkspace(workspace);
  }
});

it('context-only routing tools keep project writes observable but protect the staged skill', async () => {
  const workspace = prepareWorkspace({ files: { 'index.html': 'before' } });
  try {
    const { tools, trace } = makeTools(workspace, {}, {}, { contextOnlyBash: true });
    const skillPath = '.claude/skills/impeccable/reference/routing.md';
    const before = await tools.read.execute({ path: skillPath });
    assert.match(await tools.write.execute({ path: skillPath, contents: 'bad' }), /^Error:/);
    assert.equal(await tools.read.execute({ path: skillPath }), before);
    await tools.write.execute({ path: 'index.html', contents: 'after' });
    assert.equal(fs.readFileSync(path.join(workspace, 'index.html'), 'utf8'), 'after');
    assert.deepEqual(trace.writePaths, [skillPath, 'index.html']);
    assert.deepEqual(trace.toolCalls.flatMap((call) => call.mutatedPaths), ['index.html']);
  } finally {
    cleanupWorkspace(workspace);
  }
});
