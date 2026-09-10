#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(bytes.subarray(0, 6).toString())) return 'image/gif';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw new Error('Unsupported image: use PNG, JPEG, GIF, or WEBP');
}

// Anthropic-compatible image source; also used by the live test agent.
export async function imageSource(input, { root } = {}) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('An image is required');
  if (!root && input.startsWith('https://')) {
    const url = new URL(input);
    if (url.username || url.password) throw new Error('Image URLs must not contain credentials');
    return { type: 'url', url: url.href };
  }
  let bytes;
  let declaredType;
  if (!root && input.startsWith('data:')) {
    const match = input.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match || match[2].length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error('Invalid or oversized image data URL');
    bytes = Buffer.from(match[2], 'base64');
    if (bytes.toString('base64') !== match[2]) throw new Error('Invalid base64 image');
    declaredType = match[1];
  } else {
    if (/^[a-z]+:\/\//i.test(input) || input.startsWith('data:')) throw new Error('Expected a local image path');
    const file = await fs.realpath(root ? path.resolve(root, input) : path.resolve(input));
    if (root) {
      const relative = path.relative(await fs.realpath(root), file);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Screenshot is outside the live workspace');
    }
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error('Image must be a file no larger than 10 MB');
    bytes = await fs.readFile(file);
  }
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('Image must be between 1 byte and 10 MB');
  const media_type = imageType(bytes);
  if (declaredType && declaredType !== media_type) throw new Error('Image data does not match its MIME type');
  return { type: 'base64', media_type, data: bytes.toString('base64') };
}

export async function analyzeImage({ image, prompt, model = 'MiniMax-M3', maxTokens = 4096, apiKey = process.env.MINIMAX_API_KEY, fetchImpl = fetch }) {
  if (!apiKey?.trim()) throw new Error('MINIMAX_API_KEY is required');
  if (!prompt?.trim()) throw new Error('A prompt is required');
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > 524288) throw new Error('max-tokens must be an integer from 1 to 524288');
  const source = await imageSource(image);
  const url = source.type === 'url' ? source.url : `data:${source.media_type};base64,${source.data}`;
  const response = await fetchImpl('https://api.minimax.io/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url } }] }],
      thinking: { type: 'adaptive' },
      reasoning_split: true,
      max_completion_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(120_000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`MiniMax request failed (HTTP ${response.status})`);
  const result = await response.json();
  if (result.error || result.base_resp?.status_code) throw new Error('MiniMax returned an API error');
  const choice = result.choices?.[0];
  if (choice?.finish_reason === 'length') throw new Error('MiniMax response was truncated; increase --max-tokens');
  const text = choice?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('MiniMax returned no analysis');
  return { ok: true, model: result.model || model, text, usage: result.usage || {} };
}

async function main() {
  try {
    const { values } = parseArgs({ options: {
      image: { type: 'string' }, prompt: { type: 'string' }, model: { type: 'string' },
      'max-tokens': { type: 'string' }, help: { type: 'boolean' },
    } });
    if (values.help) {
      console.log('Usage: node image-analyze.mjs --image <path|https-url|data-url> --prompt <text> [--model MiniMax-M3] [--max-tokens 4096]');
      return;
    }
    console.log(JSON.stringify(await analyzeImage({ ...values, maxTokens: values['max-tokens'] === undefined ? 4096 : Number(values['max-tokens']) })));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) await main();
