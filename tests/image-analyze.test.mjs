import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { analyzeImage, imageSource } from '../skill/scripts/image-analyze.mjs';
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

it('vision sends the documented request and returns only the answer and usage', async () => {
  for (const image of [dataUrl, 'https://example.com/image.png']) {
    const result = await analyzeImage({ image, prompt: 'Describe the layout.', apiKey: 'test-key', fetchImpl: async (url, request) => {
      assert.equal(url, 'https://api.minimax.io/v1/chat/completions');
      assert.equal(request.headers.Authorization, 'Bearer test-key');
      const body = JSON.parse(request.body);
      assert.deepEqual(body.messages[0].content, [
        { type: 'text', text: 'Describe the layout.' }, { type: 'image_url', image_url: { url: image } },
      ]);
      assert.deepEqual(body.thinking, { type: 'adaptive' });
      assert.equal(body.reasoning_split, true);
      assert.equal(body.max_completion_tokens, 4096);
      assert.ok(request.signal instanceof AbortSignal);
      return Response.json({ model: 'MiniMax-M3', choices: [{ finish_reason: 'stop', message: { content: 'A compact layout.', reasoning_content: 'private reasoning' } }], usage: { total_tokens: 10 } });
    } });
    assert.deepEqual(result, { ok: true, model: 'MiniMax-M3', text: 'A compact layout.', usage: { total_tokens: 10 } });
  }
});

it('vision fails explicitly on invalid arguments, API failures, empty and truncated answers', async () => {
  const options = { image: dataUrl, prompt: 'Describe.', apiKey: 'test-key' };
  await assert.rejects(analyzeImage({ ...options, apiKey: '' }), /MINIMAX_API_KEY/);
  await assert.rejects(analyzeImage({ ...options, prompt: '' }), /prompt/);
  await assert.rejects(analyzeImage({ ...options, maxTokens: 0 }), /max-tokens/);
  for (const [response, message] of [
    [new Response('no', { status: 401 }), /HTTP 401/],
    [Response.json({ base_resp: { status_code: 1004 } }), /API error/],
    [Response.json({ error: { message: 'invalid request' } }), /API error/],
    [Response.json({ choices: [] }), /no analysis/],
    [Response.json({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }), /truncated/],
  ]) await assert.rejects(analyzeImage({ ...options, fetchImpl: async () => response }), message);
  await assert.rejects(analyzeImage({ ...options, fetchImpl: async () => { throw new DOMException('Timed out', 'TimeoutError'); } }), /Timed out/);
});
