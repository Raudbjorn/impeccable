import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, stat, readFile, writeFile as writeFileP, mkdir as mkdirP, rm, chmod } from 'node:fs/promises';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { importDesignContext, exportDesignContext } from '../skill/scripts/design-context/portability.mjs';
import { paths, readAnswers, writeJsonAtomic } from '../skill/scripts/design-context/store.mjs';

// Every project makeCwd() creates, plus every sibling "outside-*"
// directory or file the tests below plant next to it (path.join(path.
// dirname(cwd), ...)), used to land directly under the shared OS temp
// directory with nothing ever removing them -- across this suite's fixtures
// (including the 8-33 MiB size-cap ones), a run leaked tens of megabytes
// and hundreds of files. Nesting everything one level under a single
// sandbox root means a project's siblings land inside that same root too
// (dirname(cwd) is the root, not the shared OS temp dir), so one recursive
// removal after the whole suite catches all of it.
const sandboxRoot = await mkdtemp(path.join(tmpdir(), 'design-context-portability-sandbox-'));
after(() => rm(sandboxRoot, { recursive: true, force: true }));

async function makeCwd() {
  return mkdtemp(path.join(sandboxRoot, 'project-'));
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

  // Regression: a duplicate path collapsed silently into one entry in the
  // decoded map (last payload wins), but the write loop still iterated the
  // bundle's own raw file list and wrote that one payload once per
  // occurrence -- reporting `written` one higher per duplicate than the
  // number of files that actually landed on disk, and doing the redundant
  // write before any target mutation had a chance to check for this.
  it('rejects a bundle naming the same path more than once, before any target mutation', async () => {
    const cwd = await makeCwd();
    const bundle = bundleWithFiles([
      { path: 'assets/logo.svg', base64: Buffer.from('first').toString('base64') },
      { path: 'assets/logo.svg', base64: Buffer.from('second').toString('base64') },
    ]);

    await assert.rejects(importDesignContext(cwd, bundle), /name the same destination/);
    // No mutation must have landed: the duplicate is caught before any write.
    const target = paths(cwd);
    assert.equal(await stat(target.storeDir).then(() => true, () => false), false);
  });

  // Regression: the duplicate check compared paths exact-case only, but
  // Windows and default macOS filesystems fold case -- "assets/logo.svg" and
  // "assets/LOGO.svg" write to the same destination there even though they
  // are distinct keys in the decoded map. Two entries differing only in
  // case sailed past the check, the second silently overwrote the first on
  // disk, and `written` still counted both.
  it('rejects a bundle whose paths collide only once case is folded, before any target mutation', async () => {
    const cwd = await makeCwd();
    const bundle = bundleWithFiles([
      { path: 'assets/logo.svg', base64: Buffer.from('first').toString('base64') },
      { path: 'assets/LOGO.svg', base64: Buffer.from('second').toString('base64') },
    ]);

    await assert.rejects(importDesignContext(cwd, bundle), /name the same destination/);
    const target = paths(cwd);
    assert.equal(await stat(target.storeDir).then(() => true, () => false), false);
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

  // Regression: the prior canonical check stripped trailing "=" from both
  // sides before comparing, which validated round-trip equality but never
  // the padding itself -- excess or bare padding decoded identically
  // underneath the strip and passed as canonical.
  it('rejects excess padding ("YQ===") instead of accepting it as equivalent to correct padding', async () => {
    const cwd = await makeCwd();
    const bundle = bundleWithFiles([
      { path: 'assets/logo.svg', base64: 'YQ===' },
    ]);

    await assert.rejects(importDesignContext(cwd, bundle), /valid base64/);
  });

  it('rejects a payload of bare padding characters instead of silently importing an empty file', async () => {
    const cwd = await makeCwd();
    const bundle = bundleWithFiles([
      { path: 'assets/logo.svg', base64: '===' },
    ]);

    await assert.rejects(importDesignContext(cwd, bundle), /valid base64/);
  });

  it('still accepts correctly padded and unpadded-length base64', async () => {
    const cwd = await makeCwd();
    const bundle = bundleWithFiles([
      { path: 'assets/a.svg', base64: Buffer.from('a').toString('base64') }, // 1 byte -> padded
      { path: 'assets/abc.svg', base64: Buffer.from('abc').toString('base64') }, // 3 bytes -> no padding needed
    ]);

    const result = await importDesignContext(cwd, bundle);

    assert.equal(result.written, 2);
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

  it('replaces a pre-existing symlink at the destination instead of following it', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(target.assetsDir, { recursive: true });
    // Pre-existing link at the exact destination the bundle wants to write.
    const realOutside = path.join(cwd, '..', `secret-${path.basename(cwd)}.txt`);
    await writeFileP(realOutside, 'do not leak me');
    const { symlink, lstat } = await import('node:fs/promises');
    const destination = path.join(target.assetsDir, 'logo.svg');
    await symlink(realOutside, destination);

    const bundle = bundleWithFiles([
      { path: 'assets/logo.svg', base64: Buffer.from('payload').toString('base64') },
    ]);
    const result = await importDesignContext(cwd, bundle);

    // writeFileAtomic()'s rename() replaces the destination directory entry
    // rather than following it: the link is gone and the bundle bytes landed
    // at the leaf path itself.
    assert.equal(result.written, 1, 'the atomic write must replace the symlink, not skip past it');
    assert.equal((await lstat(destination)).isSymbolicLink(), false, 'the destination must no longer be a symlink');
    assert.equal(await readFile(destination, 'utf8'), 'payload');
    // The link's old target still holds the original secret, untouched.
    assert.equal(await readFile(realOutside, 'utf8'), 'do not leak me');
  });

  // Regression: a plain writeFile() truncates and rewrites the destination's
  // existing inode in place. If that inode also has another hard link
  // elsewhere in the filesystem, the bundle's bytes land there too -- an
  // attacker who can hard-link into assets/ before the import runs gets
  // their own file silently overwritten with whatever the bundle contains.
  // The atomic write must instead create a fresh inode and rename it over
  // the destination's directory entry, leaving every other link to the old
  // inode holding the old content.
  it('does not corrupt other hard links to the destination file', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(target.assetsDir, { recursive: true });
    const destination = path.join(target.assetsDir, 'logo.svg');
    const linkedElsewhere = path.join(path.dirname(cwd), `hardlinked-${path.basename(cwd)}.svg`);
    await writeFileP(destination, 'original shared content');
    const { link } = await import('node:fs/promises');
    await link(destination, linkedElsewhere);

    const bundle = bundleWithFiles([
      { path: 'assets/logo.svg', base64: Buffer.from('payload').toString('base64') },
    ]);
    const result = await importDesignContext(cwd, bundle);

    assert.equal(result.written, 1, 'the destination itself must still be written');
    assert.equal(await readFile(destination, 'utf8'), 'payload');
    assert.equal(await readFile(linkedElsewhere, 'utf8'), 'original shared content', 'the other hard link must not see the bundle bytes');
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

  // Regression: mkdir(path.dirname(absolute), {recursive:true}) ran outside
  // the write loop's try/catch. When assets/ (or fonts/) is itself a plain
  // file rather than a directory -- a shape hasManagedState() does not
  // detect, so a plain, non-forced import can reach this loop -- mkdir()
  // throws ENOTDIR uncaught, aborting the import after answers.json and
  // context.json for this same import have already landed.
  it('skips the whole assets/ entry instead of crashing with ENOTDIR when assets/ is a plain file', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(target.storeDir, { recursive: true });
    await writeFileP(target.assetsDir, 'not a directory'); // assets/ itself is a regular file

    const bundle = bundleWithFiles([
      { path: 'assets/logo.svg', base64: Buffer.from('payload').toString('base64') },
    ]);
    const result = await importDesignContext(cwd, bundle);

    assert.equal(result.written, 0, 'the entry under the blocked path must not be treated as written');
    assert.equal(await readFile(target.assetsDir, 'utf8'), 'not a directory', 'the file at assets/ must survive untouched');
    // The rest of the import still completed instead of throwing partway through.
    assert.equal(await readAnswers(cwd).then((a) => a['palette-primary']), '#B8422E');
  });

  // Regression: the write loop's catch block swallowed every error the same
  // way, including operational failures (permission denied, disk full, I/O
  // error) that are not one of the two documented destination shapes
  // (EISDIR, ENOTDIR). Reporting IMPORTED after a forced import had already
  // deleted the old store, with a write that actually failed for an
  // unrelated operational reason silently downgraded to a skip, left a
  // partial context that looked complete to the caller. Only the two
  // destination-shape codes should be swallowed; anything else must abort
  // the import.
  it('rethrows an operational write failure instead of silently skipping it', async (t) => {
    if (process.getuid?.() === 0) {
      t.skip('a read-only directory does not stop root from writing into it');
      return;
    }
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(target.assetsDir, { recursive: true });
    await chmod(target.assetsDir, 0o555); // read + execute, no write

    const bundle = bundleWithFiles([
      { path: 'assets/logo.svg', base64: Buffer.from('payload').toString('base64') },
    ]);

    try {
      await assert.rejects(importDesignContext(cwd, bundle), /EACCES/);
    } finally {
      await chmod(target.assetsDir, 0o755);
    }
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

  // Regression: hasManagedState() (design-context-import.mjs) already
  // treats an on-disk context.json alone as a real managed record -- the
  // shape left behind by importing an `answers: null` bundle with no files
  // and an unwritten DESIGN.md -- and blocks a plain re-import of such a
  // project. Without a matching allowance here, export disagreed and
  // refused to round-trip exactly that state back out.
  it('exports a project whose only retained state is context.json', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(target.storeDir, { recursive: true });
    await writeFileP(target.contextJson, JSON.stringify({ schemaVersion: 1, context: { product: { name: 'Retained' } } }));

    const result = await exportDesignContext(cwd);

    const bundle = JSON.parse(await readFile(result.bundlePath, 'utf8'));
    assert.equal(bundle.answers, null);
    assert.equal(bundle.context.context.product.name, 'Retained');
  });

  // Regression: design-context.md's own no-argument status routing (and
  // hasManagedState() in design-context-import.mjs) already treat an
  // on-disk cues.json or fonts.json alone as a real managed record and
  // offer/require exactly this state -- but buildBundle()'s non-empty check
  // never looked at either manifest, so export refused a project whose only
  // retained state was one of them, disagreeing with what the status
  // routing had just told the user to do.
  it('exports a project whose only retained state is the cue manifest (cues.json)', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(path.dirname(target.cuesJson), { recursive: true });
    const cuesManifest = { cues: ['warm-terracotta', 'cool-slate'], palette: { 'warm-terracotta': { primary: '#B8422E' } } };
    await writeFileP(target.cuesJson, JSON.stringify(cuesManifest));

    const result = await exportDesignContext(cwd);

    const bundle = JSON.parse(await readFile(result.bundlePath, 'utf8'));
    assert.equal(bundle.answers, null);
    // Regression: buildBundle() used to carry only `chosenCue` (derived from
    // cues.palette[answers['palette-source']]), which is null with no
    // answers -- exactly this shape -- so the export could not actually
    // reconstruct the manifest it claimed to have captured. The whole
    // manifest must ride along, not just the one dealt entry an answered
    // questionnaire would have picked.
    assert.deepEqual(bundle.cues, cuesManifest, 'the whole cues.json manifest must be carried, not just chosenCue');
  });

  it('round-trips the full cue manifest (deck included) through export and import into a fresh project', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(path.dirname(target.cuesJson), { recursive: true });
    const cuesManifest = {
      cues: ['warm-terracotta', 'cool-slate', 'sun-ochre'],
      palette: {
        'warm-terracotta': { primary: '#B8422E' },
        'cool-slate': { primary: '#3E4C5E' },
      },
    };
    await writeFileP(target.cuesJson, JSON.stringify(cuesManifest));

    const result = await exportDesignContext(cwd);
    const bundle = JSON.parse(await readFile(result.bundlePath, 'utf8'));

    const otherCwd = await makeCwd();
    await importDesignContext(otherCwd, bundle);

    const otherTarget = paths(otherCwd);
    const importedCues = JSON.parse(await readFile(otherTarget.cuesJson, 'utf8'));
    assert.deepEqual(importedCues, cuesManifest, 'the imported project must end up with the exact source manifest, deck included, not the empty default');
  });

  it('exports a project whose only retained state is the font manifest (fonts.json)', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(path.dirname(target.fontsManifestJson), { recursive: true });
    await writeFileP(target.fontsManifestJson, JSON.stringify({ heading: 'Inter', body: 'Inter' }));

    const result = await exportDesignContext(cwd);

    const bundle = JSON.parse(await readFile(result.bundlePath, 'utf8'));
    assert.equal(bundle.answers, null);
    assert.deepEqual(bundle.fonts, { heading: 'Inter', body: 'Inter' });
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

  // Coverage for openRegularFileNoFollow()'s replacement of a separate
  // lstat(path)-then-readFile(path) pair (which left a window for a symlink
  // swapped in between the two to be followed regardless of what the lstat
  // saw -- not itself reproducible in a deterministic test, since it needs
  // an exact race between two syscalls with no exposed yield point).
  // Collecting files now opens with O_NOFOLLOW and reads through that same
  // handle. A dangling symlink (target does not exist) confirms the new
  // path handles that shape too: O_NOFOLLOW refuses to open a symlink
  // outright (ELOOP) regardless of whether its target exists, so this
  // passes on both the old lstat-based check and the new one -- it is not
  // a regression test for the TOCTOU fix itself, only for this edge case.
  it('skips a dangling symlinked asset instead of throwing', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(target.assetsDir, { recursive: true });
    const danglingTarget = path.join(path.dirname(cwd), `dangling-asset-${path.basename(cwd)}.svg`);
    const { symlink } = await import('node:fs/promises');
    await symlink(danglingTarget, path.join(target.assetsDir, 'logo.svg'));
    await writeFileP(path.resolve(cwd, 'DESIGN.md'), '# Seed\n');

    const result = await exportDesignContext(cwd);
    const bundle = JSON.parse(await readFile(result.bundlePath, 'utf8'));

    assert.equal(bundle.files.length, 0, 'a dangling symlink must not be collected as a real file');
    assert.ok(bundle.skipped?.some((s) => s.path === 'assets/logo.svg' && /symlink/.test(s.reason)));
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

  // Regression: the ancestor-only check above walks storeDir/the workspace
  // dir, which does not cover a managed JSON file *itself* being a symlink
  // when its containing directory is a genuine directory. readAnswers()
  // would follow such a link the same as any other read.
  it('refuses to export outright when answers.json itself (not its directory) is a symlink', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(target.storeDir, { recursive: true });
    const secretFile = path.join(path.dirname(cwd), `secret-answers-${path.basename(cwd)}.json`);
    await writeFileP(secretFile, JSON.stringify({ 'palette-primary': '#NOTOURS' }));
    const { symlink } = await import('node:fs/promises');
    await symlink(secretFile, target.answersJson);
    await writeFileP(path.resolve(cwd, 'DESIGN.md'), '# Seed\n');

    await assert.rejects(exportDesignContext(cwd), /symlink/);
  });

  // Regression: the managed-input checks above cover what buildBundle()
  // reads; they say nothing about the output directory. mkdir() and both
  // writes would otherwise follow a pre-existing symlink at the default
  // exports/ path and place the export outside the project.
  it('refuses to export outright when the default exports/ destination is a symlink', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(target.storeDir, { recursive: true });
    await writeFileP(target.answersJson, JSON.stringify({ 'palette-primary': '#B8422E' }));
    const outsideDir = path.join(path.dirname(cwd), `outside-exports-${path.basename(cwd)}`);
    const { symlink } = await import('node:fs/promises');
    await mkdirP(outsideDir, { recursive: true });
    await symlink(outsideDir, target.exportsDir);

    await assert.rejects(exportDesignContext(cwd), /symlink/);

    const outsideContents = await readdir(outsideDir).catch(() => []);
    assert.equal(outsideContents.length, 0, 'nothing must have been written through the symlinked destination');
  });

  it('refuses to export outright when an explicit --out inside the project is a symlink', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(target.storeDir, { recursive: true });
    await writeFileP(target.answersJson, JSON.stringify({ 'palette-primary': '#B8422E' }));
    const outsideDir = path.join(path.dirname(cwd), `outside-custom-out-${path.basename(cwd)}`);
    const { symlink } = await import('node:fs/promises');
    await mkdirP(outsideDir, { recursive: true });
    await symlink(outsideDir, path.join(cwd, 'custom-out'));

    await assert.rejects(exportDesignContext(cwd, { outDir: 'custom-out' }), /symlink/);
  });

  // Regression: symlinkedAncestor() used a bare `relative.startsWith('..')`
  // to decide a resolved path lies outside cwd (and so skip the walk
  // entirely). That also matches an in-project name that merely begins with
  // two dots -- "..sneaky" resolves inside cwd, same as "sneaky" would --
  // wrongly waving through the one destination a pre-existing symlink named
  // that way most needs checked.
  it('refuses to export outright when an explicit --out named with a leading ".." (but still inside the project) is a symlink', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(target.storeDir, { recursive: true });
    await writeFileP(target.answersJson, JSON.stringify({ 'palette-primary': '#B8422E' }));
    const outsideDir = path.join(path.dirname(cwd), `outside-dotdot-out-${path.basename(cwd)}`);
    const { symlink } = await import('node:fs/promises');
    await mkdirP(outsideDir, { recursive: true });
    await symlink(outsideDir, path.join(cwd, '..sneaky'));

    await assert.rejects(exportDesignContext(cwd, { outDir: '..sneaky' }), /symlink/);

    const outsideContents = await readdir(outsideDir).catch(() => []);
    assert.equal(outsideContents.length, 0, 'nothing must have been written through the symlinked ..-prefixed name');
  });

  // Regression: the destination check above only covers directory
  // components; a pre-existing design-context.md symlink at the leaf was
  // still followed by a plain writeFile(), overwriting its external target.
  // writeFileAtomic() (rename() onto the leaf, not writeFile() through it)
  // fixes this by succeeding safely rather than by refusing: the export
  // completes, and the symlink entry is replaced with a real file instead
  // of being followed.
  it('writes design-context.md safely instead of following a pre-existing symlink at that exact leaf path', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(target.storeDir, { recursive: true });
    await writeFileP(target.answersJson, JSON.stringify({ 'palette-primary': '#B8422E' }));
    const secretFile = path.join(path.dirname(cwd), `secret-design-context-${path.basename(cwd)}.md`);
    await writeFileP(secretFile, 'do not overwrite me');
    await mkdirP(target.exportsDir, { recursive: true });
    const { symlink, lstat: lstatP } = await import('node:fs/promises');
    const markdownPath = path.join(target.exportsDir, 'design-context.md');
    await symlink(secretFile, markdownPath);

    const result = await exportDesignContext(cwd);

    assert.equal(await readFile(secretFile, 'utf8'), 'do not overwrite me', 'the link target must be untouched');
    assert.ok((await lstatP(result.markdownPath)).isFile(), 'design-context.md must end up a real file, not the symlink');
    assert.match(await readFile(result.markdownPath, 'utf8'), /Design context/);
  });
});

describe('exportDesignContext bundle size cap', () => {
  it('refuses to write an export whose serialized bundle exceeds the documented import cap', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(target.storeDir, { recursive: true });
    await writeFileP(target.answersJson, JSON.stringify({ 'palette-primary': '#B8422E' }));
    // designMd is not bounded by MAX_FILE_BYTES/MAX_BUNDLE_BYTES at all --
    // exactly the gap this cap closes.
    await writeFileP(path.resolve(cwd, 'DESIGN.md'), '#'.repeat(33 * 1024 * 1024));

    await assert.rejects(exportDesignContext(cwd), /bundles this release can import back in are capped/);
    const bundlePath = path.join(target.exportsDir, 'design-context.bundle.json');
    assert.equal(await stat(bundlePath).then(() => true, () => false), false, 'no oversized bundle may be written');
  });

  it('still exports a bundle comfortably under the cap', async () => {
    const cwd = await makeCwd();
    const target = paths(cwd);
    await mkdirP(target.storeDir, { recursive: true });
    await writeFileP(target.answersJson, JSON.stringify({ 'palette-primary': '#B8422E' }));
    await writeFileP(path.resolve(cwd, 'DESIGN.md'), '# Seed\n');

    const result = await exportDesignContext(cwd);

    assert.equal(await stat(result.bundlePath).then(() => true, () => false), true);
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

  // Regression: open(designPath, 'wx') already creates the file; a write
  // failure past that point (ENOSPC, EFBIG) left the partial file in place
  // while the error still propagated. A retry's own 'wx' open then hit
  // EEXIST against that partial file and silently skipped writing DESIGN.md
  // forever, instead of retrying it. Forcing a real write-time failure
  // needs a real OS limit (see the EFBIG-under-`ulimit -f` writeFileAtomic
  // test above for why): run as a child process since the limit is set
  // per-process and Node has no API to lower its own after starting.
  it('cleans up a partial DESIGN.md when the write itself fails, so a retry does not see a permanent EEXIST', () => {
    if (process.platform === 'win32') return; // ulimit -f is POSIX-only
    const cwd = mkdtempSync(path.join(sandboxRoot, 'design-context-designmd-efbig-'));
    const portabilityModuleUrl = pathToFileURL(path.resolve('skill/scripts/design-context/portability.mjs')).href;
    const scriptPath = path.join(cwd, 'probe.mjs');
    writeFileSync(scriptPath, [
      `import { importDesignContext } from '${portabilityModuleUrl}';`,
      `import fs from 'node:fs';`,
      `import path from 'node:path';`,
      `const dir = process.env.TARGET_DIR;`,
      `const bundle = { kind: 'impeccable-design-context', schemaVersion: 1, answers: null, files: [], designMd: 'x'.repeat(5 * 1024 * 1024) };`,
      `try {`,
      `  await importDesignContext(dir, bundle, { design: 'write' });`,
      `  console.log('WROTE');`,
      `} catch (error) {`,
      `  console.log('THREW:' + (error.code || error.message));`,
      `}`,
      `console.log('DESIGN_MD_EXISTS:' + fs.existsSync(path.join(dir, 'DESIGN.md')));`,
    ].join('\n'));

    const result = spawnSync('bash', ['-c', `ulimit -f 1; node ${scriptPath}`], {
      encoding: 'utf8',
      env: { ...process.env, TARGET_DIR: cwd },
    });
    if (result.error) return; // bash/ulimit unavailable in this environment; nothing to assert

    assert.match(result.stdout, /THREW:EFBIG/, `expected an EFBIG failure mid-write; got stdout=${result.stdout} stderr=${result.stderr}`);
    assert.match(result.stdout, /DESIGN_MD_EXISTS:false/, 'the partial DESIGN.md must not survive a failed write, or a retry would see a permanent EEXIST');
  });

  // Regression: the lstat()-then-writeFile() this replaced left a gap
  // between the check and the write for another process to create or swap
  // in a symlink at DESIGN.md in between; writeFile() would then follow it.
  // The exclusive open('wx') makes the create itself the check, so there is
  // no separate window to race -- but that also means an ordinary,
  // already-there DESIGN.md (the common case: a project that already has
  // one) must still be left untouched rather than EEXIST turning into an
  // uncaught throw.
  it('leaves an ordinary pre-existing DESIGN.md untouched instead of throwing on EEXIST', async () => {
    const cwd = await makeCwd();
    await writeFileP(path.resolve(cwd, 'DESIGN.md'), '# Original\n\nKeep me.\n');

    const bundle = { ...bundleWithFiles([]), designMd: '# Imported\n\nNew direction.\n' };
    const result = await importDesignContext(cwd, bundle, { design: 'write' });

    assert.equal(result.designWritten, false, 'an existing DESIGN.md must not be overwritten by import');
    assert.equal(await readFile(path.resolve(cwd, 'DESIGN.md'), 'utf8'), '# Original\n\nKeep me.\n');
  });
});

describe('writeJsonAtomic', () => {
  // Regression: the random temp-file suffix (added to defeat a pre-placed
  // symlink at a predictable name) means a failed rename() no longer
  // collides with and gets reused by the next attempt the way the old
  // fixed `${filePath}.tmp` name did -- every failed call now leaves a new
  // orphaned temp file behind unless cleaned up explicitly.
  it('cleans up its temp file when rename() fails, instead of leaking a new orphan per attempt', async () => {
    const cwd = await makeCwd();
    const target = path.join(cwd, 'blocked');
    await mkdirP(target, { recursive: true }); // a directory sits where the write wants to land a file

    await assert.rejects(writeJsonAtomic(target, { hello: 'world' }));

    const leftover = (await readdir(cwd)).filter((name) => name !== path.basename(target));
    assert.deepEqual(leftover, [], 'no temp file may remain after a failed rename');
  });

  // Regression: writeFile(temporary, content, {flag:'wx'}) folds creating
  // the temp file and writing its content into one call, wrapped in no
  // try/catch of its own -- only the later rename() had one. A failure
  // partway through that write (the file already exists on disk; content
  // is still only partly flushed) propagated with no cleanup attempted at
  // all. open(temporary, 'wx') separates creation from the write: ownership
  // is established the instant open() resolves, before the write is
  // attempted, so a write-time failure (not just a later rename() failure)
  // now gets cleaned up too.
  //
  // A thrown-content-type error doesn't reach this: Node validates the
  // `data` argument before touching the filesystem, for both the old
  // single-call form and the new open()-then-write() form alike, so
  // nothing is ever created to leak in that case. Forcing a real write-time
  // failure needs a real OS limit: `ulimit -f` caps the process's max file
  // size, so writing content past it fails with EFBIG only after the file
  // already exists -- exactly the gap the old code left uncovered. Run as a
  // child process because the limit is set per-process and Node has no API
  // to lower its own after starting.
  it('cleans up its temp file when the write itself fails (EFBIG under ulimit -f), not only when rename() fails', async () => {
    if (process.platform === 'win32') return; // ulimit -f is POSIX-only
    const dir = await mkdtemp(path.join(sandboxRoot, 'efbig-'));
    const storeModuleUrl = pathToFileURL(path.resolve('skill/scripts/design-context/store.mjs')).href;
    const scriptPath = path.join(dir, 'probe.mjs');
    await writeFileP(scriptPath, [
      `import { writeFileAtomic } from '${storeModuleUrl}';`,
      `import fs from 'node:fs';`,
      `import path from 'node:path';`,
      `const dir = process.env.TARGET_DIR;`,
      `const target = path.join(dir, 'out.json');`,
      `try {`,
      `  await writeFileAtomic(target, 'x'.repeat(5 * 1024 * 1024));`,
      `  console.log('WROTE');`,
      `} catch (error) {`,
      `  console.log('THREW:' + (error.code || error.message));`,
      `}`,
      `console.log('LEFTOVER:' + JSON.stringify(fs.readdirSync(dir).filter((name) => name.includes('.tmp'))));`,
    ].join('\n'));

    const result = spawnSync('bash', ['-c', `ulimit -f 1; node ${scriptPath}`], {
      encoding: 'utf8',
      env: { ...process.env, TARGET_DIR: dir },
    });
    if (result.error) return; // bash/ulimit unavailable in this environment; nothing to assert

    assert.match(result.stdout, /THREW:EFBIG/, `expected an EFBIG failure mid-write; got stdout=${result.stdout} stderr=${result.stderr}`);
    assert.match(result.stdout, /LEFTOVER:\[\]/, 'no temp file may remain after a write that fails partway through');
  });
});
