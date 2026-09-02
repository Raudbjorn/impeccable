import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'skill', 'scripts', 'design-context-export.mjs');

function makeCwd() {
  return mkdtempSync(path.join(tmpdir(), 'design-context-export-'));
}

function runExport(cwd, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

// Regression: migrate() (called before exportDesignContext()) writes
// through the same managed paths exportDesignContext() reads, and used to
// run before any symlink check -- including exportDesignContext()'s own,
// which never gets a chance to refuse if migrate() already wrote through a
// symlinked `.impeccable` ancestor.
describe('design-context-export.mjs refuses a symlinked .impeccable before migrate() runs', () => {
  it('refuses without ever calling migrateContextFromCues() through the link', () => {
    const cwd = makeCwd();
    const outsideDir = path.join(path.dirname(cwd), `outside-impeccable-${path.basename(cwd)}`);
    mkdirSync(path.join(outsideDir, 'visual-cues'), { recursive: true });
    writeFileSync(path.join(outsideDir, 'visual-cues', 'cues.json'), JSON.stringify({ modes: ['persuade'] }));
    symlinkSync(outsideDir, path.join(cwd, '.impeccable'));

    const res = runExport(cwd);

    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /is a symlink/);
    assert.equal(existsSync(path.join(outsideDir, 'design-context', 'context.json')), false,
      'migrate() must never have written through the symlinked ancestor');
  });
});
