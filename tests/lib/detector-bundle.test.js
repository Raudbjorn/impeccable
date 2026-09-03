import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'fs';
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
    const bundle = fs.readFileSync(path.join(ROOT, 'cli/engine/vendor/static-html-parsers.mjs'), 'utf8');
    const notice = fs.readFileSync(path.join(ROOT, 'cli/engine/vendor/NOTICE.md'), 'utf8');
    const bundledPackages = new Set(
      [...bundle.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)].map(m => m[1]),
    );
    expect(bundledPackages.size).toBeGreaterThan(0);
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

  test('static HTML parser --check ignores a tampered digest comment (no longer trusted)', () => {
    const vendor = path.join(ROOT, 'cli/engine/vendor/static-html-parsers.mjs');
    const original = fs.readFileSync(vendor, 'utf8');
    try {
      // The digest line is documentation only now; --check rebuilds and
      // compares bytes, so a body-preserving edit to it must not matter.
      fs.writeFileSync(vendor, original.replace(/Source digest: [0-9a-f]+/, 'Source digest: deadbeefdeadbeef'));
      const result = spawnSync(
        process.execPath,
        [path.join(ROOT, 'scripts/build-static-html-parsers.js'), '--check'],
        { cwd: ROOT, encoding: 'utf8' },
      );
      expect(result.status).toBe(0);
    } finally {
      fs.writeFileSync(vendor, original);
    }
  });

  test('static HTML parser --check fails when the bundle body no longer matches a fresh rebuild', () => {
    const vendor = path.join(ROOT, 'cli/engine/vendor/static-html-parsers.mjs');
    const original = fs.readFileSync(vendor, 'utf8');
    try {
      fs.writeFileSync(vendor, `${original}\n// tampered body\n`);
      const result = spawnSync(
        process.execPath,
        [path.join(ROOT, 'scripts/build-static-html-parsers.js'), '--check'],
        { cwd: ROOT, encoding: 'utf8' },
      );
      expect(result.status).toBe(1);
    } finally {
      fs.writeFileSync(vendor, original);
    }
  });

  test('critique references the bundled detector command', () => {
    const critique = fs.readFileSync(path.join(ROOT, 'skill/reference/critique.md'), 'utf-8');

    expect(critique).toContain('node {{scripts_path}}/detect.mjs --json [target]');
    expect(critique).not.toContain('npx impeccable detect');
  });
});
