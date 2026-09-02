import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'skill', 'scripts', 'visual-cues.mjs');

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

describe('visual-cues hash', () => {
  it('prints a stable sha256 per file, the same for identical bytes and different otherwise', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'visual-cues-hash-'));
    const a = path.join(dir, 'a.png');
    const b = path.join(dir, 'b.png');
    const c = path.join(dir, 'c.png'); // byte-identical to a: the raced-duplicate case
    writeFileSync(a, 'hero bytes one');
    writeFileSync(b, 'hero bytes two');
    writeFileSync(c, 'hero bytes one');

    const res = run(['hash', a, b, c]);
    assert.equal(res.status, 0, res.stderr);
    const lines = res.stdout.trim().split('\n');
    assert.equal(lines.length, 3);
    // Each line is "<64-hex-digest>  <path>" (md5sum-style); a path containing
    // spaces would break a whitespace split, so match the fixed-width digest
    // instead of splitting the line.
    const [hashA, hashB, hashC] = lines.map((line) => line.match(/^[0-9a-f]{64}/)[0]);
    assert.equal(hashA, hashC, 'identical files must hash identically, so the uniqueness gate catches the race');
    assert.notEqual(hashA, hashB);
    assert.match(hashA, /^[0-9a-f]{64}$/, 'sha256 hex digest');
  });

  it('fails clearly with no paths', () => {
    const res = run(['hash']);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /usage: visual-cues\.mjs hash/);
  });
});
