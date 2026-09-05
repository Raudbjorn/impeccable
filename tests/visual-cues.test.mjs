import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePng } from '../skill/scripts/lib/png.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'skill', 'scripts', 'visual-cues.mjs');

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

// width x height RGBA pixels, filled solid except pixel (0,0) which gets its
// own color, so snapPalette's nearest-pixel search has an unambiguous target.
function squarePng(size, fillHex, cornerHex) {
  const data = new Uint8Array(size * size * 4);
  const fill = [
    parseInt(fillHex.slice(1, 3), 16), parseInt(fillHex.slice(3, 5), 16), parseInt(fillHex.slice(5, 7), 16),
  ];
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = fill[0]; data[i * 4 + 1] = fill[1]; data[i * 4 + 2] = fill[2]; data[i * 4 + 3] = 255;
  }
  if (cornerHex) {
    const corner = [
      parseInt(cornerHex.slice(1, 3), 16), parseInt(cornerHex.slice(3, 5), 16), parseInt(cornerHex.slice(5, 7), 16),
    ];
    data[0] = corner[0]; data[1] = corner[1]; data[2] = corner[2]; data[3] = 255;
  }
  return encodePng({ width: size, height: size, data });
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

describe('visual-cues compile', () => {
  it('decodes the hero, snaps the palette to the nearest pixel, and writes cues.json', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'visual-cues-compile-'));
    const outDir = path.join(dir, 'out');
    const hero = path.join(dir, 'hero.png');
    writeFileSync(hero, squarePng(8, '#202020', '#B8422E'));

    const res = run(['compile', hero, '--slug', 'amber-dusk', '--palette', 'primary=#B8422E;neutral=#202020', '--out', outDir]);
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.palette.primary.snapped, '#B8422E', 'the corner pixel is the nearest match for the corner-planted hex');
    assert.deepEqual(out.palette.primary.at, [0, 0]);
    assert.equal(out.palette.neutral.snapped, '#202020', 'the flood-fill color is the nearest match everywhere else');

    const cues = JSON.parse(readFileSync(path.join(outDir, 'cues.json'), 'utf8'));
    assert.deepEqual(cues.cues, ['amber-dusk']);
    assert.equal(cues.palette['amber-dusk'].primary.hex, '#B8422E');
    assert.ok(existsSync(path.join(outDir, 'amber-dusk.png')), 'the hero ships to <slug>.png');
  });

  it('accumulates a second compile into the same cues.json instead of overwriting it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'visual-cues-compile-'));
    const outDir = path.join(dir, 'out');
    const heroA = path.join(dir, 'a.png');
    const heroB = path.join(dir, 'b.png');
    writeFileSync(heroA, squarePng(8, '#111111'));
    writeFileSync(heroB, squarePng(8, '#222222'));

    run(['compile', heroA, '--slug', 'first-cue', '--out', outDir]);
    run(['compile', heroB, '--slug', 'second-cue', '--out', outDir]);

    const cues = JSON.parse(readFileSync(path.join(outDir, 'cues.json'), 'utf8'));
    assert.deepEqual(cues.cues, ['first-cue', 'second-cue']);
  });

  // Regression for PR #15 review thread: re-running compile on the canonical
  // <out>/<slug>.png to add a palette used to crash because copyFileSync
  // tried to copy a file onto itself. The skip-when-srcPath===heroPath
  // branch now lets the re-run succeed and update cues.json.
  it('re-runs cleanly when the source is the canonical <slug>.png from a prior compile', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'visual-cues-compile-'));
    const outDir = path.join(dir, 'out');
    const hero = path.join(dir, 'hero.png');
    writeFileSync(hero, squarePng(8, '#202020', '#B8422E'));

    // First compile with no palette.
    const first = run(['compile', hero, '--slug', 'amber-dusk', '--out', outDir]);
    assert.equal(first.status, 0, first.stderr);
    const canonical = path.join(outDir, 'amber-dusk.png');
    assert.ok(existsSync(canonical));

    // Re-run pointing compile at the canonical output itself, this time
    // with a palette. Without the fix this throws EEXIST/EBUSY because the
    // copy would target the file it is reading from.
    const second = run(['compile', canonical, '--slug', 'amber-dusk', '--palette', 'primary=#B8422E;neutral=#202020', '--out', outDir]);
    assert.equal(second.status, 0, second.stderr);

    const cues = JSON.parse(readFileSync(path.join(outDir, 'cues.json'), 'utf8'));
    assert.equal(cues.palette['amber-dusk'].primary.hex, '#B8422E', 'the palette from the re-run is now on the manifest');
  });

  // Regression for PR #15 review thread: the cleanup after copying the hero
  // matched any file in outDir sharing srcPath's directory, not only the
  // `<slug>-hero.png` intermediate it was meant to remove. Compiling an
  // already-canonical cue's hero (itself sitting in outDir) into a different
  // slug deleted that first cue's file out from under cues.json, which still
  // named it.
  it('compiling one canonical cue into another slug leaves the first cue\'s file in place', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'visual-cues-compile-'));
    const outDir = path.join(dir, 'out');
    const heroA = path.join(dir, 'a.png');
    writeFileSync(heroA, squarePng(8, '#111111'));

    const first = run(['compile', heroA, '--slug', 'first-cue', '--out', outDir]);
    assert.equal(first.status, 0, first.stderr);
    const firstCanonical = path.join(outDir, 'first-cue.png');
    assert.ok(existsSync(firstCanonical));

    // Compile that same canonical file again, under a different slug.
    const second = run(['compile', firstCanonical, '--slug', 'second-cue', '--out', outDir]);
    assert.equal(second.status, 0, second.stderr);

    assert.ok(existsSync(firstCanonical), 'first-cue.png must survive compiling it into second-cue');
    assert.ok(existsSync(path.join(outDir, 'second-cue.png')));
    const cues = JSON.parse(readFileSync(path.join(outDir, 'cues.json'), 'utf8'));
    assert.deepEqual(cues.cues, ['first-cue', 'second-cue']);
  });

  it('rejects a non-square hero instead of silently cropping or stretching it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'visual-cues-compile-'));
    const hero = path.join(dir, 'hero.png');
    writeFileSync(hero, encodePng({ width: 8, height: 4, data: new Uint8Array(8 * 4 * 4) }));

    const res = run(['compile', hero, '--slug', 'not-square', '--out', path.join(dir, 'out')]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /8x4, not square/);
  });

  it('rejects a malformed slug', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'visual-cues-compile-'));
    const hero = path.join(dir, 'hero.png');
    writeFileSync(hero, squarePng(4, '#000000'));

    const res = run(['compile', hero, '--slug', 'NotValid', '--out', path.join(dir, 'out')]);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /must be lowercase words joined by hyphens/);
  });
});
