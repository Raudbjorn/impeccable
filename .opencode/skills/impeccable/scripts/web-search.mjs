#!/usr/bin/env node
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export async function searchWeb({ query, limit = 5, model = 'MiniMax-M3', apiKey = process.env.MINIMAX_API_KEY, fetchImpl = fetch }) {
  if (!apiKey?.trim()) throw new Error('MINIMAX_API_KEY is required');
  if (typeof query !== 'string' || !query.trim()) throw new Error('A search query is required');
  if (typeof model !== 'string' || !model.trim()) throw new Error('model is required');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('limit must be an integer from 1 to 20');
  query = query.trim().replace(/\s+/g, ' ');
  const response = await fetchImpl('https://api.minimax.io/anthropic/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      messages: [{ role: 'user', content: `Search the web for the following query. After searching, reply with one brief sentence.\n\n${query}` }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      tool_choice: { type: 'tool', name: 'web_search' },
    }),
    signal: AbortSignal.timeout(120_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`MiniMax search failed (HTTP ${response.status})`);
  const result = await response.json();
  if (result.error || result.base_resp?.status_code) throw new Error('MiniMax returned a search API error');
  if (result.stop_reason !== 'end_turn') throw new Error('MiniMax search did not complete');
  const searches = Array.isArray(result.content) ? result.content.filter(block => block.type === 'web_search_tool_result') : [];
  if (!searches.length) throw new Error('MiniMax returned no web search results block');
  const results = new Map();
  for (const search of searches) {
    if (search.content?.type === 'web_search_tool_result_error' || (Array.isArray(search.content) && search.content.some(item => item?.type === 'web_search_tool_result_error'))) {
      throw new Error('MiniMax web search tool failed');
    }
    if (!Array.isArray(search.content)) throw new Error('MiniMax returned invalid web search results');
    for (const item of search.content) {
      if (item?.type !== 'web_search_result') throw new Error('MiniMax returned invalid web search results');
      let url;
      try { url = new URL(item.url); } catch { continue; }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || results.has(url.href)) continue;
      results.set(url.href, {
        title: typeof item.title === 'string' ? item.title : url.href,
        url: url.href,
        snippet: typeof item.content === 'string' ? item.content : '',
        ...(typeof item.page_age === 'string' ? { date: item.page_age } : {}),
      });
    }
  }
  return { ok: true, query, model: result.model || model, results: [...results.values()].slice(0, limit), totalResults: results.size, usage: result.usage || {} };
}

async function main() {
  try {
    const { values } = parseArgs({ options: {
      query: { type: 'string' }, limit: { type: 'string' }, model: { type: 'string' }, help: { type: 'boolean' },
    } });
    if (values.help) {
      console.log('Usage: node web-search.mjs --query <text> [--limit 5] [--model MiniMax-M3]\nRequires MINIMAX_API_KEY. Returns JSON with titles, URLs, snippets, and dates when supplied by MiniMax.');
      return;
    }
    console.log(JSON.stringify(await searchWeb({ ...values, limit: values.limit === undefined ? 5 : Number(values.limit) })));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) await main();
