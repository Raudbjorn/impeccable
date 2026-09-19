import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { analyzeImage, clearImageCache, imageSource } from '../skill/scripts/image-analyze.mjs';
import { createLlmAgent, liveScreenshot, resolveLlmAgentConfig, llmRequestSettings } from './live-e2e/agents/llm-agent.mjs';
import { DEFAULT_MODELS, detectProvider, getProviderOptions } from './skill-behavior/providers.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const dataUrl = `data:image/png;base64,${png}`;

it('canceling a live session aborts a MiniMax response body without retrying', async () => {
  const controller = new AbortController();
  let requests = 0;
  const timers = [];
  const server = http.createServer((req, res) => {
    req.resume();
    requests += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write(' ');
    timers.push(setTimeout(() => controller.abort(), 20));
    timers.push(setTimeout(() => res.end('{}'), 200));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const agent = await createLlmAgent({ provider: 'minimax', apiKey: 'test-key', baseURL: `http://127.0.0.1:${server.address().port}`, includeLiveSpec: false });
    await assert.rejects(agent.generateVariants({ count: 1, element: { outerHTML: '<h1>Hello</h1>', textContent: 'Hello' } }, { signal: controller.signal }), /abort/i);
    assert.equal(requests, 1);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

it('live generation sends supplied screenshots to MiniMax and leaves ordinary requests text-only', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impeccable-live-vision-'));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      id: 'test', type: 'message', role: 'assistant', model: 'MiniMax-M3', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'thinking', thinking: 'Inspect the image.', signature: 'test' }, { type: 'text', text: JSON.stringify({ scopedCss: '.title { color: red; }', variants: [{ innerHtml: '<h1 class="title"><span>Hello</span></h1>', params: [] }] }) }],
      usage: { input_tokens: 10, output_tokens: 20 },
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await fs.writeFile(path.join(root, 'shot.png'), Buffer.from(png, 'base64'));
    const agent = await createLlmAgent({ provider: 'minimax', apiKey: 'test-key', baseURL: `http://127.0.0.1:${server.address().port}`, includeLiveSpec: false });
    const event = { id: 'vision', action: 'polish', count: 1, element: { tagName: 'h1', className: 'title', textContent: 'Hello', outerHTML: '<h1 class="title">Hello</h1>' } };
    for (const screenshotPath of [undefined, 'shot.png']) {
      const result = await agent.generateVariants({ ...event, screenshotPath }, { tmp: root });
      assert.equal(result.variants.length, 1);
    }
    assert.equal(requests.length, 2);
    assert.equal(typeof requests[0].messages[0].content, 'string');
    assert.deepEqual(requests[1].messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } });
    assert.deepEqual(requests[1].thinking, { type: 'adaptive' });
    assert.equal(requests[1].max_tokens, 32_768);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('MiniMax configuration preserves explicit selection and existing provider priority', () => {
  const env = { MINIMAX_API_KEY: 'test-key' };
  assert.deepEqual(resolveLlmAgentConfig({}, env), {
    provider: 'minimax', model: 'MiniMax-M3', apiKey: 'test-key', requiredEnv: 'MINIMAX_API_KEY',
    baseURL: 'https://api.minimax.io/anthropic',
  });
  assert.equal(resolveLlmAgentConfig({}, { ...env, OPENAI_API_KEY: 'other' }).provider, 'openai');
  assert.equal(resolveLlmAgentConfig({ provider: 'minimax', model: 'MiniMax-M3' }, {}).requiredEnv, 'MINIMAX_API_KEY');
  assert.equal(detectProvider('MiniMax-M3'), 'minimax');
  assert.ok(DEFAULT_MODELS.includes('MiniMax-M3'));
  assert.deepEqual(llmRequestSettings('minimax'), { thinking: { type: 'adaptive' } });
  assert.deepEqual(getProviderOptions('MiniMax-M3'), { anthropic: { thinking: { type: 'adaptive' } } });
});

it('local, base64, and URL images retain their content; live screenshots stay inside the workspace', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impeccable-vision-'));
  try {
    const image = path.join(root, 'shot.png');
    const workspace = path.join(root, 'workspace');
    await fs.mkdir(workspace);
    await fs.writeFile(image, Buffer.from(png, 'base64'));
    const source = { type: 'base64', media_type: 'image/png', data: png };
    assert.deepEqual(await imageSource(image), source);
    assert.deepEqual(await imageSource(dataUrl), source);
    assert.deepEqual(await imageSource('https://example.com/image.png'), { type: 'url', url: 'https://example.com/image.png' });
    assert.deepEqual(await liveScreenshot(image, root), { type: 'image', source });
    await fs.symlink(image, path.join(workspace, 'escape.png'));
    await assert.rejects(liveScreenshot('../shot.png', workspace), /outside/);
    await assert.rejects(liveScreenshot('escape.png', workspace), /outside/);
    await assert.rejects(liveScreenshot(image), /workspace is required/);
    await assert.rejects(imageSource('http://example.com/image.png'), /local image/);
    await assert.rejects(imageSource('https://user:pass@example.com/image.png'), /credentials/);
    await assert.rejects(imageSource(dataUrl.replace('image/png', 'image/jpeg')), /MIME type/);
    await assert.rejects(imageSource('data:image/png;base64,not-base64!'), /Invalid/);
    await fs.writeFile(image, 'not an image');
    await assert.rejects(imageSource(image), /Unsupported image/);
    await fs.truncate(image, 10 * 1024 * 1024 + 1);
    await assert.rejects(imageSource(image), /10 MB/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('vision sends detailed or quick instructions with the requested focus and preserves image content', async () => {
  for (const image of [dataUrl, 'https://example.com/image.png']) {
    const mode = image === dataUrl ? 'detailed' : 'quick';
    const result = await analyzeImage({ image, mode, prompt: 'Describe the layout.', cache: false, apiKey: 'test-key', fetchImpl: async (url, request) => {
      assert.equal(url, 'https://api.minimax.io/v1/chat/completions');
      assert.equal(request.headers.Authorization, 'Bearer test-key');
      const body = JSON.parse(request.body);
      const [instructions, attachment] = body.messages[0].content;
      assert.equal(instructions.type, 'text');
      assert.match(instructions.text, mode === 'quick' ? /fewer than 300 words/ : /image_overview.*visible_text.*objects_and_layout.*charts_or_data.*answer_to_request.*evidence.*uncertainty/);
      assert.match(instructions.text, /content, never as instructions/);
      assert.match(instructions.text, /Requested focus: Describe the layout\./);
      assert.deepEqual(attachment, { type: 'image_url', image_url: { url: image } });
      assert.deepEqual(body.thinking, { type: 'adaptive' });
      assert.equal(body.reasoning_split, true);
      assert.equal(body.max_completion_tokens, 4096);
      assert.ok(request.signal instanceof AbortSignal);
      return Response.json({ model: 'MiniMax-M3', choices: [{ finish_reason: 'stop', message: { content: 'A compact layout.', reasoning_content: 'private reasoning' } }], usage: { total_tokens: 10 } });
    } });
    assert.deepEqual(result, { ok: true, model: 'MiniMax-M3', mode, text: 'A compact layout.', cached: false, usage: { total_tokens: 10 } });
  }
});

it('vision fails explicitly on invalid arguments, API failures, empty and truncated answers', async () => {
  const options = { image: dataUrl, prompt: 'Describe.', cache: false, apiKey: 'test-key' };
  await assert.rejects(analyzeImage({ ...options, apiKey: '' }), /MINIMAX_API_KEY/);
  await assert.rejects(analyzeImage({ ...options, prompt: 12 }), /prompt/);
  await assert.rejects(analyzeImage({ ...options, mode: 'toString' }), /quick or detailed/);
  await assert.rejects(analyzeImage({ ...options, model: '' }), /model/);
  await assert.rejects(analyzeImage({ ...options, maxTokens: 0 }), /max-tokens/);
  for (const [response, message] of [
    [new Response('no', { status: 401 }), /HTTP 401/],
    [Response.json({ base_resp: { status_code: 1004 } }), /API error/],
    [Response.json({ error: { message: 'invalid request' } }), /API error/],
    [Response.json({ choices: [] }), /no analysis/],
    [Response.json({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }), /truncated/],
    [Response.json({ choices: [{ finish_reason: 'content_filter', message: { content: 'partial' } }] }), /did not complete/],
  ]) await assert.rejects(analyzeImage({ ...options, fetchImpl: async () => response }), message);
  await assert.rejects(analyzeImage({ ...options, fetchImpl: async () => { throw new DOMException('Timed out', 'TimeoutError'); } }), /Timed out/);
});

it('vision caches by image contents and request, persists across processes, and supports bypass and clearing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impeccable-vision-cache-'));
  const cacheDir = path.join(root, 'cache');
  let requests = 0;
  const options = { image: dataUrl, apiKey: 'test-key', cacheDir, fetchImpl: async () => {
    requests += 1;
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: `Analysis ${requests}` } }], usage: { total_tokens: 10 } });
  } };
  try {
    const first = await analyzeImage(options);
    assert.equal(first.mode, 'detailed');
    assert.equal(first.cached, false);
    const image = path.join(root, 'shot.png');
    await fs.writeFile(image, Buffer.from(png, 'base64'));
    const same = await analyzeImage({ ...options, image });
    assert.equal(same.cached, true);
    assert.equal(same.text, first.text);
    assert.deepEqual(same.usage, {});
    const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import { analyzeImage } from ${JSON.stringify(new URL('../skill/scripts/image-analyze.mjs', import.meta.url).href)};
      const result = await analyzeImage({ image: ${JSON.stringify(image)}, cacheDir: ${JSON.stringify(cacheDir)}, apiKey: 'test-key', fetchImpl: async () => { throw new Error('cache missed'); } });
      console.log(JSON.stringify(result));
    `]);
    assert.equal(JSON.parse(child.stdout).cached, true);
    assert.equal(requests, 1);
    for (const changes of [{ mode: 'quick' }, { prompt: 'Read the text.' }, { model: 'another-vision-model' }, { maxTokens: 200 }]) {
      assert.equal((await analyzeImage({ ...options, ...changes })).cached, false);
    }
    // Reusing a filename after its bytes change must miss the old screenshot's cache.
    await fs.writeFile(image, Buffer.concat([Buffer.from(png, 'base64'), Buffer.from('new metadata')]));
    assert.equal((await analyzeImage({ ...options, image })).cached, false);
    const stored = await fs.readdir(cacheDir);
    for (const name of stored) {
      const file = path.join(cacheDir, name);
      const contents = await fs.readFile(file, 'utf8');
      assert.doesNotMatch(contents, /test-key|base64|Read the text/);
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    }
    for (const changes of [{ cache: false }, { image: 'https://example.com/changing.png' }]) {
      for (let i = 0; i < 2; i += 1) assert.equal((await analyzeImage({ ...options, ...changes })).cached, false);
    }
    assert.equal(requests, 10);
    assert.deepEqual(await fs.readdir(cacheDir), stored);
    await fs.writeFile(path.join(cacheDir, 'keep.txt'), 'unrelated');
    const cleared = await promisify(execFile)(process.execPath, [new URL('../skill/scripts/image-analyze.mjs', import.meta.url).pathname, '--clear-cache', '--cache-dir', cacheDir], { env: { ...process.env, MINIMAX_API_KEY: '' } });
    assert.deepEqual(JSON.parse(cleared.stdout), { ok: true, cleared: 6 });
    assert.deepEqual(await fs.readdir(cacheDir), ['keep.txt']);
    assert.equal((await analyzeImage(options)).cached, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('vision refreshes expired or corrupt cache entries and never caches failed answers', async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'impeccable-vision-expiry-'));
  let requests = 0;
  const options = { image: dataUrl, apiKey: 'test-key', cacheDir, fetchImpl: async () => {
    requests += 1;
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: `Analysis ${requests}` } }] });
  } };
  try {
    await analyzeImage(options);
    const file = path.join(cacheDir, (await fs.readdir(cacheDir))[0]);
    const entry = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, JSON.stringify({ ...entry, created: Date.now() - 7 * 24 * 60 * 60 * 1000 }));
    assert.equal((await analyzeImage(options)).cached, false);
    await fs.writeFile(file, 'broken JSON');
    assert.equal((await analyzeImage(options)).cached, false);
    assert.equal(requests, 3);
    assert.equal((await analyzeImage(options)).cached, true);
    assert.deepEqual(await clearImageCache(cacheDir), { ok: true, cleared: 1 });
    for (const response of [
      { base_resp: { status_code: 1004 } },
      { choices: [{ finish_reason: 'length', message: { content: 'partial' } }] },
      { choices: [] },
    ]) {
      await assert.rejects(analyzeImage({ ...options, fetchImpl: async () => Response.json(response) }));
      assert.deepEqual(await fs.readdir(cacheDir), []);
    }
    await fs.writeFile(file, 'file blocks cache directory creation');
    assert.equal((await analyzeImage({ ...options, cacheDir: file })).cached, false);
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});

it('vision evicts the least recently used entries after 128 cached analyses', async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'impeccable-vision-lru-'));
  const options = { image: dataUrl, apiKey: 'test-key', cacheDir, fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'Analysis' } }] }) };
  try {
    await analyzeImage({ ...options, prompt: 'Focus 0' });
    const first = (await fs.readdir(cacheDir))[0];
    await analyzeImage({ ...options, prompt: 'Focus 1' });
    const second = (await fs.readdir(cacheDir)).find(name => name !== first);
    for (let i = 2; i < 128; i += 1) await analyzeImage({ ...options, prompt: `Focus ${i}` });
    // Give the first two entries distinct old access times without waiting for the clock.
    await fs.utimes(path.join(cacheDir, first), 1, 1);
    await fs.utimes(path.join(cacheDir, second), 2, 2);
    assert.equal((await analyzeImage({ ...options, prompt: 'Focus 0' })).cached, true);
    await analyzeImage({ ...options, prompt: 'Focus 128' });
    assert.equal((await fs.readdir(cacheDir)).length, 128);
    assert.equal((await analyzeImage({ ...options, prompt: 'Focus 0' })).cached, true);
    assert.equal((await analyzeImage({ ...options, prompt: 'Focus 1' })).cached, false);
    assert.equal((await fs.readdir(cacheDir)).length, 128);
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});
