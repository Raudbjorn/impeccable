import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'skill', 'scripts', 'design-context-import.mjs');

// Every project makeCwd() creates, plus every sibling "outside-*" directory
// this suite plants next to it, used to land directly under the shared OS
// temp directory with nothing ever removing them. Nesting everything one
// level under a single sandbox root means a project's siblings land inside
// that root too (dirname(cwd) is the root, not the shared OS temp dir), so
// one recursive removal after the whole suite catches all of it.
const sandboxRoot = mkdtempSync(path.join(tmpdir(), 'design-context-import-sandbox-'));
after(() => rmSync(sandboxRoot, { recursive: true, force: true }));

function makeCwd() {
  return mkdtempSync(path.join(sandboxRoot, 'project-'));
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

function runImport(cwd, args, opts = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8', ...opts });
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

  // Regression: a pickerless seed can consist of DESIGN.md alone, at the
  // project root, with nothing under .impeccable/ at all -- design-context.md's
  // own no-argument status routing already treats that as a real record. A
  // plain import used to overlay another bundle's answers/context onto that
  // world without requiring --force, and left the existing DESIGN.md in
  // place (--design defaults to "skip"), leaving a mixed context.
  it('refuses a plain import into a project carrying only a root DESIGN.md', () => {
    const cwd = makeCwd();
    writeFileSync(path.join(cwd, 'DESIGN.md'), '# Seed\n\nSome direction.\n');

    const bundle = bundleFile(cwd);
    const res = runImport(cwd, [bundle]);

    assert.notEqual(res.status, 0, 'a project with only DESIGN.md must not read as empty');
    assert.match(res.stderr, /already has a design context/);
  });
});

// Regression: the bundle size check above stat()s the path and compares
// only its `size`, which is meaningful for a regular file but not for a
// FIFO or character device (commonly 0 regardless of what actually flows
// through it, or unbounded). A bundle path pointing at one of those would
// pass the size check and then reach readFile(), which has no cap of its
// own and can block or read unbounded data.
describe('design-context-import.mjs bundle non-regular-file guard', () => {
  it('refuses a bundle path that is a FIFO instead of reading it', async () => {
    if (process.platform === 'win32') return; // mkfifo is POSIX-only
    const cwd = makeCwd();
    const fifoPath = path.join(cwd, 'bundle.json');
    const mkfifo = spawnSync('mkfifo', [fifoPath]);
    if (mkfifo.error || mkfifo.status !== 0) return; // mkfifo unavailable in this environment

    const res = runImport(cwd, ['bundle.json'], { timeout: 5000 });

    assert.notEqual(res.status, 0, 'a FIFO must be refused, not read');
    assert.match(res.stderr, /not a regular file/);
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

// Regression: migrate() writes through the same managed paths
// importDesignContext() does, and used to run before any symlink check --
// including importDesignContext()'s own, which never gets called at all if
// migrate() itself already wrote through a symlinked `.impeccable` ancestor.
describe('design-context-import.mjs refuses a symlinked .impeccable before migrate() runs', () => {
  it('refuses without ever calling migrateContextFromCues() through the link', () => {
    const cwd = makeCwd();
    const outsideDir = path.join(path.dirname(cwd), `outside-impeccable-${path.basename(cwd)}`);
    mkdirSync(path.join(outsideDir, 'visual-cues'), { recursive: true });
    // migrateContextFromCues() (called by migrate() even with no legacy
    // dir) writes context.json from cues.json when it carries modes/context
    // and context.json does not exist yet -- exactly the write this guard
    // must block before it goes through a symlinked `.impeccable`.
    writeFileSync(path.join(outsideDir, 'visual-cues', 'cues.json'), JSON.stringify({ modes: ['persuade'] }));
    symlinkSync(outsideDir, path.join(cwd, '.impeccable'));

    const bundle = bundleFile(cwd);
    const res = runImport(cwd, [bundle]);

    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /is a symlink/);
    assert.equal(existsSync(path.join(outsideDir, 'design-context', 'context.json')), false,
      'migrate() must never have written through the symlinked ancestor');
  });

  // Regression: the guard above only checked the four managed JSON
  // destinations; migrate() also moves legacy assets/fonts/journal onto
  // target.assetsDir/target.fontsDir/target.journalJsonl, and reads them
  // from `.impeccable/design-interview` in the first place. Neither
  // direction was covered.
  it('refuses when the assets/ migration destination is a symlink, before moving anything onto it', () => {
    const cwd = makeCwd();
    const legacyDir = path.join(cwd, '.impeccable', 'design-interview');
    mkdirSync(path.join(legacyDir, 'assets'), { recursive: true });
    writeFileSync(path.join(legacyDir, 'assets', 'logo.svg'), '<svg></svg>');
    const outsideDir = path.join(path.dirname(cwd), `outside-assets-${path.basename(cwd)}`);
    mkdirSync(outsideDir, { recursive: true });
    mkdirSync(path.join(cwd, '.impeccable', 'design-context'), { recursive: true });
    symlinkSync(outsideDir, path.join(cwd, '.impeccable', 'design-context', 'assets'));

    const bundle = bundleFile(cwd);
    const res = runImport(cwd, [bundle]);

    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /is a symlink/);
    assert.equal(existsSync(path.join(outsideDir, 'logo.svg')), false,
      'migrate() must never have moved the legacy asset through the symlinked destination');
  });

  it('refuses when the legacy assets/ source is a symlink, before reading or moving anything from it', () => {
    const cwd = makeCwd();
    const outsideDir = path.join(path.dirname(cwd), `outside-legacy-assets-${path.basename(cwd)}`);
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(path.join(outsideDir, 'secret.svg'), 'do not move me');
    mkdirSync(path.join(cwd, '.impeccable', 'design-interview'), { recursive: true });
    symlinkSync(outsideDir, path.join(cwd, '.impeccable', 'design-interview', 'assets'));

    const bundle = bundleFile(cwd);
    const res = runImport(cwd, [bundle]);

    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /is a symlink/);
    assert.equal(existsSync(path.join(outsideDir, 'secret.svg')), true,
      'migrate() must never have moved the external file out through the symlinked legacy source');
    assert.equal(existsSync(path.join(cwd, '.impeccable', 'design-context', 'assets', 'secret.svg')), false);
  });

  it('refuses when the legacy journal source is a symlink, before migrate() reads doc-session.json through it', () => {
    const cwd = makeCwd();
    const outsideDir = path.join(path.dirname(cwd), `outside-legacy-dir-${path.basename(cwd)}`);
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(path.join(outsideDir, 'doc-session.json'), JSON.stringify({ pid: process.pid, port: 4321 }));
    mkdirSync(path.join(cwd, '.impeccable'), { recursive: true });
    symlinkSync(outsideDir, path.join(cwd, '.impeccable', 'design-interview'));

    const bundle = bundleFile(cwd);
    const res = runImport(cwd, [bundle]);

    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /is a symlink/);
  });

  // Regression: the move-source/destination paths above (assets/, fonts/,
  // journal, and every legacy.* path) were checked unconditionally, even
  // though migrate() only ever touches them when a legacy store
  // (.impeccable/design-interview) actually exists on disk -- with none,
  // migrate() returns after calling only migrateContextFromCues(), which
  // never goes near target.assetsDir/target.fontsDir. A symlinked
  // current-store assets/ on a project that was never migrated hard-failed
  // the whole import even though exportDesignContext() itself tolerates
  // that same symlink and continues past it.
  it('still imports when the current-store assets/ is a symlink but no legacy store exists to migrate', () => {
    const cwd = makeCwd();
    const outsideDir = path.join(path.dirname(cwd), `outside-current-assets-${path.basename(cwd)}`);
    mkdirSync(outsideDir, { recursive: true });
    mkdirSync(path.join(cwd, '.impeccable', 'design-context'), { recursive: true });
    symlinkSync(outsideDir, path.join(cwd, '.impeccable', 'design-context', 'assets'));

    const bundle = bundleFile(cwd);
    const res = runImport(cwd, [bundle]);

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /IMPORTED \d+ files/);
  });
});
