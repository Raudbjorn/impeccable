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
    await assert.rejects(stat(path.resolve(cwd, '../outside.txt')));
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
});
