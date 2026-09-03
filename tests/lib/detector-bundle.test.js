import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'fs';
import os from 'node:os';
import path from 'path';
import { readSourceFiles } from '../../scripts/lib/utils.js';

const ROOT = process.cwd();

describe('skill detector bundle', () => {
  test('adds the detector wrapper and engine files to skill scripts', () => {
    const { skills } = readSourceFiles(ROOT);
    const skill = skills.find(s => s.name === 'impeccable');
    const scriptNames = new Set(skill.scripts.map(s => s.name));

    expect(scriptNames.has('detect.mjs')).toBe(true);
    expect(scriptNames.has('detector/detect-antipatterns.mjs')).toBe(true);
    expect(scriptNames.has('detector/detect-antipatterns-browser.js')).toBe(true);
    expect(scriptNames.has('detector/cli/main.mjs')).toBe(true);
    expect(scriptNames.has('detector/engines/static-html/detect-html.mjs')).toBe(true);
    expect(scriptNames.has('detector/vendor/static-html-parsers.mjs')).toBe(true);
    // The bundle's license notice must travel with it into every generated
    // skill/plugin artifact, not just live at the repo root.
    expect(scriptNames.has('detector/vendor/NOTICE.md')).toBe(true);
  });

  test('the vendored bundle NOTICE.md names every package it actually bundles', () => {
    // The shipped bundle has its module-path comments stripped for build
    // reproducibility (see build-static-html-parsers.js), so the package
    // list is read from --list-packages (a throwaway, unstripped rebuild)
    // rather than from the committed file itself.
    const result = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts/build-static-html-parsers.js'), '--list-packages'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || `--list-packages exited ${result.status}`);
    }
    const bundledPackages = JSON.parse(result.stdout);
    const notice = fs.readFileSync(path.join(ROOT, 'cli/engine/vendor/NOTICE.md'), 'utf8');
    expect(bundledPackages.length).toBeGreaterThan(0);
    for (const name of bundledPackages) {
      expect(notice).toContain(name);
    }
  });

  test('package.json ships NOTICE.md alongside the npm package', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.files).toContain('NOTICE.md');
  });

  test('static HTML parser vendor bundle matches a fresh rebuild byte-for-byte', () => {
    const result = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts/build-static-html-parsers.js'), '--check'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr || result.stdout || `--check exited ${result.status}`);
    }
    expect(result.status).toBe(0);
  });

  // Both tampering tests below use --output to point --check at a disposable
  // copy in the OS temp dir, rather than editing the committed vendor bundle
  // in place -- an interrupted test run or a concurrent reader must never see
  // a corrupted cli/engine/vendor/static-html-parsers.mjs.
  function withTamperedCopy(mutate, fn) {
    const original = fs.readFileSync(path.join(ROOT, 'cli/engine/vendor/static-html-parsers.mjs'), 'utf8');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-bundle-tamper-'));
    const copy = path.join(tmp, 'static-html-parsers.mjs');
    try {
      fs.writeFileSync(copy, mutate(original));
      return fn(copy);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  test('static HTML parser --check ignores a tampered digest comment (no longer trusted)', () => {
    // The digest line is documentation only now; --check rebuilds and
    // compares bytes, so a body-preserving edit to it must not matter.
    const result = withTamperedCopy(
      (original) => original.replace(/Source digest: [0-9a-f]+/, 'Source digest: deadbeefdeadbeef'),
      (copy) => spawnSync(
        process.execPath,
        [path.join(ROOT, 'scripts/build-static-html-parsers.js'), '--check', '--output', copy],
        { cwd: ROOT, encoding: 'utf8' },
      ),
    );
    expect(result.status).toBe(0);
  });

  test('static HTML parser --check fails when the bundle body no longer matches a fresh rebuild', () => {
    const result = withTamperedCopy(
      (original) => `${original}\n// tampered body\n`,
      (copy) => spawnSync(
        process.execPath,
        [path.join(ROOT, 'scripts/build-static-html-parsers.js'), '--check', '--output', copy],
        { cwd: ROOT, encoding: 'utf8' },
      ),
    );
    expect(result.status).toBe(1);
  });

  test('critique references the bundled detector command', () => {
    const critique = fs.readFileSync(path.join(ROOT, 'skill/reference/critique.md'), 'utf-8');

    expect(critique).toContain('node {{scripts_path}}/detect.mjs --json [target]');
    expect(critique).not.toContain('npx impeccable detect');
  });
});
