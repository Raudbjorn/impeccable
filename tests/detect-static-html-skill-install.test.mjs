import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findEngineBinary, ENGINE_MISSING_MESSAGE } from './lib/engine-bin.mjs';

const engine = findEngineBinary();

describe('static HTML in standalone installs', { skip: engine ? false : ENGINE_MISSING_MESSAGE }, () => {
  for (const layout of ['scripts', 'skills/impeccable/scripts']) {
    it(`detects external CSS from ${layout} without Node dependencies`, () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-native-install-'));
      try {
        const bin = path.join(tmp, layout, process.platform === 'win32' ? 'impeccable.exe' : 'impeccable');
        fs.mkdirSync(path.dirname(bin), { recursive: true });
        fs.copyFileSync(engine, bin);
        fs.chmodSync(bin, 0o755);
        fs.writeFileSync(path.join(tmp, 's.css'), ':root{--grad:linear-gradient(90deg,#7C3AED,#EC4899)}\n.hero h1{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}');
        fs.writeFileSync(path.join(tmp, 'p.html'), '<html><head><link rel=stylesheet href=s.css></head><body><div class=hero><h1>Hi</h1></div></body></html>');
        const result = spawnSync(bin, ['detect', '--json', '--no-config', '--no-design-system', 'p.html'], { cwd: tmp, encoding: 'utf8' });
        assert.equal(result.status, 2, result.stderr);
        assert.ok(JSON.parse(result.stdout).some((f) => f.antipattern === 'gradient-text'));
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
});
