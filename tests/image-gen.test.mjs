import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../skill/scripts/lib/png.mjs';

const script = fileURLToPath(new URL('../skill/scripts/image-gen.mjs', import.meta.url));
const png = encodePng({ width: 1, height: 1, data: new Uint8Array([20, 40, 60, 255]) });
const success = { status: 200, json: { base_resp: { status_code: 0 }, data: { image_base64: [png.toString('base64')] } } };

function run({ args = [], prompt = 'A wordless botanical still life for the florist landing page.', responses = [success], env = {}, config, reference = png, existing, conversionFails = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-image-gen-'));
  const out = path.join(root, 'result.png');
  try {
    fs.writeFileSync(path.join(root, 'ref.png'), reference);
    fs.mkdirSync(path.join(root, 'tmp'));
    if (existing) fs.writeFileSync(out, existing);
    if (config) {
      fs.mkdirSync(path.join(root, '.impeccable'));
      fs.writeFileSync(path.join(root, '.impeccable/.env'), config);
    }
    fs.writeFileSync(path.join(root, 'mock.json'), JSON.stringify({ responses, png: png.toString('base64'), conversionFails }));
    fs.writeFileSync(path.join(root, 'mock.mjs'), `
import fs from 'node:fs';
import dns from 'node:dns';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const mock = JSON.parse(fs.readFileSync('mock.json', 'utf8'));
const calls = [];
dns.promises.lookup = async () => ({ address: '127.0.0.1', family: 4 });
const timer = globalThis.setTimeout;
globalThis.setTimeout = (fn, _ms, ...args) => timer(fn, 0, ...args);
cp.execFileSync = (command, args) => {
  if (command === 'curl') {
    const headers = args[args.indexOf('-K') + 1];
    const body = args[args.indexOf('-d') + 1].slice(1);
    calls.push({ url: args.at(-1), args, body: JSON.parse(fs.readFileSync(body, 'utf8')),
      headers: fs.readFileSync(headers, 'utf8'),
      modes: [headers, body].map(file => fs.statSync(file).mode & 0o777) });
    fs.writeFileSync('calls.json', JSON.stringify(calls));
    const response = mock.responses[Math.min(calls.length - 1, mock.responses.length - 1)];
    return JSON.stringify(response.json) + '\\n' + response.status;
  }
  if (['sips', 'magick', 'convert', 'ffmpeg'].includes(command)) {
    if (mock.conversionFails) throw new Error('converter failed');
    fs.writeFileSync(args.at(-1).replace(/^png:/, ''), Buffer.from(mock.png, 'base64'));
    return '';
  }
  throw new Error('Unexpected external command: ' + command);
};
syncBuiltinESMExports();
`);
    const result = spawnSync(process.execPath, ['--import', path.join(root, 'mock.mjs'), script,
      '--prompt', prompt, '--out', out, ...args], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, TMPDIR: path.join(root, 'tmp'), IMAGE_GEN_PROVIDER: 'minimax',
        IMAGE_GEN_API_KEY: '', IMAGE_API_KEY: '', MINIMAX_API_KEY: 'minimax-test-key', ...env },
    });
    assert.ifError(result.error);
    return { ...result, out, image: fs.existsSync(out) ? fs.readFileSync(out) : null,
      calls: fs.existsSync(path.join(root, 'calls.json')) ? JSON.parse(fs.readFileSync(path.join(root, 'calls.json'), 'utf8')) : [],
      leftovers: [...fs.readdirSync(path.join(root, 'tmp')), ...fs.readdirSync(root).filter(file => file.startsWith('.image-gen-'))] };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

it('MiniMax generation sends the exact asset prompt, receives base64, and writes a PNG', () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), result.out);
  assert.deepEqual(result.image, png);
  assert.equal(result.calls.length, 1);
  const [call] = result.calls;
  assert.equal(call.url, 'https://api.minimax.io/v1/image_generation');
  assert.deepEqual(call.body, { model: 'image-01', prompt: 'A wordless botanical still life for the florist landing page.',
    width: 1408, height: 1408, n: 1, response_format: 'base64', prompt_optimizer: false });
  assert.match(call.headers, /Authorization: Bearer minimax-test-key/);
  assert.doesNotMatch(call.args.join(' '), /minimax-test-key|botanical/);
  assert.deepEqual(call.modes, [0o600, 0o600]);
  assert.deepEqual(result.leftovers, []);
});

it('MiniMax accepts an explicit local character reference without treating it as a general edit', () => {
  const result = run({ args: ['--character-ref', 'ref.png', '--width', '512', '--height', '1024'] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls[0].body.subject_reference, [{ type: 'character', image_file: `data:image/png;base64,${png.toString('base64')}` }]);
  assert.equal(result.calls[0].body.width, 512);
  assert.equal(result.calls[0].body.height, 1024);
  const edit = run({ args: ['--ref', 'ref.png'] });
  assert.notEqual(edit.status, 0);
  assert.match(edit.stderr, /general image editing/);
  assert.deepEqual(edit.calls, []);
});

it('MiniMax validates prompts, sizes, and references before spending a request', () => {
  for (const prompt of ['', '  ', 'x'.repeat(1501)]) {
    const result = run({ prompt });
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.calls, []);
  }
  assert.equal(run({ prompt: 'x'.repeat(1500) }).status, 0);
  for (const args of [
    ['--width', '511'], ['--height', '2056'], ['--width', '513'], ['--width', '512junk'],
    ['--character-ref'], ['--character-ref', 'missing.png'],
  ]) {
    const result = run({ args });
    assert.notEqual(result.status, 0, args.join(' '));
    assert.deepEqual(result.calls, []);
    assert.equal(result.image, null);
  }
  const invalid = run({ args: ['--character-ref', 'ref.png'], reference: Buffer.from('not an image') });
  assert.notEqual(invalid.status, 0);
  assert.deepEqual(invalid.calls, []);
  const oversized = run({ args: ['--character-ref', 'ref.png'], reference: Buffer.alloc(10 * 1024 * 1024) });
  assert.notEqual(oversized.status, 0);
  assert.deepEqual(oversized.calls, []);
});

it('MiniMax honors provider key selection from the environment and project config', () => {
  for (const options of [
    { env: { MINIMAX_API_KEY: '', IMAGE_GEN_API_KEY: 'generic-test-key' } },
    { env: { IMAGE_GEN_PROVIDER: '', MINIMAX_API_KEY: '' }, config: 'IMAGE_GEN_PROVIDER=minimax\nMINIMAX_API_KEY=minimax-config-key\n' },
  ]) {
    const result = run(options);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls[0].url, 'https://api.minimax.io/v1/image_generation');
    assert.match(result.calls[0].headers, /generic-test-key|minimax-config-key/);
  }
  const result = run({ env: { IMAGE_GEN_API_KEY: 'unrelated-generation-key' } });
  assert.match(result.calls[0].headers, /minimax-test-key/);
  assert.doesNotMatch(result.calls[0].headers, /unrelated-generation-key/);
  const missing = run({ env: { MINIMAX_API_KEY: '' } });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Missing MINIMAX_API_KEY or IMAGE_GEN_API_KEY/);
  assert.deepEqual(missing.calls, []);
});

it('MiniMax retries rate limits and transient server failures, but stops after three attempts', () => {
  const rate = { status: 200, json: { base_resp: { status_code: 1002 } } };
  const result = run({ responses: [{ status: 503, json: {} }, rate, success] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.length, 3);
  const exhausted = run({ responses: [rate] });
  assert.notEqual(exhausted.status, 0);
  assert.equal(exhausted.calls.length, 3);
  assert.equal(exhausted.image, null);
});

it('MiniMax failures never overwrite an existing asset or report an output path', () => {
  const existing = Buffer.from('existing asset');
  for (const response of [
    ...[1004, 2049, 1008, 1026, 2013].map(status_code => ({ status: 200, json: { base_resp: { status_code } } })),
    { status: 401, json: {} }, { status: 402, json: {} }, { status: 200, json: null },
    { status: 200, json: { base_resp: { status_code: 0 }, data: {} } },
    ...['', 'not base64!', Buffer.from('<html>error</html>').toString('base64'), png.subarray(0, 24).toString('base64')].map(encoded => ({
      status: 200, json: { base_resp: { status_code: 0 }, data: { image_base64: [encoded] } },
    })),
  ]) {
    const result = run({ responses: [response], existing });
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.length, 1);
    assert.equal(result.stdout, '');
    assert.deepEqual(result.image, existing);
    assert.deepEqual(result.leftovers, []);
    assert.doesNotMatch(result.stderr, /minimax-test-key/);
  }
});

it('the existing Gemini provider keeps its own key and PNG output contract', () => {
  const result = run({ env: { IMAGE_GEN_PROVIDER: 'gemini', IMAGE_GEN_API_KEY: 'gemini-test-key' },
    responses: [{ status: 200, json: { candidates: [{ content: { parts: [{ inlineData: { data: png.toString('base64') } }] } }] } }] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.image, png);
  assert.match(result.calls[0].url, /^https:\/\/generativelanguage\.googleapis\.com\//);
  assert.match(result.calls[0].headers, /gemini-test-key/);
  assert.doesNotMatch(result.calls[0].headers, /minimax-test-key/);
});

it('MiniMax converts JPEG output and preserves the existing asset if conversion fails', () => {
  const responses = [{ status: 200, json: { base_resp: { status_code: 0 }, data: { image_base64: [Buffer.from([255, 216, 255, 224]).toString('base64')] } } }];
  const result = run({ responses });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.image, png);
  assert.deepEqual(result.leftovers, []);
  const existing = Buffer.from('original asset');
  const failed = run({ responses, existing, conversionFails: true });
  assert.notEqual(failed.status, 0);
  assert.deepEqual(failed.image, existing);
  assert.deepEqual(failed.leftovers, []);
});
