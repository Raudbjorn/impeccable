import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { searchWeb } from '../skill/scripts/web-search.mjs';

it('web search forces the native tool and returns deduplicated source metadata, not model-written links', async () => {
  const result = await searchWeb({ query: '  MiniMax\n API   documentation ', limit: 2, apiKey: 'test-key', fetchImpl: async (url, request) => {
    assert.equal(url, 'https://api.minimax.io/anthropic/v1/messages');
    assert.equal(request.headers['x-api-key'], 'test-key');
    assert.equal(request.headers['anthropic-version'], '2023-06-01');
    assert.equal(request.redirect, 'error');
    assert.ok(request.signal instanceof AbortSignal);
    const body = JSON.parse(request.body);
    assert.equal(body.model, 'MiniMax-M3');
    assert.match(body.messages[0].content, /MiniMax API documentation$/);
    assert.deepEqual(body.tools, [{ type: 'web_search_20250305', name: 'web_search' }]);
    assert.deepEqual(body.tool_choice, { type: 'tool', name: 'web_search' });
    return Response.json({
      model: 'MiniMax-M3', stop_reason: 'end_turn', base_resp: { status_code: 0 }, usage: { input_tokens: 100, output_tokens: 20 },
      content: [
        { type: 'text', text: 'Visit https://invented.example.com/ for documentation.' },
        { type: 'server_tool_use', name: 'web_search', input: { query: 'MiniMax API documentation' } },
        { type: 'web_search_tool_result', content: [
          { type: 'web_search_result', title: 'Docs', url: 'https://platform.minimax.io/docs', content: 'Official documentation', page_age: '2026-09-01' },
          { type: 'web_search_result', title: 'Duplicate', url: 'https://platform.minimax.io/docs', content: 'Duplicate source' },
          { type: 'web_search_result', title: 'Unsafe', url: 'javascript:alert(1)' },
          { type: 'web_search_result', title: 'Invalid', url: '/relative' },
          { type: 'web_search_result', title: 'Credentials', url: 'https://user:pass@example.com/' },
          { type: 'web_search_result', title: 'API', url: 'https://platform.minimax.io/docs/api-reference/api-overview', content: 'API overview' },
        ] },
        { type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: 'Models', url: 'https://example.com/models' }] },
      ],
    });
  } });
  assert.deepEqual(result, {
    ok: true, query: 'MiniMax API documentation', model: 'MiniMax-M3', totalResults: 3,
    results: [
      { title: 'Docs', url: 'https://platform.minimax.io/docs', snippet: 'Official documentation', date: '2026-09-01' },
      { title: 'API', url: 'https://platform.minimax.io/docs/api-reference/api-overview', snippet: 'API overview' },
    ],
    usage: { input_tokens: 100, output_tokens: 20 },
  });
});

it('web search distinguishes empty results from missing tools, incomplete searches, and API or tool failures', async () => {
  const options = { query: 'test', apiKey: 'test-key' };
  const finished = { stop_reason: 'end_turn' };
  const empty = await searchWeb({ ...options, fetchImpl: async () => Response.json({ ...finished, content: [{ type: 'web_search_tool_result', content: [] }] }) });
  assert.deepEqual(empty.results, []);
  assert.equal(empty.totalResults, 0);
  for (const [response, expected] of [
    [new Response('no', { status: 401 }), /HTTP 401/],
    [Response.json({ base_resp: { status_code: 1004 } }), /API error/],
    [Response.json({ error: { message: 'invalid request' } }), /API error/],
    [new Response('invalid JSON'), /JSON/],
    [Response.json({ stop_reason: 'max_tokens' }), /did not complete/],
    [Response.json({ stop_reason: 'pause_turn' }), /did not complete/],
    [Response.json({ ...finished, content: [{ type: 'text', text: 'https://invented.example/' }] }), /no web search results block/],
    [Response.json({ ...finished, content: [{ type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'unavailable' } }] }), /tool failed/],
    [Response.json({ ...finished, content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }] }] }), /tool failed/],
    [Response.json({ ...finished, content: [{ type: 'web_search_tool_result', content: 'not results' }] }), /invalid web search results/],
    [Response.json({ ...finished, content: [{ type: 'web_search_tool_result', content: [null] }] }), /invalid web search results/],
  ]) await assert.rejects(searchWeb({ ...options, fetchImpl: async () => response }), expected);
  await assert.rejects(searchWeb({ ...options, fetchImpl: async () => { throw new DOMException('Timed out', 'TimeoutError'); } }), /Timed out/);
});

it('web search validates arguments before making requests; CLI help and errors work without credentials', async () => {
  const options = { query: 'test', apiKey: 'test-key', fetchImpl: async () => { assert.fail('invalid arguments must not reach the API'); } };
  await assert.rejects(searchWeb({ ...options, apiKey: '' }), /MINIMAX_API_KEY/);
  for (const query of [undefined, '', '  ', 123]) await assert.rejects(searchWeb({ ...options, query }), /query/);
  for (const limit of [0, 21, 1.5, NaN]) await assert.rejects(searchWeb({ ...options, limit }), /limit/);
  await assert.rejects(searchWeb({ ...options, model: '' }), /model/);
  const script = fileURLToPath(new URL('../skill/scripts/web-search.mjs', import.meta.url));
  const env = { ...process.env, MINIMAX_API_KEY: '' };
  const help = await promisify(execFile)(process.execPath, [script, '--help'], { env });
  assert.match(help.stdout, /--query.*--limit/);
  await assert.rejects(promisify(execFile)(process.execPath, [script, '--query', 'test'], { env }), error => {
    assert.equal(error.code, 1);
    assert.deepEqual(JSON.parse(error.stderr), { ok: false, error: 'MINIMAX_API_KEY is required' });
    return true;
  });
});
