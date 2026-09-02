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
    assert.deepEqual(bundle.answers, {}, 'no answers.json on disk still yields a valid empty answers object');
    assert.equal(bundle.files.length, 1);
  });

  it('still refuses when there is genuinely nothing to export', async () => {
    const cwd = await makeCwd();
    await assert.rejects(exportDesignContext(cwd), /No design interview found/);
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
