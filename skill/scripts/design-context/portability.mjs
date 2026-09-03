/** Taking a design context out of a project, and putting one into another.
 *
 * Two shapes, because they answer different questions. `design-context.md` is
 * for a reader, human or otherwise: one document that says what was decided
 * and why, which can be handed to another tool as the rules to follow. The
 * bundle is for this toolchain: everything needed to rebuild the store
 * somewhere else, including the bytes of the files the user supplied.
 *
 * The bundle carries the schema version, not the store. A store file's era is
 * readable from its own keys, and stamping the browser's submission would mean
 * rewriting what it sent.
 */

import { mkdir, readdir, rm, lstat, stat, open, constants } from 'node:fs/promises';
import path from 'node:path';
import {
  paths,
  legacyPaths,
  readJsonSoft,
  writeAnswers,
  writeContext,
  writeFileAtomic,
  writeJsonAtomic,
  SCHEMA_VERSION,
} from './store.mjs';

const BUNDLE_KIND = 'impeccable-design-context';
const BUNDLE_SCHEMA = 1;

/* Generated cue PNGs run a few megabytes, so the per-file cap must clear
   them; MAX_BUNDLE_BYTES still bounds the whole. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;
/* An export never produces more than assets + fonts + cue.png, so a bundle
   naming more than this is not something this toolchain wrote. */
const MAX_BUNDLE_FILES = 512;
/* The decoded-byte checks below only bound file payloads at allowed paths;
   they say nothing about the serialized bundle as a whole -- base64 alone
   inflates MAX_BUNDLE_BYTES by ~4/3, and designMd/answers/context are not
   bounded at all. A caller reading a bundle from disk (design-context-
   import.mjs) checks the file's own size against this before reading or
   parsing it, so an untrusted bundle cannot exhaust memory before any of
   the per-entry checks below ever run. */
export const MAX_BUNDLE_FILE_BYTES = 32 * 1024 * 1024;

const MIME = new Map([
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.gif', 'image/gif'],
  ['.woff2', 'font/woff2'], ['.woff', 'font/woff'], ['.ttf', 'font/ttf'], ['.otf', 'font/otf'],
]);

/* Exactly the three places an export puts bytes, and so exactly the three an
   import will write them back to. Anything else in a bundle is not ours.
   The negative lookahead excludes a bare "." or ".." as the file segment:
   without it, "assets/.." matches assets/[^/]+ (".." has no slash in it),
   resolves to the assets directory's parent, and writeFile() on a directory
   throws EISDIR instead of hitting the containment check below at all.
   The segment also excludes a literal backslash: on Windows, path.resolve
   treats "\" as a separator too, so "assets/..\answers.json" (no forward
   slash, so [^/]+ alone accepts it whole) resolves to the store's own
   answers.json, and the containment check below allows it right back in
   because that stays inside storeDir -- a bundle overwriting the record
   it was meant to only add to. No legitimate exported filename (see the
   MIME extension list above) ever contains a backslash or a NUL byte: a NUL
   passes this check without it, then survives the containment walk (whose
   lstat() calls swallow its ENOENT-shaped rejection into "nothing to check"),
   and reaches writeFile(), which throws synchronously and uncaught -- after
   a forced import has already cleared the target's existing store. */
const ALLOWED_FILE = /^(assets\/(?!\.{1,2}$)[^/\\\0]+|fonts\/(?!\.{1,2}$)[^/\\\0]+|cue\.png)$/;

const SURFACE_LABELS = { persuade: 'Landing page', operate: 'Tool', read: 'Docs', experience: 'Portfolio' };
const ROLES = ['primary', 'secondary', 'tertiary', 'neutral'];
const PER_SURFACE = ['color-strategy', 'boundary-style', 'corner-style', 'depth-style', 'motion-energy'];

/* Checking only the leaf (e.g. target.storeDir) misses a symlinked ancestor:
   an `.impeccable` that is itself a link resolves every path under it through
   that link, and if the leaf does not exist yet inside the link's target,
   lstat(leaf) reports ENOENT with no hint that its parent was ever a link.
   Walk from cwd down to targetPath, checking every existing component, and
   stop (nothing to report) as soon as one is missing, since nothing deeper
   can exist without it. Returns the first offending absolute path, or null. */
async function symlinkedAncestor(targetPath, cwd) {
  const boundary = path.resolve(cwd);
  const resolved = path.resolve(targetPath);
  const relative = path.relative(boundary, resolved);
  // A bare `.startsWith('..')` also matches an in-project name that merely
  // begins with those two characters ("..exports" resolves inside cwd,
  // same as "exports" would), wrongly treating it as outside the boundary
  // and skipping the walk below entirely -- exactly the case a pre-existing
  // symlink named that way needs checked, not waved through. Only an exact
  // ".." (targetPath is cwd's parent) or a "../" prefix (a genuine
  // traversal segment) means resolved actually lies outside cwd.
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)) return null;
  let cursor = boundary;
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

async function assertNoneSymlinked(cwd, candidatePaths) {
  for (const candidate of candidatePaths) {
    const linked = await symlinkedAncestor(candidate, cwd);
    if (linked) {
      throw new Error(`${path.relative(cwd, linked)} is a symlink; refusing to operate through it.`);
    }
  }
}

/* The four managed JSON files buildBundle()/importDesignContext() read or
   write directly. Deliberately narrow: assetsDir/fontsDir are not included
   here because collectFiles() already gives a symlinked assets/ or fonts/
   its own softer, per-directory skip (the rest of the export still
   completes), and folding them into this hard-refuse check would override
   that with a whole-export failure instead. */
export async function assertManagedRootsNotSymlinked(cwd) {
  const target = paths(cwd);
  await assertNoneSymlinked(cwd, [target.answersJson, target.contextJson, target.cuesJson, target.fontsManifestJson]);
}

/* Everything migrate() (design-context-import.mjs, design-context-export.mjs)
   reads from or writes through, called before migrate() runs, not only
   before the export/import call that follows it -- migrate()'s own writes
   otherwise reach a symlinked ancestor before either CLI's later checks
   get the chance to refuse. Broader than assertManagedRootsNotSymlinked on
   purpose: migrate() is an all-or-nothing legacy move with no per-file
   skip logic of its own, so every path it touches is worth a hard refuse,
   including journalJsonl/assetsDir/fontsDir as move destinations and the
   legacy `.impeccable/design-interview` paths as move sources -- a
   symlinked source would let migrate() read or move content from outside
   the project into the store, the mirror image of a symlinked destination
   moving content out.

   The move sources/destinations only exist to check when migrate() is
   actually about to move something: with no legacy store on disk, migrate()
   returns after calling only migrateContextFromCues() (contextJson/cuesJson),
   the same call it makes again at the end of the legacy-move branch. Checking
   the move paths unconditionally hard-fails a project with a symlinked
   assets/ or fonts/ that was never migrated at all, even though
   exportDesignContext() itself deliberately tolerates that same symlink and
   continues. */
export async function assertMigrationSourcesNotSymlinked(cwd) {
  const target = paths(cwd);
  const legacy = legacyPaths(cwd);
  await assertNoneSymlinked(cwd, [target.contextJson, target.cuesJson]);
  // stat() (follows symlinks), not lstat(): mirrors migrate()'s own gate,
  // fs.existsSync(legacyDir), which reports false for a dangling symlink
  // too. A legacy dir migrate() itself would silently skip past should not
  // hard-refuse here either.
  const legacyExists = await stat(legacy.legacyDir).then(() => true).catch(() => false);
  if (!legacyExists) return;
  await assertNoneSymlinked(cwd, [
    target.answersJson,
    target.journalJsonl,
    target.assetsDir,
    target.fontsDir,
    legacy.legacyDir,
    legacy.answersJson,
    legacy.journalJsonl,
    legacy.sessionJson,
    legacy.assetsDir,
    legacy.fontsDir,
  ]);
}

// A flat repeated character class ([A-Za-z0-9+/]*) matches left to right
// with no backtracking, so it stays linear-time on a multi-megabyte
// payload; a single regex expressing the whole padded-base64 grammar as
// alternated groups does not; a run of eleven million characters (an 8 MiB
// file, this file's own per-file cap) blew V8's regex backtracking stack.
const BASE64_ALPHABET_RE = /^[A-Za-z0-9+/]*$/;

/* Buffer.from(str, 'base64') never throws: invalid characters are silently
   dropped and both missing and excess padding are tolerated, so a garbled
   or truncated payload decodes into stray bytes with no error, and a
   non-string payload coerced by String() decodes whatever that
   stringification happens to produce. A prior version of this check
   stripped trailing "=" from both the input and the re-encoded result
   before comparing, meant to tolerate a sender omitting padding -- but
   that also made the comparison blind to padding itself: "YQ===" (invalid,
   one "=" too many) and a bare "=", "==", or "===" (no data at all) all
   round-tripped underneath the strip and passed as canonical, decoding
   silently to 1 byte or to an empty file. Validating the grammar first
   (length a multiple of 4, at most two trailing "=" and none elsewhere,
   alphabet everywhere else -- RFC 4648 padded base64, exactly what
   Buffer.prototype.toString('base64') always produces) rejects all of
   those before any decode happens; once grammar holds, encode/decode is a
   true bijection, so a direct equality catches everything else. */
function isCanonicalBase64(str) {
  if (typeof str !== 'string' || str.length % 4 !== 0) return false;
  const padding = str.match(/=*$/)[0];
  if (padding.length > 2) return false;
  const data = str.slice(0, str.length - padding.length);
  if (data.includes('=') || !BASE64_ALPHABET_RE.test(data)) return false;
  return Buffer.from(str, 'base64').toString('base64') === str;
}

/* ============================================================
   Export
   ============================================================ */

/* A separate lstat(path)-then-readFile(path) pair leaves a TOCTOU gap: both
   calls look the path up fresh, so a symlink swapped in between them is
   followed by readFile(), embedding whatever it points at in a bundle meant
   to be handed to someone else -- exactly the leak the lstat check exists
   to close. O_NOFOLLOW makes open() itself refuse a symlink outright
   (ELOOP), and fstat()/read() through the resulting handle answer both
   "what is this" and "what's in it" for the exact same inode open()
   resolved, not whatever a race swapped in afterward. Returns the open
   handle plus its stat on success; on failure, a `reason` naming why (for a
   caller that reports skips) or `null` when there is nothing to report
   (the path does not exist). */
async function openRegularFileNoFollow(filePath) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ELOOP') return { ok: false, reason: 'symlink, not a real file' };
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { ok: false, reason: null };
    throw error;
  }
  const fileStat = await handle.stat();
  if (!fileStat.isFile()) {
    await handle.close();
    return { ok: false, reason: 'not a regular file' };
  }
  return { ok: true, handle, stat: fileStat };
}

/* assertManagedRootsNotSymlinked() lstat-checks answers.json/context.json/
   cues.json/fonts.json once, before buildBundle() runs; readAnswers(),
   readContext(), and readJsonSoft() (store.mjs) then reopen those same paths
   through plain readFile(), which follows a symlink. A swap landing in the
   gap between the two -- the same race openRegularFileNoFollow() already
   closes for DESIGN.md and every asset -- would still leak whatever the
   symlink points at into a bundle meant to be handed to someone else.
   Opening with O_NOFOLLOW and reading through that same handle closes it
   for these four managed JSON reads too. Soft like readJsonSoft(): missing,
   non-file, symlinked, unparsable, or unreadable (permission denied, too
   many open files, any other operational failure) all read as absent
   rather than aborting the export outright -- matching how a genuinely
   missing file already behaves here, and how readJsonSoft() itself treats
   every failure. openRegularFileNoFollow() throws on a code it does not
   recognize (a caller that wants that surfaced, unlike this one), so the
   open itself is inside the try too, not only the read that follows it. */
async function readJsonNoFollow(filePath) {
  let opened;
  try {
    opened = await openRegularFileNoFollow(filePath);
  } catch {
    return null;
  }
  if (!opened.ok) return null;
  try {
    const parsed = JSON.parse(await opened.handle.readFile('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  } finally {
    await opened.handle.close();
  }
}

async function collectFiles(cwd, { includeAssets = true } = {}) {
  const target = paths(cwd);
  const files = [];
  const skipped = [];
  let total = 0;

  const take = async (absolute, relative, dirIdentity = null) => {
    // dirIdentity pins the (dev, ino) of assetsDir/fontsDir captured right
    // after the lstat-based symlink check below ran, before readdir() named
    // this file. Node's fs/promises has no openat-style "enumerate and open
    // relative to an already-open directory fd", so readdir() and this
    // file's own open both re-resolve the directory's path independently --
    // if assets/ or fonts/ is swapped for a symlink (or a different real
    // directory) after that check but before this call, readdir() and the
    // open below would both silently follow the swap. Re-checking identity
    // here, once per file rather than once for the whole directory, does
    // not close that window (portable Node has no primitive that can), but
    // it shrinks it from "the entire directory walk" to "this one file",
    // and a swap is caught on the very next file regardless of when it
    // happened. cue.png calls take() with no dirIdentity: it is not
    // enumerated from a directory this loop already validated, so there is
    // nothing to pin it against.
    if (dirIdentity) {
      let currentDirStat;
      try {
        currentDirStat = await lstat(path.dirname(absolute));
      } catch {
        skipped.push({ path: relative, bytes: 0, reason: 'containing directory changed during export' });
        return;
      }
      if (currentDirStat.dev !== dirIdentity.dev || currentDirStat.ino !== dirIdentity.ino) {
        skipped.push({ path: relative, bytes: 0, reason: 'containing directory changed during export' });
        return;
      }
    }
    // A symlink under the store could point anywhere on disk (a cloned
    // repo can carry one pointing at a local credential); reading it would
    // embed whatever it points at, and the export bundle is meant to be
    // handed to someone else. None of assets/, fonts/, or cue.png
    // legitimately holds a link. openRegularFileNoFollow() refuses one
    // outright (O_NOFOLLOW) instead of checking then separately reading by
    // path, closing the gap a race could otherwise use to swap one in
    // between the check and the read.
    const opened = await openRegularFileNoFollow(absolute);
    if (!opened.ok) {
      if (opened.reason) skipped.push({ path: relative, bytes: 0, reason: opened.reason });
      return;
    }
    const { handle, stat: fileStat } = opened;
    try {
      // Reject by the cheap fstat size first so an oversized file is never
      // fully read into memory just to be thrown away; the post-read check
      // stays as the authority for a file that grows after this fstat.
      if (fileStat.size > MAX_FILE_BYTES || total + fileStat.size > MAX_BUNDLE_BYTES) {
        skipped.push({ path: relative, bytes: fileStat.size, reason: 'too large for the bundle' });
        return;
      }
      // A count no import will accept is not worth generating: the caller
      // gets a skipped entry naming why, rather than a bundle that fails
      // whole on the way back in.
      if (files.length >= MAX_BUNDLE_FILES) {
        skipped.push({ path: relative, bytes: 0, reason: `bundle already holds the ${MAX_BUNDLE_FILES}-file maximum an import accepts` });
        return;
      }
      let bytes;
      try {
        bytes = await handle.readFile();
      } catch {
        return;
      }
      if (bytes.length > MAX_FILE_BYTES || total + bytes.length > MAX_BUNDLE_BYTES) {
        skipped.push({ path: relative, bytes: bytes.length, reason: 'too large for the bundle' });
        return;
      }
      total += bytes.length;
      files.push({
        path: relative,
        mime: MIME.get(path.extname(relative).toLowerCase()) || 'application/octet-stream',
        base64: bytes.toString('base64'),
      });
    } finally {
      await handle.close();
    }
  };

  if (!includeAssets) return { files, skipped };

  // readdir() follows a symlinked directory transparently, and lstat() on
  // whatever readdir() found back would then report the linked target's own
  // files as ordinary regular files -- take()'s own symlink check never
  // sees the directory itself, only the names it was handed. Refuse a
  // symlinked assetsDir/fontsDir (or a symlinked ancestor of the store, e.g.
  // `.impeccable` itself) before ever calling readdir() on it.
  const storeLinked = await symlinkedAncestor(target.storeDir, cwd);
  if (storeLinked) {
    skipped.push({ path: '.', bytes: 0, reason: `${path.relative(cwd, storeLinked)} is a symlink; nothing exported` });
    return { files, skipped };
  }
  for (const [dir, prefix] of [[target.assetsDir, 'assets'], [target.fontsDir, 'fonts']]) {
    let dirStat;
    try {
      dirStat = await lstat(dir);
    } catch {
      continue;
    }
    if (dirStat.isSymbolicLink()) {
      skipped.push({ path: prefix, bytes: 0, reason: 'symlink, not a real directory' });
      continue;
    }
    const dirIdentity = { dev: dirStat.dev, ino: dirStat.ino };
    let names = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) await take(path.join(dir, name), `${prefix}/${name}`, dirIdentity);
  }
  await take(target.cuePng, 'cue.png');
  return { files, skipped };
}

async function buildBundle(cwd, { includeAssets = true, now = new Date() } = {}) {
  const target = paths(cwd);
  /* The pickerless interview seed (document.md's default path today) never
     writes answers.json: it writes DESIGN.md straight from the chat and, when
     the user supplied files, stages them under assets/. Requiring answers.json
     here made export fail for every fresh seed even with DESIGN.md and staged
     assets on disk. Missing answers is only a hard failure once nothing else
     is on record either, checked below once designMd and files are known.

     Preserved as `null` rather than coerced to `{}` so the import side can
     tell "the source had no questionnaire" apart from "the source answered
     every screen with empty defaults". The downstream `document.md` and
     `design-context.md` flows both key off the existence of `answers.json`
     to recognise a completed questionnaire, so an import that synthesizes
     an empty object would install a record that reads as fully answered. */
  const answers = await readJsonNoFollow(target.answersJson);

  const storedOnDisk = await readJsonNoFollow(target.contextJson);
  const stored = storedOnDisk || { schemaVersion: SCHEMA_VERSION };
  const cues = await readJsonNoFollow(target.cuesJson);
  const source = typeof answers?.['palette-source'] === 'string' ? answers['palette-source'] : '';
  /* A seed or custom palette names no cue, so there is no image and no dealt
     entry to carry. The hexes in the answers are the palette of record. */
  const chosenCuePalette = source && cues?.palette?.[source] ? cues.palette[source] : null;

  const { files, skipped } = await collectFiles(cwd, { includeAssets });
  let designMd = null;
  const designMdPath = path.resolve(cwd, 'DESIGN.md');
  try {
    // A separate lstat()-then-readFile() pair left a gap for a symlink
    // swapped in between the two to be followed regardless: a cloned repo
    // whose DESIGN.md is (or becomes, mid-race) a link to somewhere outside
    // the project would otherwise have that external file's bytes embedded
    // verbatim in a bundle meant to be handed to someone else.
    // openRegularFileNoFollow() refuses a symlink at open() itself and
    // reads through that same handle, closing the gap.
    const opened = await openRegularFileNoFollow(designMdPath);
    if (opened.ok) {
      try {
        designMd = await opened.handle.readFile('utf8');
      } finally {
        await opened.handle.close();
      }
    } else if (opened.reason) {
      skipped.push({ path: 'DESIGN.md', bytes: 0, reason: opened.reason === 'symlink, not a real file' ? 'symlink, not exported' : opened.reason });
    }
  } catch {
    /* Not written yet, which an import is told about rather than guessing. */
  }

  /* Whole, never trimmed: the questionnaire validates the manifest by its
     pair count and quietly falls back to its own set at any other number.
     Read here, ahead of the non-empty check below, so a fonts-manifest-only
     record (no answers, no files, no DESIGN.md, no context.json) counts
     too, instead of being read twice. */
  const fonts = await readJsonNoFollow(target.fontsManifestJson);

  // hasManagedState() (design-context-import.mjs) already treats an
  // on-disk context.json, cues.json, or fonts.json alone as a real managed
  // record -- design-context.md's own no-argument status routing offers
  // export for exactly that set -- and blocks a plain re-import of such a
  // project. Without storedOnDisk/cues/fonts here, export disagreed and
  // refused to round-trip exactly that state back out.
  if (!answers && !files.length && !designMd && !storedOnDisk && !cues && !fonts) {
    throw new Error('No design interview found. Run /impeccable document to create one.');
  }

  return {
    schemaVersion: BUNDLE_SCHEMA,
    kind: BUNDLE_KIND,
    exportedAt: now.toISOString(),
    product: { name: stored.context?.product?.name || '' },
    context: stored,
    answers,
    fonts,
    // Whole, like fonts above: `chosenCue` alone (derived from
    // cues.palette[answers['palette-source']]) carries only the one
    // dealt cue an answered questionnaire actually picked, so a project
    // whose only retained state is this manifest -- no answers, hence no
    // palette-source to derive chosenCue from -- exported a bundle that
    // could not reconstruct it: import fell back to writing an empty
    // { cues: [], palette: {} }, discarding whatever was really on disk.
    cues,
    chosenCue: chosenCuePalette ? { slug: source, palette: chosenCuePalette } : null,
    designMd,
    files,
    ...(skipped.length ? { skipped } : {}),
  };
}

/* ============================================================
   The readable compilation
   ============================================================ */

const line = (label, value) => (value ? `- **${label}:** ${value}\n` : '');

function paletteTable(answers) {
  const rows = ROLES
    .map((role) => [role, String(answers[`palette-${role}`] || '')])
    .filter(([, hex]) => hex);
  if (!rows.length) return '';
  return `| Role | Value |\n| --- | --- |\n${rows.map(([role, hex]) => `| ${role} | \`${hex}\` |`).join('\n')}\n\n`;
}

/* `_chosen` (document.md's own name for the field) is a JSON-encoded array of
   the per-surface keys the user actually set; a `<key>-<mode>` field present
   in `answers` but missing from it is a preset minted when the surface was
   switched on, not a decision. Without this, an export declared "source of
   truth" reads a preset default back as if the user picked it. */
function chosenKeys(answers) {
  const raw = answers._chosen;
  try {
    if (typeof raw === 'string') {
      // JSON.parse('null') -> null and JSON.parse('"x"') -> a string are
      // both valid JSON but not the array this field is documented to hold;
      // `new Set(null)` silently yields an empty set (every key then reads
      // as "not chosen") and `new Set("x")` iterates the string's characters
      // as if they were field keys. Only an actual array is real provenance.
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return new Set(parsed);
    } else if (Array.isArray(raw)) {
      return new Set(raw);
    }
  } catch { /* malformed _chosen: fall through to "unknown", not "none chosen" */ }
  return null;
}

function perSurfaceTable(answers, surfaces) {
  const chosen = chosenKeys(answers);
  const rows = [];
  for (const key of PER_SURFACE) {
    for (const mode of surfaces) {
      const fieldKey = `${key}-${mode}`;
      const value = answers[fieldKey];
      if (!value) continue;
      const provisional = chosen ? !chosen.has(fieldKey) : false;
      rows.push([key, SURFACE_LABELS[mode] || mode, String(value), answers[key] === value, provisional]);
    }
  }
  if (!rows.length) return '';
  return `| Question | Surface | Answer |\n| --- | --- | --- |\n${rows
    .map(([key, label, value, leads, provisional]) => `| ${key} | ${label}${leads ? ' (leads)' : ''} | ${value}${provisional ? ' (preset, not chosen)' : ''} |`)
    .join('\n')}\n\n`;
}

/** One document a reader, or another tool, can follow without this toolchain. */
function renderMarkdown(bundle) {
  const context = bundle.context?.context || {};
  const answers = bundle.answers || {};
  const name = bundle.product?.name || 'This product';
  const surfaces = [].concat(answers['surface-modes'] || []).filter(Boolean);
  const out = [];

  out.push(`# Design context: ${name}\n\n`);
  out.push('The decisions this product\'s design follows, and the reasoning behind them. ');
  out.push('Exported from Impeccable; treat it as the source of truth for visual and product direction.\n\n');

  const audience = context.audience || {};
  if (Object.keys(audience).length) {
    out.push('## Audience\n\n');
    out.push(line('Primary', audience.primary));
    out.push(line('Secondary', audience.secondary));
    out.push(line('On arrival', audience.emotion));
    out.push(line('Leaving with', audience.leaving));
    if (audience.needs?.length) out.push(`- **Needs:** ${audience.needs.join('; ')}\n`);
    if (audience.trust?.length) out.push(`- **Trust triggers:** ${audience.trust.join('; ')}\n`);
    if (audience.inclusion?.length) out.push(`- **Must not exclude:** ${audience.inclusion.join('; ')}\n`);
    out.push('\n');
  }

  const product = context.product || {};
  if (Object.keys(product).length) {
    out.push('## Product\n\n');
    out.push(line('Purpose', product.purpose));
    out.push(line('Success', product.success));
    out.push(line('Platform', product.platform));
    out.push(line('Primary conversion', product.conversion));
    if (product.positioning?.not) out.push(`- **Not this:** ${product.positioning.not}\n`);
    if (product.positioning?.this) out.push(`- **This:** ${product.positioning.this}\n`);
    if (product.clarities?.length) out.push(`- **Clear first:** ${product.clarities.join('; ')}\n`);
    out.push('\n');
  }

  const brand = context.brand || {};
  if (Object.keys(brand).length) {
    out.push('## Brand\n\n');
    if (brand.words?.length) out.push(line('Words', brand.words.join(', ')));
    out.push(line('Personality', brand.personality));
    if (brand.commitments?.length) out.push(`- **Commitments:** ${brand.commitments.join('; ')}\n`);
    if (brand.voice?.length) {
      out.push('\nVoice, as wording rather than adjectives:\n\n');
      for (const pair of brand.voice) {
        if (pair?.say && pair?.not) out.push(`- Say: ${pair.say}\n  Not: ${pair.not}\n`);
      }
    }
    out.push('\n');
  }

  const interview = context.interview || {};
  if (interview.references?.length || interview.antiReference) {
    out.push('## References\n\n');
    for (const reference of interview.references || []) {
      if (typeof reference === 'string') out.push(`- ${reference}\n`);
      else if (reference?.name) out.push(`- **${reference.name}**${reference.takeaway ? `: ${reference.takeaway}` : ''}\n`);
    }
    const anti = interview.antiReference;
    if (typeof anti === 'string') out.push(`- **Anti-reference:** ${anti}\n`);
    else if (anti?.name) out.push(`- **Anti-reference:** ${anti.name}${anti.why ? ` (${anti.why})` : ''}\n`);
    out.push('\n');
  }

  out.push('## Decisions\n\n');
  if (surfaces.length) {
    out.push(`Surfaces: ${surfaces.map((mode) => SURFACE_LABELS[mode] || mode).join(', ')}. `);
    out.push('The first of these owns any answer stated once for the whole product.\n\n');
  }
  out.push('### Palette\n\n');
  out.push(paletteTable(answers));
  if (bundle.chosenCue?.slug) out.push(`Sampled from the generated cue \`${bundle.chosenCue.slug}\`.\n\n`);

  out.push('### Typography\n\n');
  out.push(line('Heading', answers['font-heading']));
  out.push(line('Body', answers['font-body']));
  out.push(line('Type scale', answers['type-scale'] && `${answers['type-scale']} (${answers['type-scale-ratio']})`));
  out.push('\n');

  if (answers['icon-pack-name']) {
    out.push('### Icons\n\n');
    out.push(`- **Pack:** ${answers['icon-pack-name']}${answers['icon-pack-license'] ? ` (${answers['icon-pack-license']})` : ''}\n`);
    if (answers['icon-pack-url']) out.push(`- **Source:** ${answers['icon-pack-url']}\n`);
    out.push('\nEvery icon comes from this pack; do not mix sets.\n\n');
  }

  const perSurface = perSurfaceTable(answers, surfaces);
  if (perSurface) {
    out.push('### Per surface\n\n');
    out.push(perSurface);
  }
  if (answers['layout-structure']) out.push(`Composition: ${answers['layout-structure']}, one answer for the whole product.\n\n`);

  if (bundle.designMd) {
    out.push('## DESIGN.md\n\n');
    out.push('The design document this context produced, verbatim.\n\n');
    out.push('<!-- begin DESIGN.md -->\n\n');
    out.push(bundle.designMd.trim());
    out.push('\n\n<!-- end DESIGN.md -->\n');
  }

  return out.join('');
}

export async function exportDesignContext(cwd, { outDir, includeAssets = true, now } = {}) {
  const target = paths(cwd);
  await assertManagedRootsNotSymlinked(cwd);

  const bundle = await buildBundle(cwd, { includeAssets, now });
  const destination = outDir ? path.resolve(cwd, outDir) : target.exportsDir;
  // The managed-input checks above cover what buildBundle() reads; they say
  // nothing about the output directory. A pre-existing symlink at the
  // default exports/ path (or an in-project --out) would let mkdir() and
  // both writes below follow it and place the export outside the project.
  // symlinkedAncestor() returns null (nothing to check) for a destination
  // outside cwd entirely, which an explicit --out may deliberately be.
  const destinationLinked = await symlinkedAncestor(destination, cwd);
  if (destinationLinked) {
    throw new Error(`${path.relative(cwd, destinationLinked)} is a symlink; refusing to export through it.`);
  }
  await mkdir(destination, { recursive: true });

  const markdownPath = path.join(destination, 'design-context.md');
  const bundlePath = path.join(destination, 'design-context.bundle.json');
  // buildBundle() bounds decoded file payloads (MAX_FILE_BYTES /
  // MAX_BUNDLE_BYTES), but designMd/answers/context/manifests are not
  // bounded at all, so the serialized bundle can still exceed
  // MAX_BUNDLE_FILE_BYTES -- the exact cap design-context-import.mjs checks
  // before reading a bundle back in. Serialize once, check that size, and
  // refuse rather than write a bundle this same release could not import.
  // Matches writeJsonAtomic()'s own serialization exactly (2-space indent
  // plus trailing newline) so this estimate is the real byte count, not an
  // approximation from a more compact form.
  const serializedSize = Buffer.byteLength(`${JSON.stringify(bundle, null, 2)}\n`);
  if (serializedSize > MAX_BUNDLE_FILE_BYTES) {
    throw new Error(`This export would be about ${serializedSize} bytes; bundles this release can import back in are capped at ${MAX_BUNDLE_FILE_BYTES} bytes. Try --no-assets or trim DESIGN.md/answers.`);
  }
  // A plain writeFile() follows a pre-existing symlink at markdownPath the
  // same as any other write, silently overwriting whatever it points to
  // outside the project -- exactly the gap writeJsonAtomic() (used for
  // bundlePath just below) already closes for the other output file.
  await writeFileAtomic(markdownPath, renderMarkdown(bundle));
  await writeJsonAtomic(bundlePath, bundle);
  return { markdownPath, bundlePath, skipped: bundle.skipped || [] };
}

/* ============================================================
   Import
   ============================================================ */

export function validateBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') throw new Error('That file is not a design context bundle');
  if (bundle.kind !== BUNDLE_KIND) throw new Error(`Expected a ${BUNDLE_KIND} bundle, found ${String(bundle.kind)}`);
  if (bundle.schemaVersion !== BUNDLE_SCHEMA) {
    throw new Error(`This bundle is schema version ${String(bundle.schemaVersion)}; this release reads ${BUNDLE_SCHEMA}. Update impeccable.`);
  }
  /* `answers: null` is the explicit "no questionnaire was answered"
     signal (the pickerless interview seed path); an object is the normal
     carried-record path. Anything else (undefined, a string, a number) is a
     malformed bundle. */
  if (bundle.answers !== null && (typeof bundle.answers !== 'object' || Array.isArray(bundle.answers))) {
    throw new Error('The bundle carries no answers');
  }
  return bundle;
}

/* Decodes and size-checks every file entry a bundle carries, entirely from
   the bundle object itself -- no cwd, no filesystem read or write. Pulled
   out of importDesignContext() so a caller that wants the complete
   non-mutating bundle preflight (envelope shape via validateBundle() above,
   plus this) can run all of it before migrate() gets a chance to move
   anything on disk, not just the envelope check. importDesignContext()
   below still calls this itself; recomputing it a second time for an
   already-preflighted bundle costs nothing a one-shot CLI import notices. */
export function decodeBundleFiles(bundle) {
  const rawFiles = Array.isArray(bundle.files) ? bundle.files : [];
  if (rawFiles.length > MAX_BUNDLE_FILES) {
    throw new Error(`This bundle names ${rawFiles.length} files; this release imports at most ${MAX_BUNDLE_FILES}.`);
  }
  const decoded = new Map();
  // Case-folded path -> the first original-cased path seen for it. Windows
  // and default-configured macOS filesystems fold case, so "assets/logo.svg"
  // and "assets/LOGO.svg" land on the same destination there even though
  // they are distinct keys in `decoded`; an exact-match duplicate check
  // alone missed that collision, so the write loop below silently
  // overwrote the first with the second while this function still reported
  // two distinct decoded entries -- `written` then counted a file that
  // could never exist on disk. Folding here, before either file is
  // accepted, rejects the whole bundle up front rather than let the two
  // filesystems disagree about how many files actually landed.
  const seenFolded = new Map();
  let totalBytes = 0;
  for (const file of rawFiles) {
    const relative = String(file?.path || '');
    if (!ALLOWED_FILE.test(relative)) continue;
    const raw = file?.base64;
    if (typeof raw !== 'string') {
      throw new Error(`Bundle entry ${relative} does not carry a valid base64 payload.`);
    }
    // The decoded length is computable exactly from the string's own
    // length and trailing "=" padding, with no decode required -- checked
    // before isCanonicalBase64() below, not after, because that call
    // itself decodes via Buffer.from() to verify the round-trip. Deferring
    // the size check past it would fully allocate an oversized payload
    // (this cap exists to avoid) before ever rejecting it. A file at
    // exactly MAX_FILE_BYTES commonly encodes with one "=", and
    // raw.length * 3 / 4 alone counts that padding byte as data, so the
    // padding is subtracted rather than estimated away.
    const padding = raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0;
    if (Math.floor((raw.length * 3) / 4) - padding > MAX_FILE_BYTES) {
      throw new Error(`Bundle entry ${relative} is larger than this release accepts.`);
    }
    // Buffer.from(..., 'base64') is lenient: a garbled or truncated payload
    // decodes into *something* instead of throwing, so import would report
    // success while writing wrong bytes. Require it to round-trip through
    // its own decode, before any mutation.
    if (!isCanonicalBase64(raw)) {
      throw new Error(`Bundle entry ${relative} does not carry a valid base64 payload.`);
    }
    const bytes = Buffer.from(raw, 'base64');
    totalBytes += bytes.length;
    if (bytes.length > MAX_FILE_BYTES || totalBytes > MAX_BUNDLE_BYTES) {
      throw new Error(`Bundle entry ${relative} is larger than this release accepts.`);
    }
    // A duplicate path collapses silently in this map (last payload wins),
    // but a write loop iterating the bundle's own raw file list would write
    // that one payload once per occurrence, reporting a written count one
    // higher per duplicate than the number of files that actually exist on
    // disk. Reject before any caller can mutate anything, rather than let
    // the count and the bundle's own semantics quietly disagree. Folded
    // rather than exact so a same-cased duplicate (the common case) and a
    // cross-cased collision are caught by the one check.
    const folded = relative.toLowerCase();
    if (seenFolded.has(folded)) {
      throw new Error(`Bundle entries ${seenFolded.get(folded)} and ${relative} name the same destination once case is folded, which some filesystems do not distinguish.`);
    }
    seenFolded.set(folded, relative);
    decoded.set(relative, bytes);
  }
  return decoded;
}

export async function importDesignContext(cwd, bundle, { design = 'skip', force = false } = {}) {
  validateBundle(bundle);
  const target = paths(cwd);

  /* hasManagedState() (design-context-import.mjs) only probes specific files
     inside the store; an empty store root that is itself a symlink to
     somewhere outside the project passes that guard with nothing to find
     there. Every write below -- the forced rm()s, writeAnswers, writeContext,
     and the per-file writes -- resolves through target.storeDir, so a
     symlinked root would carry all of them outside the project before the
     per-file containment walk further down ever runs. Checking only
     target.storeDir itself is not enough either: an ancestor such as
     `.impeccable` can be the symlink, in which case target.storeDir may not
     even exist yet under it, and a symlinked `.impeccable/visual-cues`
     carries the cue/font manifest writes further down outside the project
     while sitting entirely outside storeDir. Walk every existing ancestor of
     both managed roots before any mutation, not after the first one. */
  const storeLinked = await symlinkedAncestor(target.storeDir, cwd);
  if (storeLinked) {
    throw new Error(`${path.relative(cwd, storeLinked)} is a symlink; refusing to import through it.`);
  }
  const workspaceLinked = await symlinkedAncestor(path.dirname(target.cuesJson), cwd);
  if (workspaceLinked) {
    throw new Error(`${path.relative(cwd, workspaceLinked)} is a symlink; refusing to import through it.`);
  }

  /* Decode and size-check every file entry before any mutation below (the
     export side enforces MAX_FILE_BYTES / MAX_BUNDLE_BYTES on the way out;
     the import side owes the same bound on the way in, plus an entry-count
     cap no real export ever produces), and it has to happen before a forced
     import destroys the target's existing store -- not partway through the
     per-file write loop that used to be the first place size was checked. */
  const rawFiles = Array.isArray(bundle.files) ? bundle.files : [];
  const decoded = decodeBundleFiles(bundle);

  /* A forced import replaces the store; a plain one only ever runs against an
     empty one (design-context-import.mjs refuses otherwise). Without this,
     replacing an existing context only ever adds and overwrites what the new
     bundle names: an asset the old context had and the new one does not
     survives beside the new answers that no longer mention it, and the cue
     manifest and font manifest below, guarded on "nothing there yet", never
     update to the imported project's own choices. Clear the managed areas
     first so the store ends up exactly what the bundle describes, not a
     merge of the two. answers.json is included even though a non-null
     bundle.answers overwrites it two lines down: a bundle.answers of `null`
     (the pickerless-seed signal) writes nothing there, so without this an
     old questionnaire survives a forced import of a source that never had
     one, and a downstream reader sees it as the imported project's record. */
  if (force) {
    await rm(target.assetsDir, { recursive: true, force: true });
    await rm(target.fontsDir, { recursive: true, force: true });
    await rm(target.cuePng, { force: true });
    await rm(target.cuesJson, { force: true });
    await rm(target.fontsManifestJson, { force: true });
    await rm(target.answersJson, { force: true });
  }

  /* The questionnaire's existence is the trigger downstream readers key
     off, so the absent-answers signal must reach disk as an absent file,
     not as `{}` written under the same path. A bundle that does carry
     answers writes them as usual. */
  if (bundle.answers !== null) await writeAnswers(bundle.answers, cwd);
  const context = bundle.context && typeof bundle.context === 'object'
    ? bundle.context
    : { schemaVersion: SCHEMA_VERSION };
  await writeContext(context, cwd);

  let written = 0;
  for (const file of rawFiles) {
    const relative = String(file?.path || '');
    /* Containment is not enough on its own: a bundle could otherwise name a
       store file and overwrite what was just written. Only the three places an
       export puts bytes are accepted. */
    if (!decoded.has(relative)) {
      process.stderr.write(`Skipped ${relative || '(unnamed)'}: not a place a design context keeps files\n`);
      continue;
    }
    const absolute = path.resolve(target.storeDir, relative);
    const contained = path.relative(target.storeDir, absolute);
    // A real file's relative path is never empty; an empty result means
    // `relative` resolved to storeDir itself (writeFile() on a directory
    // throws EISDIR, uncaught, rather than skipping), same failure the
    // ALLOWED_FILE lookahead above already closes off, kept here in case a
    // future entry point reaches this loop past a differently-shaped check.
    if (!contained || contained.startsWith('..')) continue;
    /* Containment is also not enough against a symlink in the destination
       path: a plain import into a project whose `assets/` or `fonts/` is a
       pre-existing link to somewhere outside the store would follow that
       link and write the bundle's bytes wherever it points. Walk from the
       file's parent up to the store root, refuse any link along the way,
       and also refuse a link at the file itself if one already exists.
       `mkdir({recursive:true})` is still safe: on POSIX it refuses to
       traverse a symlinked directory component, so the walk is what
       actually blocks the follow. */
    let blocked = false;
    for (let cursor = path.dirname(absolute); cursor.startsWith(target.storeDir) && cursor !== target.storeDir; cursor = path.dirname(cursor)) {
      let parentStat;
      try {
        parentStat = await lstat(cursor);
      } catch {
        /* Parent does not yet exist (mkdir below will create it) or has
           already gone: nothing to check. */
        break;
      }
      if (parentStat.isSymbolicLink()) {
        process.stderr.write(`Skipped ${relative}: a symlinked component in the destination path would write outside the store\n`);
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    /* No lstat-and-branch here: a check-then-write gap is exactly what let a
       pre-existing hard link or leaf symlink at `absolute` survive to the
       write. writeFileAtomic() replaces the destination directory entry via
       rename(), which neither follows a symlink there nor writes through a
       hard link's shared inode -- so the write itself is the safety
       boundary, not a stat taken moments earlier. The one destination shape
       rename() can't land on is an existing directory (an allowed one is
       enough: a user-created `assets/logo.svg/`, say); catch that rather
       than let it abort the import after earlier files in this loop, and
       any forced rm()s before it, already landed. mkdir() belongs inside
       this same try: `assets/` or `fonts/` as a plain file (not a
       directory) is a shape hasManagedState() does not detect either, so a
       plain, non-forced import can reach here -- mkdir({recursive:true})
       throws EEXIST when the final path segment (here, `assets/` or
       `fonts/` itself) already exists as a non-directory, or ENOTDIR when
       an intermediate segment does; either way it is uncaught, after
       answers.json and context.json have already been written for this
       same import. */
    try {
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFileAtomic(absolute, decoded.get(relative));
      written += 1;
    } catch (error) {
      // Only the three destination shapes the comment above documents --
      // EISDIR (a pre-existing directory at the destination), and EEXIST /
      // ENOTDIR (assets/ or fonts/ itself is a plain file, not a directory)
      // -- are expected here and safe to skip past. Anything else (ENOSPC,
      // EACCES, a genuine I/O failure) is an operational failure, not a
      // destination shape this loop already knows how to route around:
      // swallowing it the same way reported IMPORTED after a forced import
      // had already deleted the old store, leaving a partial context that
      // looked complete to the caller. Let it abort the import instead.
      if (!['EISDIR', 'EEXIST', 'ENOTDIR'].includes(error.code)) throw error;
      process.stderr.write(`Skipped ${relative}: could not write the destination (${error.code || error.message})\n`);
    }
  }

  /* The questionnaire cannot run without a cue manifest: its palette screen
     loads the deck and the built-in seeds together, and neither arrives if the
     file is missing. An imported project gets a valid one either way. A
     whole `bundle.cues` (carried since this release; an older bundle predating
     it, or one that genuinely had no cues.json to export, has none) restores
     the source project's manifest exactly, the deck included. Without one,
     fall back to reconstructing just the chosen cue's dealt values, the same
     narrower shape older bundles carried. */
  if (!(await readJsonSoft(target.cuesJson))) {
    const wholeCues = bundle.cues && typeof bundle.cues === 'object' && !Array.isArray(bundle.cues) ? bundle.cues : null;
    await writeJsonAtomic(target.cuesJson, wholeCues || {
      cues: [],
      ...(bundle.chosenCue?.slug ? { palette: { [bundle.chosenCue.slug]: bundle.chosenCue.palette } } : { palette: {} }),
    });
  }
  if (bundle.fonts && !(await readJsonSoft(target.fontsManifestJson))) {
    await writeJsonAtomic(target.fontsManifestJson, bundle.fonts);
  }

  let designWritten = false;
  if (design === 'write' && typeof bundle.designMd === 'string' && bundle.designMd.trim()) {
    const designPath = path.resolve(cwd, 'DESIGN.md');
    // An lstat()-then-writeFile() check (what this replaced) still leaves a
    // gap between the check and the write for another process to create or
    // swap in a symlink at designPath in between; writeFile() would then
    // follow it. 'wx' (O_CREAT|O_EXCL) makes the open itself the create, so
    // there is no separate check to race: it fails with EEXIST the instant
    // anything -- file, symlink, or directory -- already occupies the path,
    // which is exactly the case to skip rather than write through.
    try {
      const handle = await open(designPath, 'wx');
      let written = false;
      try {
        await handle.writeFile(bundle.designMd);
        written = true;
        designWritten = true;
      } finally {
        await handle.close();
        // The exclusive open already created designPath; a write failure
        // past that point (ENOSPC, EFBIG) would otherwise leave a partial
        // file behind that a retry's own 'wx' open then rejects with
        // EEXIST -- permanently skipping the document rather than retrying
        // it. Clean up what this call itself created before the error
        // propagates.
        if (!written) await rm(designPath, { force: true }).catch(() => {});
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      process.stderr.write('Skipped writing DESIGN.md: something already exists there\n');
    }
  }

  return { written, designWritten, designCarried: typeof bundle.designMd === 'string' && Boolean(bundle.designMd.trim()) };
}
