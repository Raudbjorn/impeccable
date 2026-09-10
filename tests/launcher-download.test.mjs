import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAYLOAD = Buffer.from('#!/bin/sh\necho verified-engine\n');
const HASH = createHash('sha256').update(PAYLOAD).digest('hex');

async function exercise(t, scenario) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-launcher-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scripts = path.join(root, 'skill scripts');
  const home = path.join(root, 'home');
  const cache = path.join(root, 'cache');
  fs.mkdirSync(scripts);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(scripts, 'VERSION'), '0.0.0-test\n');
  const name = 'impeccable';
  const launcher = path.join(scripts, name);
  fs.copyFileSync(path.join(ROOT, 'skill/scripts', name), launcher);
  const cacheDir = path.join(cache, 'bin', '0.0.0-test');
  const tools = path.join(root, 'tools');
  fs.mkdirSync(tools);
  if (['hash-failure', 'removed-during-hash'].includes(scenario)) {
    fs.writeFileSync(path.join(tools, 'shasum'),
      `#!/bin/sh\n${scenario === 'removed-during-hash' ? 'rm -f "$3"\n' : ''}printf '%s  %s\\n' '${HASH}' "$3"\nexit ${scenario === 'hash-failure' ? 1 : 0}\n`,
      { mode: 0o755 });
  }
  const placementScenarios = ['removed-before-move', 'removed-after-move', 'emptied-after-move', 'move-failure'];
  if (placementScenarios.includes(scenario)) {
    const before = scenario === 'removed-before-move' ? 'rm -f "$2"\n' : '';
    const after = scenario === 'removed-after-move' ? 'rm -f "$3"\n' : scenario === 'emptied-after-move' ? ': > "$3"\n' : '';
    fs.writeFileSync(path.join(tools, 'mv'), scenario === 'move-failure' ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh\n${before}/bin/mv "$@" || exit $?\n${after}`, { mode: 0o755 });
  }
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url.endsWith('.sha256')) {
      const part = fs.readdirSync(cacheDir).find(file => file.includes('.part'));
      if (scenario === 'removed') fs.unlinkSync(path.join(cacheDir, part));
      if (scenario === 'emptied') fs.truncateSync(path.join(cacheDir, part));
      res.writeHead(scenario === 'no-sidecar' ? 404 : 200);
      res.end(scenario === 'empty-sidecar' ? '' : `${scenario === 'mismatch' ? '0'.repeat(64) : HASH}  engine\n`);
    } else {
      res.end(scenario === 'empty-download' ? '' : PAYLOAD);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  // Keep system tools, but exclude user/npm PATH candidates and all launcher
  // overrides so the test cannot accidentally execute an installed engine.
  const env = {
    PATH: `${tools}:/usr/bin:/bin`,
    HOME: home, USERPROFILE: home, TEMP: root, TMP: root,
    IMPECCABLE_HOME: cache,
    IMPECCABLE_DOWNLOAD_BASE: `http://127.0.0.1:${server.address().port}`,
  };
  const result = await new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', [launcher], { env, cwd: root, timeout: 20000 });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  assert.equal(result.signal, null, JSON.stringify(result));
  assert.equal(requests.filter(url => !url.endsWith('.sha256')).length, 1, 'one binary download, no verification retry loop');
  return { ...result, files: fs.readdirSync(cacheDir), requests };
}

test('launcher downloads and runs a verified executable', async t => {
  const result = await exercise(t, 'valid');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verified-engine/);
  assert.deepEqual(result.files, ['impeccable']);
  assert.equal(result.requests.length, 2);
});

for (const scenario of ['removed', 'emptied', 'empty-download', 'no-sidecar', 'empty-sidecar', 'mismatch', 'hash-failure', 'removed-during-hash', 'removed-before-move', 'removed-after-move', 'emptied-after-move', 'move-failure']) {
  test(`launcher refuses ${scenario} with an accurate diagnostic`, async t => {
    const result = await exercise(t, scenario);
    assert.equal(result.status, 127, JSON.stringify(result));
    assert.doesNotMatch(result.stdout, /verified-engine/);
    assert.deepEqual(result.files, [], 'no unverified file or sidecar left behind');
    if (scenario.startsWith('removed')) {
      assert.match(result.stderr, /download completed but the file was removed before (verification|execution)/);
      assert.match(result.stderr, /antivirus.*logs/i);
      assert.doesNotMatch(result.stderr, /checksum mismatch/);
    } else if (scenario.startsWith('emptied') || scenario === 'empty-download') {
      assert.match(result.stderr, /downloaded file is empty/);
      assert.doesNotMatch(result.stderr, /checksum mismatch/);
    } else if (scenario === 'mismatch') {
      assert.match(result.stderr, /checksum mismatch/);
    } else if (scenario === 'move-failure') {
      assert.match(result.stderr, /could not cache the verified download/);
    } else {
      assert.match(result.stderr, /refusing the unverified download/);
    }
  });
}

test('removed hosts cannot execute an override or attempt a download', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-host-rejection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'uname'), '#!/bin/sh\nif [ "$1" = "-s" ]; then echo "$TEST_OS"; else echo "$TEST_ARCH"; fi\n', { mode: 0o755 });
  for (const [platform, osName] of [['darwin', 'Darwin'], ['win32', 'Windows_NT']]) {
    for (const arch of ['x64', 'arm64']) {
      const env = { ...process.env, PATH: `${root}:/usr/bin:/bin`, TEST_OS: osName, TEST_ARCH: arch === 'x64' ? 'x86_64' : 'aarch64', IMPECCABLE_BIN: '/usr/bin/true' };
      const shell = spawnSync('/bin/sh', [path.join(ROOT, 'skill/scripts/impeccable')], { env, encoding: 'utf8' });
      assert.equal(shell.status, 127);
      assert.match(shell.stderr, /unsupported platform/);
      const shim = spawnSync(process.execPath, ['--import', `data:text/javascript,Object.defineProperty(process,'platform',{value:'${platform}'});Object.defineProperty(process,'arch',{value:'${arch}'});`, path.join(ROOT, 'cli/bin/cli.js'), 'context'], { env, encoding: 'utf8' });
      assert.equal(shim.status, 127);
      assert.match(shim.stderr, /unsupported platform/);
    }
  }
});
