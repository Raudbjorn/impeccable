import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'skill', 'scripts', 'design-context-import.mjs');

function makeCwd() {
  return mkdtempSync(path.join(tmpdir(), 'design-context-import-'));
}

function bundleFile(cwd, answers = { 'palette-primary': '#B8422E' }) {
  const file = path.join(cwd, 'bundle.json');
  writeFileSync(file, JSON.stringify({
    kind: 'impeccable-design-context',
    schemaVersion: 1,
    answers,
  }));
  return 'bundle.json';
}

function runImport(cwd, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

describe('design-context-import.mjs already-has-a-context guard', () => {
  it('refuses a plain import into a pickerless seed that staged assets but never wrote answers.json', () => {
    const cwd = makeCwd();
    const assetsDir = path.join(cwd, '.impeccable', 'design-context', 'assets');
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(path.join(assetsDir, 'logo.svg'), '<svg></svg>');

    const bundle = bundleFile(cwd);
    const res = runImport(cwd, [bundle]);

    assert.notEqual(res.status, 0, 'a store with staged assets but no answers.json must not read as empty');
    assert.match(res.stderr, /already has a design context/);
  });

  it('refuses a plain import into a project carrying only a cue manifest (cues.json)', () => {
    const cwd = makeCwd();
    const workspaceDir = path.join(cwd, '.impeccable', 'visual-cues');
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(path.join(workspaceDir, 'cues.json'), JSON.stringify({ cues: [], palette: {} }));

    const bundle = bundleFile(cwd);
    const res = runImport(cwd, [bundle]);

    assert.notEqual(res.status, 0, 'a store with a cue manifest but no answers.json must not read as empty');
    assert.match(res.stderr, /already has a design context/);
  });

  it('refuses a plain import into a project carrying only a font manifest (fonts.json)', () => {
    const cwd = makeCwd();
    const workspaceDir = path.join(cwd, '.impeccable', 'visual-cues');
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(path.join(workspaceDir, 'fonts.json'), JSON.stringify([]));

    const bundle = bundleFile(cwd);
    const res = runImport(cwd, [bundle]);

    assert.notEqual(res.status, 0, 'a store with a font manifest but no answers.json must not read as empty');
    assert.match(res.stderr, /already has a design context/);
  });

  it('still allows a plain import into a genuinely empty project', () => {
    const cwd = makeCwd();
    const bundle = bundleFile(cwd);
    const res = runImport(cwd, [bundle]);

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /IMPORTED \d+ files/);
  });

  it('--force still overrides the refusal with staged-only assets', () => {
    const cwd = makeCwd();
    const assetsDir = path.join(cwd, '.impeccable', 'design-context', 'assets');
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(path.join(assetsDir, 'logo.svg'), '<svg></svg>');

    const bundle = bundleFile(cwd);
    const res = runImport(cwd, [bundle, '--force']);

    assert.equal(res.status, 0, res.stderr);
  });
});

// Regression: portability.mjs's per-entry decoded-byte checks only bound
// file payloads at allowed paths inside the loop importDesignContext runs;
// they say nothing about the serialized bundle as a whole, which this CLI
// read into memory whole and JSON.parse()d before that loop ever started.
// An untrusted bundle with a huge designMd/answers field, or huge payloads
// on paths the loop would skip anyway, bypassed every internal cap.
describe('design-context-import.mjs bundle file-size cap', () => {
  it('refuses a bundle file larger than the documented cap, before reading or parsing it', () => {
    const cwd = makeCwd();
    const file = path.join(cwd, 'huge-bundle.json');
    // Content need not be valid JSON: the size check runs via stat(),
    // before readFile()/JSON.parse() ever touch the file.
    writeFileSync(file, Buffer.alloc(33 * 1024 * 1024, 'x'));

    const res = runImport(cwd, ['huge-bundle.json']);

    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /this release reads bundles up to/);
  });

  it('still allows a bundle file well under the cap', () => {
    const cwd = makeCwd();
    const bundle = bundleFile(cwd);
    const res = runImport(cwd, [bundle]);

    assert.equal(res.status, 0, res.stderr);
  });
});
