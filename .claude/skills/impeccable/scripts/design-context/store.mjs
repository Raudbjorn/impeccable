/** The design-context store: the one place that knows where design context lives.
 *
 * Layout, under the project root:
 *
 *   .impeccable/design-context/
 *     context.json    { schemaVersion, modes, context }  the chat half of the interview
 *     answers.json    the questionnaire submission, flat FormData shape
 *     assets/         brand files the user supplied
 *     fonts/          font faces the user uploaded
 *     cue.png         the chosen hero, copied at submit so the document stands alone
 *     runtime/        session.json, journal.jsonl, draft.json  (gitignored)
 *     exports/        design-context.md, design-context.bundle.json  (gitignored)
 *
 * Two rules hold this together. Every write goes through writeJsonAtomic, so a
 * reader never sees a torn file. Every read comes off disk, so no process ever
 * answers from a copy the file has moved past.
 *
 * Zero dependencies beyond node: builtins.
 */

import fs from 'node:fs';
import { readFile, mkdir, open, rename, rm, lstat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const STORE_DIR = '.impeccable/design-context';
const WORKSPACE_DIR = '.impeccable/visual-cues';
/* The shape of context.json. Bump only when the shape changes, never for a release. */
export const SCHEMA_VERSION = 1;

const LEGACY_DIR = '.impeccable/design-interview';
const LEGACY_FONTS_PREFIX = `${LEGACY_DIR}/fonts/`;

export function paths(cwd = process.cwd()) {
  const store = path.resolve(cwd, STORE_DIR);
  const runtime = path.join(store, 'runtime');
  return {
    storeDir: store,
    contextJson: path.join(store, 'context.json'),
    answersJson: path.join(store, 'answers.json'),
    assetsDir: path.join(store, 'assets'),
    fontsDir: path.join(store, 'fonts'),
    cuePng: path.join(store, 'cue.png'),
    runtimeDir: runtime,
    sessionJson: path.join(runtime, 'session.json'),
    journalJsonl: path.join(runtime, 'journal.jsonl'),
    draftJson: path.join(runtime, 'draft.json'),
    exportsDir: path.join(store, 'exports'),
    cuesJson: path.resolve(cwd, WORKSPACE_DIR, 'cues.json'),
    fontsManifestJson: path.resolve(cwd, WORKSPACE_DIR, 'fonts.json'),
  };
}

/** The project-relative path an uploaded font is reported by, and stored under. */
export function fontRelativePath(name) {
  return path.join(STORE_DIR, 'fonts', name);
}

/** Every path migrate() reads from or moves out of. Exposed so a caller can
    guard them for symlinks before migrate() ever runs, the same way
    paths() exposes the current store's destinations: a symlinked legacy
    source would let migrate() read or move content from outside the
    project into the store, the mirror image of a symlinked destination
    moving content out. */
export function legacyPaths(cwd = process.cwd()) {
  const dir = path.resolve(cwd, LEGACY_DIR);
  return {
    legacyDir: dir,
    answersJson: path.join(dir, 'answers.json'),
    journalJsonl: path.join(dir, 'doc-edits.jsonl'),
    sessionJson: path.join(dir, 'doc-session.json'),
    assetsDir: path.join(dir, 'assets'),
    fontsDir: path.join(dir, 'fonts'),
  };
}

/* Checking only the leaf (filePath itself, or its immediate directory) misses
   a symlinked ancestor: if `.impeccable` or `design-context` is itself a
   link, every path resolved under it goes through that link, and lstat() on
   a leaf that does not exist yet inside the link's target reports ENOENT
   with no hint the link was ever there. Walk from `boundary` down to
   `targetPath`, checking every existing path component, and stop (nothing
   to report) as soon as one is missing, since nothing deeper can exist
   without it. Returns the first offending absolute path, or null. Exported
   so portability.mjs's export/import symlink guards share this exact walk
   instead of keeping a second copy in sync by hand. */
export async function symlinkedAncestor(targetPath, boundary) {
  const boundaryAbs = path.resolve(boundary);
  const resolved = path.resolve(targetPath);
  const relative = path.relative(boundaryAbs, resolved);
  // A bare `.startsWith('..')` also matches an in-project name that merely
  // begins with those two characters ("..exports" resolves inside boundary,
  // same as "exports" would); only an exact ".." or a "../" prefix means
  // resolved actually lies outside boundary.
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)) return null;
  let cursor = boundaryAbs;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    let stat;
    try {
      stat = await lstat(cursor);
    } catch {
      return null;
    }
    if (stat.isSymbolicLink()) return cursor;
  }
  return null;
}

export async function assertNoneSymlinked(boundary, candidatePaths) {
  for (const candidate of candidatePaths) {
    const linked = await symlinkedAncestor(candidate, boundary);
    if (linked) {
      throw new Error(`${path.relative(path.resolve(boundary), linked)} is a symlink; refusing to operate through it.`);
    }
  }
}

/* Writes `content` to `filePath` without ever writing through a pre-existing
   symlink at that path: a plain writeFile() follows a leaf symlink the same
   as any other write, silently overwriting whatever it points to outside
   the project. rename(), unlike writeFile(), replaces the directory entry
   at its destination rather than following a symlink there, so writing to
   an unpredictable sibling temp first and renaming it onto filePath keeps
   that guarantee for the final write too. Shared by writeJsonAtomic()
   below and by the readable markdown export, which used to write straight
   through writeFile() and had none of this.
   The leaf guarantee above says nothing about a symlinked *ancestor*:
   mkdir(recursive), open(), and rename() all resolve `filePath`'s parent
   directories the same way any path lookup does, following a symlinked
   `.impeccable` or `design-context` the same as a real one -- so an
   ordinary writeContext()/writeAnswers()/writeDraft() call could still
   write outside the project despite the leaf-only guarantee. Checked
   against `cwd` (the project boundary every caller already resolves
   filePath from) before any of those calls run. Like the leaf-only
   TOCTOU noted in portability.mjs, a swap timed between this check and the
   write immediately after it is not closed -- Node's fs/promises has no
   openat-style primitive to bind the check and the write to the same
   resolved parent -- but the common case (a symlink already in place, not
   one raced into existence mid-call) is. */
export async function writeFileAtomic(filePath, content, cwd = process.cwd()) {
  await assertNoneSymlinked(cwd, [path.dirname(filePath)]);
  await mkdir(path.dirname(filePath), { recursive: true });
  // A predictable `${filePath}.tmp` name let a pre-placed symlink there
  // redirect this write outside the project. An unguessable suffix means
  // no symlink can be pre-placed at the exact path this call will use, and
  // the exclusive open below refuses one on the rare chance a name
  // collides anyway.
  const temporary = `${filePath}.${randomBytes(8).toString('hex')}.tmp`;
  // The exclusive open ('wx': O_CREAT|O_EXCL) is what actually creates
  // `temporary`, so ownership is established the instant it resolves --
  // before the write below. Writing via writeFile(temporary, content,
  // {flag:'wx'}) instead (as this used to) folds the create and the write
  // into one call: a failure partway through the write (ENOSPC, say) still
  // leaves the file it already created on disk, but with no distinct point
  // between "created" and "written" to hang cleanup off of, so that file
  // leaked. Opening first separates the two, so cleanup below covers a
  // failure at either step, not only a failed rename().
  const handle = await open(temporary, 'wx');
  let renamed = false;
  try {
    await handle.writeFile(content);
    await handle.close();
    await rename(temporary, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      // Reaches here whether the write, the close, or the rename failed;
      // closing again when the write path already closed successfully is
      // harmless (Node rejects a double close, swallowed here).
      await handle.close().catch(() => {});
      // Unlike the old fixed `${filePath}.tmp` name, a random suffix means
      // a failure here leaves behind a temp file no later call will ever
      // collide with or reuse -- repeated failures would otherwise
      // accumulate a new orphan every time instead of the single stray
      // file the old name bounded.
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}

export async function writeJsonAtomic(filePath, value, cwd = process.cwd()) {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, cwd);
}

export async function readJsonSoft(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export const readContext = (cwd = process.cwd()) => readJsonSoft(paths(cwd).contextJson);
export const writeContext = (value, cwd = process.cwd()) => writeJsonAtomic(paths(cwd).contextJson, value, cwd);
export const readAnswers = (cwd = process.cwd()) => readJsonSoft(paths(cwd).answersJson);
export const writeAnswers = (value, cwd = process.cwd()) => writeJsonAtomic(paths(cwd).answersJson, value, cwd);
export const readDraft = (cwd = process.cwd()) => readJsonSoft(paths(cwd).draftJson);
export const writeDraft = (value, cwd = process.cwd()) => writeJsonAtomic(paths(cwd).draftJson, value, cwd);
export const clearDraft = (cwd = process.cwd()) => rm(paths(cwd).draftJson, { force: true }).catch(() => {});

/* ============================================================
   The journal: append-only, replayed on every read.
   ============================================================ */

/** Append one event, stamped with the next seq and a timestamp. Returns the seq. */
export function appendJournal(event, cwd = process.cwd()) {
  const { runtimeDir, journalJsonl } = paths(cwd);
  const seq = replayJournal(cwd).lastSeq + 1;
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.appendFileSync(journalJsonl, `${JSON.stringify({ seq, ts: new Date().toISOString(), ...event })}\n`);
  return seq;
}

/**
 * Fold the journal into the state a booting session needs.
 *
 * Lines the fold cannot use are collected rather than thrown: a legacy
 * doc-edits.jsonl record carries { at, type: 'color' } and no seq, and a torn
 * final line is possible after a hard kill. Neither can move lastSeq or
 * resurrect a batch, so both are diagnostics, not failures.
 */
export function replayJournal(cwd = process.cwd()) {
  const { journalJsonl } = paths(cwd);
  const state = { lastSeq: 0, pendingBatch: null, entries: [], diagnostics: [] };

  let raw;
  try {
    raw = fs.readFileSync(journalJsonl, 'utf8');
  } catch {
    return state;
  }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      state.diagnostics.push({ reason: 'unparseable', line: line.slice(0, 200) });
      continue;
    }
    if (!entry || typeof entry !== 'object' || !Number.isInteger(entry.seq)) {
      state.diagnostics.push({ reason: 'legacy-or-unsequenced', type: entry?.type || null });
      continue;
    }
    state.entries.push(entry);
    if (entry.seq > state.lastSeq) state.lastSeq = entry.seq;
    if (entry.type === 'batch') {
      state.pendingBatch = entry.status === 'pending' ? entry : null;
    }
  }
  return state;
}

/* ============================================================
   Migration from the pre-store layout.
   ============================================================ */

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    /* EPERM means the process exists and is not ours to signal. */
    return error.code === 'EPERM';
  }
}

async function moveFile(from, to) {
  if (fs.existsSync(to) || !fs.existsSync(from)) return false;
  await mkdir(path.dirname(to), { recursive: true });
  await rename(from, to);
  return true;
}

/* Directories move child by child: renaming onto an existing directory fails,
   and a run interrupted halfway leaves a destination that already exists. */
async function moveDirContents(fromDir, toDir) {
  if (!fs.existsSync(fromDir)) return;
  await mkdir(toDir, { recursive: true });
  for (const name of fs.readdirSync(fromDir)) {
    await moveFile(path.join(fromDir, name), path.join(toDir, name));
  }
  try {
    if (fs.readdirSync(fromDir).length === 0) fs.rmdirSync(fromDir);
  } catch {
    /* Something arrived between the read and the remove; leaving it is safe. */
  }
}

/** Uploaded-face paths were recorded as strings inside the answers themselves. */
function rewriteFontSources(answers) {
  if (!answers || typeof answers !== 'object') return null;
  let touched = false;
  for (const [key, value] of Object.entries(answers)) {
    if (typeof value !== 'string' || !value.includes(LEGACY_FONTS_PREFIX)) continue;
    answers[key] = value.split(LEGACY_FONTS_PREFIX).join(`${STORE_DIR}/fonts/`);
    touched = true;
  }
  return touched ? answers : null;
}

/**
 * Bring a pre-store project onto the current layout. Idempotent and silent:
 * a project that is already current, or was never interviewed, does nothing.
 *
 * A live session of the old shape holds the old paths in its own constants, so
 * migrating under it would strand its writes. That case defers to the next boot.
 */
export async function migrate(cwd = process.cwd()) {
  const legacyDir = path.resolve(cwd, LEGACY_DIR);
  if (!fs.existsSync(legacyDir)) {
    await migrateContextFromCues(cwd);
    return { migrated: false, deferred: false };
  }

  const legacySession = path.join(legacyDir, 'doc-session.json');
  const session = await readJsonSoft(legacySession);
  if (session && pidAlive(session.pid)) return { migrated: false, deferred: true };

  const target = paths(cwd);
  await moveFile(path.join(legacyDir, 'answers.json'), target.answersJson);
  await moveFile(path.join(legacyDir, 'doc-edits.jsonl'), target.journalJsonl);
  await moveDirContents(path.join(legacyDir, 'assets'), target.assetsDir);
  await moveDirContents(path.join(legacyDir, 'fonts'), target.fontsDir);

  const answers = await readJsonSoft(target.answersJson);
  const rewritten = rewriteFontSources(answers);
  if (rewritten) await writeJsonAtomic(target.answersJson, rewritten, cwd);

  await rm(legacySession, { force: true }).catch(() => {});
  try {
    if (fs.readdirSync(legacyDir).length === 0) fs.rmdirSync(legacyDir);
  } catch {
    /* Files the migration does not own stay where they are. */
  }

  await migrateContextFromCues(cwd);
  return { migrated: true, deferred: false };
}

/* The chat half of the interview used to ride inside the cue manifest. It is
   not a generation artifact, so it moves to the store; cues.json keeps its
   cues and palette and is left untouched. */
async function migrateContextFromCues(cwd) {
  const target = paths(cwd);
  if (fs.existsSync(target.contextJson)) return;
  const cues = await readJsonSoft(target.cuesJson);
  if (!cues) return;
  const hasModes = Array.isArray(cues.modes);
  const hasContext = cues.context && typeof cues.context === 'object';
  if (!hasModes && !hasContext) return;
  await writeJsonAtomic(target.contextJson, {
    schemaVersion: SCHEMA_VERSION,
    ...(hasModes ? { modes: cues.modes } : {}),
    ...(hasContext ? { context: cues.context } : {}),
  }, cwd);
}
