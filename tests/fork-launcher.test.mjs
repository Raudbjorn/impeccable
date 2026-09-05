import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const native of [false, true]) {
  test(`launcher preserves ${native ? 'explicit native engine' : 'fork command, arguments and cwd'}`, { skip: process.platform === 'win32' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'fork-launcher-'));
    try {
      const launcher = join(dir, 'impeccable');
      copyFileSync(new URL('../skill/scripts/impeccable', import.meta.url), launcher);
      writeFileSync(join(dir, 'concept-seed.mjs'), "console.log(JSON.stringify({runtime:'fork',cwd:process.cwd(),args:process.argv.slice(2)}));");
      const engine = join(dir, 'engine');
      writeFileSync(engine, '#!/bin/sh\nprintf native\n', { mode: 0o755 });
      const result = spawnSync('sh', [launcher, 'concept-seed', '--brief-file', 'brief with spaces.md'], {
        cwd: dir, encoding: 'utf8', env: {...process.env, IMPECCABLE_BIN:engine, IMPECCABLE_NATIVE:native ? '1' : ''},
      });
      assert.equal(result.status, 0, result.stderr);
      if (native) assert.equal(result.stdout, 'native');
      else assert.deepEqual(JSON.parse(result.stdout), {runtime:'fork',cwd:dir,args:['--brief-file','brief with spaces.md']});
    } finally { rmSync(dir, {recursive:true,force:true}); }
  });
}
