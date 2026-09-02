import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, stat, readFile, writeFile as writeFileP, mkdir as mkdirP } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { importDesignContext, exportDesignContext } from '../skill/scripts/design-context/portability.mjs';
import { paths, readAnswers } from '../skill/scripts/design-context/store.mjs';

async function makeCwd() {
  return mkdtemp(path.join(tmpdir(), 'design-context-portability-'));
}

function bundleWithFiles(files) {
  return {
    kind: 'impeccable-design-context',
    schemaVersion: 1,
    answers: { 'palette-primary': '#B8422E' },
    files,
  };
}

describe('importDesignContext file entries', () => {
  it('skips a "assets/.." entry instead of crashing (regression: writeFile on a directory throws EISDIR uncaught)', async () => {
    const cwd = await makeCwd();
    const bundle = bundleWithFiles([
      { path: 'assets/..', base64: Buffer.from('not a real file').toString('base64') },
    ]);

    const result = await importDesignContext(cwd, bundle);

    assert.equal(result.written, 0, 'the malformed entry must not count as written');
    // The store directory itself must still be a directory, never overwritten.
    const target = paths(cwd);
    assert.ok((await stat(target.storeDir)).isDirectory());
    assert.equal(await readAnswers(cwd).then((a) => a['palette-primary']), '#B8422E', 'the rest of the import still completed');
  });

  it('skips a bare "assets/." entry the same way', async () => {
    const cwd = await makeCwd();
    const bundle = bundleWithFiles([{ path: 'assets/.', base64: '' }]);

    const result = await importDesignContext(cwd, bundle);

    assert.equal(result.written, 0);
  });

  it('still writes a real file at an allowed path', async () => {
    const cwd = await makeCwd();
    const bytes = Buffer.from('fake logo bytes');
    const bundle = bundleWithFiles([{ path: 'assets/logo.svg', base64: bytes.toString('base64') }]);

    const result = await importDesignContext(cwd, bundle);

    assert.equal(result.written, 1);
    const target = paths(cwd);
    const written = await readdir(target.assetsDir);
    assert.deepEqual(written, ['logo.svg']);
  });

  it('rejects a path that escapes the store outright', async () => {
    const cwd = await makeCwd();
    const bundle = bundleWithFiles([
      { path: 'assets/../../outside.txt', base64: Buffer.from('x').toString('base64') },
    ]);

    const result = await importDesignContext(cwd, bundle);

    assert.equal(result.written, 0);
    // storeDir is <cwd>/.impeccable/design-context, so 'assets/../../outside.txt'
    // resolves to <cwd>/.impeccable/outside.txt -- still inside cwd, just outside
    // storeDir. Assert on the path the entry actually resolves to; checking
    // one cwd level up (outside cwd entirely) passed even with the
    // containment check removed, and could fail on an unrelated file another
    // process left in the shared tmpdir.
    await assert.rejects(stat(path.resolve(cwd, '.impeccable/outside.txt')));
  });

  it('rejects a Windows-separator escape that the forward-slash-only regex alone would accept', async () => {
    const cwd = await makeCwd();
    // No forward slash in "..\answers.json", so ALLOWED_FILE's [^/]+ used to
    // accept the whole thing; path.resolve on win32 still treats "\" as a
    // separator and walks it up to the store's own answers.json.
    const bundle = bundleWithFiles([
      { path: 'assets/..\\answers.json', base64: Buffer.from('{"pwned":true}').toString('base64') },
    ]);

    const result = await importDesignContext(cwd, bundle);

    assert.equal(result.written, 0, 'a backslash-separator escape must be skipped, not written');
  });

  it('rejects a NUL byte in the file segment instead of crashing writeFile() uncaught', async () => {
    const cwd = await makeCwd();
    const bundle = bundleWithFiles([
      { path: 'assets/logo\0.svg', base64: Buffer.from('x').toString('base64') },
    ]);

    const result = await importDesignContext(cwd, bundle);

    assert.equal(result.written, 0, 'a NUL-containing entry must be skipped, not written');
    // The rest of the import still completed instead of throwing partway through.
    assert.equal(await readAnswers(cwd).then((a) => a['palette-primary']), '#B8422E');
  });

  it('rejects a bundle entry larger than the per-file cap before writing anything', async () => {
    const cwd = await makeCwd();
    const oversized = Buffer.alloc(9 * 1024 * 1024, 'a');
    const bundle = bundleWithFiles([
      { path: 'assets/huge.png', base64: oversized.toString('base64') },
    ]);

    await assert.rejects(importDesignContext(cwd, bundle), /larger than this release accepts/);
    // No mutation must have landed: the oversized entry is caught before any write.
    const target = paths(cwd);
    assert.equal(await stat(target.storeDir).then(() => true, () => false), false);
  });

  it('accepts a file at exactly the per-file cap (regression: the padding-blind estimate rejected it as one byte over)', async () => {
    const cwd = await makeCwd();
    // Exactly MAX_FILE_BYTES (8 MiB) encodes with one "=" of padding; the
    // estimate `floor(raw.length * 3 / 4)` counted that padding byte as
    // data and evaluated to MAX_FILE_BYTES + 1, rejecting a file export
    // itself permits.
    const exact = Buffer.alloc(8 * 1024 * 1024, 'a');
    const base64 = exact.toString('base64');
    assert.ok(base64.endsWith('=') && !base64.endsWith('=='), 'fixture must exercise the single-padding-byte case');
    const bundle = bundleWithFiles([{ path: 'assets/exact.png', base64 }]);

    const result = await importDesignContext(cwd, bundle);

    assert.equal(result.written, 1, 'a file at exactly the documented cap must import');
  });

  it('rejects a bundle naming more files than an export ever produces', async () => {
    const cwd = await makeCwd();
    const files = Array.from({ length: 513 }, (_, i) => ({
      path: `assets/file-${i}.png`,
      base64: Buffer.from('x').toString('base64'),
    }));
    const bundle = bundleWithFiles(files);

    await assert.rejects(importDesignContext(cwd, bundle), /imports at most/);
    const target = paths(cwd);
    assert.equal(await stat(target.storeDir).then(() => true, () => false), false, 'no mutation before the count check');
  });

  it('rejects a non-canonical base64 payload instead of writing garbled or truncated bytes', async () => {
    const cwd = await makeCwd();
    // "!!" are not valid base64 alphabet characters; Buffer.from silently
    // drops them rather than throwing, so a naive decode would succeed with
    // wrong bytes and report the import as having worked.
    const bundle = bundleWithFiles([
      { path: 'assets/logo.svg', base64: 'not-!!valid-base64!!' },
    ]);

    await assert.rejects(importDesignContext(cwd, bundle), /valid base64/);
  });

  it('rejects a non-string base64 field instead of coercing it with String()', async () => {
    const cwd = await makeCwd();
    const bundle = bundleWithFiles([
      { path: 'assets/logo.svg', base64: { not: 'a string' } },
    ]);

    await assert.rejects(importDesignContext(cwd, bundle), /valid base64/);
  });
});

describe('importDesignContext symlink rejection', () => {
  // Regression for PR #15 review thread: a pre-existing symlink at `assets/`
  // or `fonts/` would let writeFile() follow the link and write the bundle's
  // bytes outside the project. The lexical containment check on its own
  // does not see this; refuse any link along the destination path or at the
  // file itself.
  it('refuses to write when the destination parent is a symlink to outside the store', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    // Point `assets/` at a directory outside the project entirely.
    const outsideDir = path.join(path.dirname(cwd), `outside-${path.basename(cwd)}`);
    const { mkdir, symlink } = await import('node:fs/promises');
    await mkdir(outsideDir, { recursive: true });
    await mkdirP(target.storeDir, { recursive: true });
    await symlink(outsideDir, target.assetsDir);

    const bundle = bundleWithFiles([
      { path: 'assets/logo.svg', base64: Buffer.from('escaped bytes').toString('base64') },
    ]);
    const result = await importDesignContext(cwd, bundle);

    assert.equal(result.written, 0, 'a symlinked assets/ must block the write');
    // The bytes must not have landed at the symlink target either.
    const outsideContents = await readdir(outsideDir).catch(() => []);
    assert.equal(outsideContents.length, 0, 'the linked target must stay empty');
  });

  it('refuses to import through a symlinked store root before any mutation', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    const outsideDir = path.join(path.dirname(cwd), `outside-root-${path.basename(cwd)}`);
    const { symlink } = await import('node:fs/promises');
    await mkdirP(outsideDir, { recursive: true });
    await mkdirP(path.dirname(target.storeDir), { recursive: true });
    // hasManagedState() (design-context-import.mjs) only checks for specific
    // files inside the store, so an empty symlinked root would otherwise
    // pass that guard and let every write below follow the link outside.
    await symlink(outsideDir, target.storeDir);

    const bundle = bundleWithFiles([
      { path: 'assets/logo.svg', base64: Buffer.from('bytes').toString('base64') },
    ]);
    await assert.rejects(importDesignContext(cwd, bundle), /symlink/);

    const outsideContents = await readdir(outsideDir).catch(() => []);
    assert.equal(outsideContents.length, 0, 'nothing must have been written through the symlinked root');
  });

  it('refuses to import when an ancestor of the store root (not the root itself) is a symlink', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    // Symlink `.impeccable` itself, one level above target.storeDir. The
    // store dir (`.impeccable/design-context`) does not exist inside the
    // link's target, so an lstat of target.storeDir alone reports ENOENT
    // and would previously miss that its parent is the symlink.
    const outsideDir = path.join(path.dirname(cwd), `outside-impeccable-${path.basename(cwd)}`);
    const { symlink } = await import('node:fs/promises');
    await mkdirP(outsideDir, { recursive: true });
    await symlink(outsideDir, path.dirname(target.storeDir));

    const bundle = bundleWithFiles([
      { path: 'assets/logo.svg', base64: Buffer.from('bytes').toString('base64') },
    ]);
    await assert.rejects(importDesignContext(cwd, bundle), /symlink/);

    const outsideContents = await readdir(outsideDir).catch(() => []);
    assert.equal(outsideContents.length, 0, 'nothing must have been written through the symlinked ancestor');
  });

  it('refuses to import when the visual-cues workspace dir is a symlink, even with a real store root', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(target.storeDir, { recursive: true });
    const workspaceDir = path.dirname(target.cuesJson);
    const outsideDir = path.join(path.dirname(cwd), `outside-workspace-${path.basename(cwd)}`);
    const { symlink } = await import('node:fs/promises');
    await mkdirP(outsideDir, { recursive: true });
    await mkdirP(path.dirname(workspaceDir), { recursive: true });
    await symlink(outsideDir, workspaceDir);

    const bundle = bundleWithFiles([]);
    await assert.rejects(importDesignContext(cwd, bundle), /symlink/);

    const outsideContents = await readdir(outsideDir).catch(() => []);
    assert.equal(outsideContents.length, 0, 'cues.json/fonts.json must never be written through the symlinked workspace dir');
  });

  it('refuses to write when the destination file itself is a pre-existing symlink', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(target.assetsDir, { recursive: true });
    // Pre-existing link at the exact destination the bundle wants to write.
    const realOutside = path.join(cwd, '..', `secret-${path.basename(cwd)}.txt`);
    await writeFileP(realOutside, 'do not leak me');
    const { symlink } = await import('node:fs/promises');
    await symlink(realOutside, path.join(target.assetsDir, 'logo.svg'));

    const bundle = bundleWithFiles([
      { path: 'assets/logo.svg', base64: Buffer.from('payload').toString('base64') },
    ]);
    const result = await importDesignContext(cwd, bundle);

    assert.equal(result.written, 0, 'a symlinked destination must not be followed');
    // The link target still holds the original secret, not the bundle bytes.
    assert.equal(await readFile(realOutside, 'utf8'), 'do not leak me');
  });

  // Regression: a pre-existing directory at an allowed destination (a user
  // could create `assets/logo.svg/` themselves) made writeFile() throw
  // EISDIR, uncaught, aborting the import after the forced rm()s and any
  // earlier file in this loop had already landed -- a partially replaced
  // store.
  it('skips a pre-existing directory at the destination instead of crashing with EISDIR', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(path.join(target.assetsDir, 'logo.svg'), { recursive: true }); // a directory, not a file, at the destination

    const bundle = bundleWithFiles([
      { path: 'assets/logo.svg', base64: Buffer.from('payload').toString('base64') },
    ]);
    const result = await importDesignContext(cwd, bundle);

    assert.equal(result.written, 0, 'the directory must not be treated as written');
    assert.ok((await stat(path.join(target.assetsDir, 'logo.svg'))).isDirectory(), 'the directory must survive untouched');
    // The rest of the import still completed instead of throwing partway through.
    assert.equal(await readAnswers(cwd).then((a) => a['palette-primary']), '#B8422E');
  });

  // Regression: the per-file destination checks above (and the store/
  // workspace ancestor checks) never inspected writeJsonAtomic()'s own
  // predictable `${filePath}.tmp` temp path. A pre-existing symlink there
  // passed every other check, and writeFile() on the temp path followed it,
  // overwriting the link's external target before rename() moved the
  // (now-symlink) entry onto answers.json.
  it('refuses to write through a pre-existing symlink at answers.json\'s atomic-write temp path', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(target.storeDir, { recursive: true });
    const realOutside = path.join(path.dirname(cwd), `secret-answers-${path.basename(cwd)}.json`);
    await writeFileP(realOutside, 'do not overwrite me');
    const { symlink } = await import('node:fs/promises');
    // writeJsonAtomic's old temp name was exactly `${filePath}.tmp`.
    await symlink(realOutside, `${target.answersJson}.tmp`);

    const bundle = {
      kind: 'impeccable-design-context',
      schemaVersion: 1,
      answers: { 'palette-primary': '#B8422E' },
      files: [],
    };
    await importDesignContext(cwd, bundle);

    assert.equal(await readFile(realOutside, 'utf8'), 'do not overwrite me', 'the link target must be untouched');
    // answers.json itself must be a real file with the imported content,
    // not a symlink left behind by a rename() onto a followed link.
    const answersStat = await import('node:fs/promises').then((m) => m.lstat(target.answersJson));
    assert.ok(answersStat.isFile(), 'answers.json must end up a real file, not a symlink');
    assert.equal(await readAnswers(cwd).then((a) => a['palette-primary']), '#B8422E');
  });
});

describe('exportDesignContext with no questionnaire record', () => {
  it('still exports when a pickerless interview seed left DESIGN.md and staged assets but no answers.json', async () => {
    const cwd = await makeCwd();
    await writeFileP(path.resolve(cwd, 'DESIGN.md'), '# Seed\n\nSome direction.\n');
    const target = paths(cwd);
    await mkdirP(target.assetsDir, { recursive: true });
    await writeFileP(path.join(target.assetsDir, 'logo.svg'), '<svg></svg>');

    const result = await exportDesignContext(cwd);

    assert.ok(result.bundlePath);
    const bundle = JSON.parse(await readFile(result.bundlePath, 'utf8'));
    assert.equal(bundle.designMd.trim(), '# Seed\n\nSome direction.\n'.trim());
    assert.equal(bundle.answers, null, 'no answers.json on disk preserves the absence as an explicit null, not an empty object that would import as a fully-answered questionnaire');
    assert.equal(bundle.files.length, 1);
  });

  it('still refuses when there is genuinely nothing to export', async () => {
    const cwd = await makeCwd();
    await assert.rejects(exportDesignContext(cwd), /No design interview found/);
  });
});

// Regression for PR #15 review thread: importing a bundle whose answers are
// null (no questionnaire on the source side) must not create answers.json
// on disk -- downstream `document.md` / `design-context.md` key off the
// file's existence to decide whether the questionnaire was answered.
describe('importDesignContext answers: null signal', () => {
  it('does not create answers.json when the bundle carries answers: null', async () => {
    const cwd = await makeCwd();
    await writeFileP(path.resolve(cwd, 'DESIGN.md'), '# Seed\n');
    const target = paths(cwd);
    await mkdirP(target.assetsDir, { recursive: true });
    await writeFileP(path.join(target.assetsDir, 'logo.svg'), '<svg></svg>');

    const bundle = {
      kind: 'impeccable-design-context',
      schemaVersion: 1,
      answers: null,
      context: { schemaVersion: 1 },
      files: [{ path: 'assets/logo.svg', base64: Buffer.from('<svg></svg>').toString('base64') }],
    };

    await importDesignContext(cwd, bundle);

    const answersPath = path.join(target.storeDir, 'answers.json');
    assert.equal(await stat(answersPath).then(() => true, () => false), false, 'answers.json must stay absent when the bundle has no questionnaire');
    assert.equal(await readAnswers(cwd).then((a) => a), null, 'readAnswers() must report null, not {}');
    // The rest of the import still ran -- the asset landed.
    const written = await readdir(target.assetsDir);
    assert.deepEqual(written, ['logo.svg']);
  });

  it('removes an existing answers.json on a forced import of a null-answer bundle', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(target.storeDir, { recursive: true });
    await writeFileP(target.answersJson, JSON.stringify({ 'palette-primary': '#OLD000' }));

    const bundle = {
      kind: 'impeccable-design-context',
      schemaVersion: 1,
      answers: null,
      context: { schemaVersion: 1 },
      files: [],
    };

    await importDesignContext(cwd, bundle, { force: true });

    assert.equal(await stat(target.answersJson).then(() => true, () => false), false,
      'a forced import of a null-answer bundle must remove the target\'s old questionnaire, not leave it in place');
  });

  it('writes answers.json when the bundle carries a non-null answers object', async () => {
    const cwd = await makeCwd();
    const bundle = {
      kind: 'impeccable-design-context',
      schemaVersion: 1,
      answers: { 'palette-primary': '#B8422E' },
      files: [],
    };

    await importDesignContext(cwd, bundle);

    const target = paths(cwd);
    const answersPath = path.join(target.storeDir, 'answers.json');
    assert.equal(await stat(answersPath).then(() => true, () => false), true, 'a non-null answers object must reach disk');
    assert.equal(await readAnswers(cwd).then((a) => a['palette-primary']), '#B8422E');
  });
});

describe('exportDesignContext per-surface table', () => {
  it('labels an unset surface preset instead of presenting it as a decision', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(target.storeDir, { recursive: true });
    await writeFileP(target.answersJson, JSON.stringify({
      'surface-modes': ['persuade', 'operate'],
      'color-strategy': 'restrained',
      'color-strategy-persuade': 'restrained',
      'color-strategy-operate': 'restrained',
      // Only the persuade surface's value was ever actually picked; operate's
      // matching value is the preset minted when that surface switched on.
      _chosen: JSON.stringify(['color-strategy-persuade']),
    }));

    const result = await exportDesignContext(cwd);
    const md = await readFile(result.markdownPath, 'utf8');

    assert.match(md, /\| color-strategy \| Landing page \(leads\) \| restrained \|/, 'the chosen surface reads as a plain answer');
    assert.match(md, /\| color-strategy \| Tool \(leads\) \| restrained \(preset, not chosen\) \|/, 'the unset surface reads as provisional, not a decision');
  });

  it('leaves every row unmarked when the bundle carries no _chosen at all (older or hand-built answers)', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(target.storeDir, { recursive: true });
    await writeFileP(target.answersJson, JSON.stringify({
      'surface-modes': ['persuade'],
      'color-strategy': 'restrained',
      'color-strategy-persuade': 'restrained',
    }));

    const result = await exportDesignContext(cwd);
    const md = await readFile(result.markdownPath, 'utf8');

    assert.doesNotMatch(md, /preset, not chosen/, 'unknown provenance must not be guessed as provisional');
  });

  it('leaves every row unmarked when _chosen is the JSON string "null" instead of an array', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(target.storeDir, { recursive: true });
    await writeFileP(target.answersJson, JSON.stringify({
      'surface-modes': ['persuade'],
      'color-strategy': 'restrained',
      'color-strategy-persuade': 'restrained',
      // Valid JSON, not an array: `new Set(JSON.parse('null'))` used to yield
      // an empty Set, which reads as "nothing was ever chosen".
      _chosen: 'null',
    }));

    const result = await exportDesignContext(cwd);
    const md = await readFile(result.markdownPath, 'utf8');

    assert.doesNotMatch(md, /preset, not chosen/, 'a null _chosen must read as unknown provenance, not as nothing chosen');
  });

  it('leaves every row unmarked when _chosen is a bare JSON string rather than an array', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(target.storeDir, { recursive: true });
    await writeFileP(target.answersJson, JSON.stringify({
      'surface-modes': ['persuade'],
      'color-strategy': 'restrained',
      'color-strategy-persuade': 'restrained',
      // Valid JSON, not an array: `new Set(JSON.parse('"color-strategy-persuade"'))`
      // used to iterate the string's characters as if they were field keys.
      _chosen: '"color-strategy-persuade"',
    }));

    const result = await exportDesignContext(cwd);
    const md = await readFile(result.markdownPath, 'utf8');

    assert.doesNotMatch(md, /preset, not chosen/, 'a string _chosen must read as unknown provenance, not as character-keyed choices');
  });
});

describe('exportDesignContext symlink handling', () => {
  it('skips a symlinked asset instead of embedding whatever it points at', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(target.assetsDir, { recursive: true });
    const secretFile = path.join(cwd, 'secret.txt');
    await writeFileP(secretFile, 'do not export me');
    const { symlink } = await import('node:fs/promises');
    await symlink(secretFile, path.join(target.assetsDir, 'logo.svg'));
    await writeFileP(path.resolve(cwd, 'DESIGN.md'), '# Seed\n');

    const result = await exportDesignContext(cwd);
    const bundle = JSON.parse(await readFile(result.bundlePath, 'utf8'));

    assert.equal(bundle.files.length, 0, 'the symlink must not be collected as a real file');
    assert.equal(bundle.skipped?.length, 1);
    assert.match(bundle.skipped[0].reason, /symlink/);
    const markdown = await readFile(result.markdownPath, 'utf8');
    assert.doesNotMatch(markdown, /do not export me/, 'the link target\'s bytes must never reach the readable export');
  });

  it('skips a symlinked assets/ directory itself instead of following readdir() through it', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(target.storeDir, { recursive: true });
    const outsideDir = path.join(path.dirname(cwd), `outside-assets-${path.basename(cwd)}`);
    await mkdirP(outsideDir, { recursive: true });
    await writeFileP(path.join(outsideDir, 'secret.txt'), 'do not export me');
    const { symlink } = await import('node:fs/promises');
    await symlink(outsideDir, target.assetsDir);
    await writeFileP(path.resolve(cwd, 'DESIGN.md'), '# Seed\n');

    const result = await exportDesignContext(cwd);
    const bundle = JSON.parse(await readFile(result.bundlePath, 'utf8'));

    assert.equal(bundle.files.length, 0, 'nothing from the linked directory may be collected');
    assert.ok(bundle.skipped?.some((s) => /symlink/.test(s.reason)));
    const markdown = await readFile(result.markdownPath, 'utf8');
    assert.doesNotMatch(markdown, /do not export me/);
  });

  it('refuses to export outright when an ancestor of the store is a symlink, before any managed-store read', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    const outsideDir = path.join(path.dirname(cwd), `outside-store-${path.basename(cwd)}`);
    const { symlink } = await import('node:fs/promises');
    await mkdirP(outsideDir, { recursive: true });
    // A different project's own answers.json, sitting at the link's target.
    // If buildBundle() read through the link before this check ran, its
    // content would leak into the exported bundle.
    await mkdirP(path.join(outsideDir, 'design-context'), { recursive: true });
    await writeFileP(path.join(outsideDir, 'design-context', 'answers.json'), JSON.stringify({ 'palette-primary': '#NOTOURS' }));
    await symlink(outsideDir, path.dirname(target.storeDir));
    await writeFileP(path.resolve(cwd, 'DESIGN.md'), '# Seed\n');

    await assert.rejects(exportDesignContext(cwd), /symlink/);
  });
});

describe('exportDesignContext file-count cap', () => {
  it('caps collected files at the same limit importDesignContext enforces, skipping the rest', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(target.assetsDir, { recursive: true });
    for (let i = 0; i < 513; i++) {
      await writeFileP(path.join(target.assetsDir, `file-${String(i).padStart(4, '0')}.png`), 'x');
    }
    await writeFileP(path.resolve(cwd, 'DESIGN.md'), '# Seed\n');

    const result = await exportDesignContext(cwd);
    const bundle = JSON.parse(await readFile(result.bundlePath, 'utf8'));

    assert.equal(bundle.files.length, 512, 'export must not produce more files than an import will accept');
    assert.equal(bundle.skipped?.length, 1);
    assert.match(bundle.skipped[0].reason, /512-file maximum/);
  });
});

describe('DESIGN.md symlink handling', () => {
  it('export skips a symlinked DESIGN.md instead of embedding whatever it points at', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(target.assetsDir, { recursive: true });
    await writeFileP(path.join(target.assetsDir, 'logo.svg'), '<svg></svg>');
    const secretFile = path.join(path.dirname(cwd), `secret-design-${path.basename(cwd)}.md`);
    await writeFileP(secretFile, '# Not this project\n\nSensitive content.\n');
    const { symlink } = await import('node:fs/promises');
    await symlink(secretFile, path.resolve(cwd, 'DESIGN.md'));

    const result = await exportDesignContext(cwd);
    const bundle = JSON.parse(await readFile(result.bundlePath, 'utf8'));

    assert.equal(bundle.designMd, null, 'the linked file\'s content must never be embedded');
    assert.ok(bundle.skipped?.some((s) => s.path === 'DESIGN.md' && /symlink/.test(s.reason)));
    const markdown = await readFile(result.markdownPath, 'utf8');
    assert.doesNotMatch(markdown, /Sensitive content/);
  });

  it('import with design: "write" refuses a pre-existing symlink at DESIGN.md instead of following it', async () => {
    const cwd = await makeCwd();
    const secretFile = path.join(path.dirname(cwd), `secret-design-import-${path.basename(cwd)}.md`);
    await writeFileP(secretFile, 'do not overwrite me');
    const { symlink } = await import('node:fs/promises');
    await symlink(secretFile, path.resolve(cwd, 'DESIGN.md'));

    const bundle = { ...bundleWithFiles([]), designMd: '# Imported\n\nNew direction.\n' };
    const result = await importDesignContext(cwd, bundle, { design: 'write' });

    assert.equal(result.designWritten, false, 'writing through the symlink must be refused');
    assert.equal(await readFile(secretFile, 'utf8'), 'do not overwrite me', 'the link target must be untouched');
  });

  it('import with design: "write" refuses a dangling symlink at DESIGN.md (regression: readFile()-as-existence-check missed this)', async () => {
    const cwd = await makeCwd();
    const danglingTarget = path.join(path.dirname(cwd), `dangling-design-${path.basename(cwd)}.md`);
    const { symlink } = await import('node:fs/promises');
    // The link's target does not exist, so a readFile()-based existence
    // probe fails the same way a missing DESIGN.md does, and the old code
    // then wrote through the link, creating the target at an
    // attacker-chosen path outside the project.
    await symlink(danglingTarget, path.resolve(cwd, 'DESIGN.md'));

    const bundle = { ...bundleWithFiles([]), designMd: '# Imported\n\nNew direction.\n' };
    const result = await importDesignContext(cwd, bundle, { design: 'write' });

    assert.equal(result.designWritten, false, 'writing through a dangling symlink must be refused');
    assert.equal(await stat(danglingTarget).then(() => true, () => false), false, 'nothing may be created at the link target');
  });
});
