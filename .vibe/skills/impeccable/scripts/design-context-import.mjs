#!/usr/bin/env node
/** Rebuild a design context in this project from a bundle another one exported.
 *
 *   node <scripts_path>/design-context-import.mjs <bundle.json>
 *     [--design skip|write] [--force]
 *
 * Refuses a project that already has a design context unless --force, and
 * refuses either way while an edit session is running, because the session is
 * the only writer of the store while it lives.
 *
 * Prints IMPORTED <n> files and DESIGN_MD carried|absent for the agent to
 * branch on. Exit 1 on a bundle this release cannot read.
 */

import { existsSync, readdirSync, openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { migrate, paths, pidAlive, readJsonSoft } from './design-context/store.mjs';
import {
  assertMigrationSourcesNotSymlinked,
  decodeBundleFiles,
  importDesignContext,
  validateBundle,
  MAX_BUNDLE_FILE_BYTES,
} from './design-context/portability.mjs';
const SEED_DESIGN_MARKERS = ['/', '$'].map((prefix) =>
  '<!-- SEED: established with the user before implementation; '
    + `re-run ${prefix}impeccable document once there's code to capture the actual tokens and components. -->`
);

/* A pickerless interview seed stages a provided logo or moodboard under
   assets/ (and can carry context.json / cue.png from an earlier import)
   without ever writing answers.json, so checking answers.json alone treated
   that seed as an empty store. A plain import then installed another
   project's answers on top while leaving the seed's own staged assets and
   manifests in place -- a mixed context, despite the refusal below existing
   specifically to require --force before anything gets replaced.

   A seed can also carry nothing under the store at all: a pickerless-seed
   DESIGN.md alone, at the project root, is itself a valid record
   (design-context.md's own no-argument status routing treats it that way).
   Without this check, a plain import onto that project overlays another
   bundle's answers/context on top of an existing, unrelated design world,
   and DESIGN.md itself is left in place -- --design defaults to "skip", so
   nothing here even offers to reconcile the mismatch.

   Not every DESIGN.md is that record, though: the ordinary `document` scan
   flow writes one from a project's actual built code, with no design
   context behind it at all. Treating file existence alone as "has a design
   context" made every such project reject a plain import and demand
   --force, a destructive flag, for what should be a routine first import.
   Only a *seed* DESIGN.md carries the `<!-- SEED` marker document.md's seed
   mode writes (see its template and its own staleness check in
   lib/staleness-deep.mjs's SEED_DESIGN_MARKERS); check for that instead of
   mere presence. */
// document.md's seed mode writes the marker as the first line of the
// markdown body, right after the frontmatter's closing "---", so it always
// sits well within this many bytes of the start; bounding the read here
// means a huge DESIGN.md is never loaded whole just to answer yes/no.
const SEED_MARKER_PROBE_BYTES = 8192;

function isSeedDesignMd(designPath) {
  let fd;
  try {
    // O_NOFOLLOW refuses a symlink outright rather than reading through it.
    // O_NONBLOCK matters for a FIFO specifically: opening one for reading
    // blocks until a writer opens the other end, which O_RDONLY alone would
    // have done right here, before fstat ever got the chance to say this
    // is not a regular file. With it, the open itself never blocks; fstat
    // (not a separate lstat/stat call) then answers "is this a regular
    // file" for the exact same fd the read below uses, catching a FIFO or
    // character device before any read is attempted.
    fd = openSync(designPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return false;
  }
  try {
    if (!fstatSync(fd).isFile()) return false;
    const buffer = Buffer.alloc(SEED_MARKER_PROBE_BYTES);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    const probe = buffer.subarray(0, bytesRead).toString('utf8');
    // The exact marker document.md's seed mode writes, not a loose
    // `<!--\s*SEED\b` shape: that shape also matches an unrelated ordinary
    // comment like `<!-- SEED colors from legacy theme -->` in a
    // scan-generated DESIGN.md, misclassifying it as a pickerless seed and
    // forcing a destructive --force import.
    return SEED_DESIGN_MARKERS.some((marker) => probe.includes(marker));
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

/* fstat().size is a snapshot from the instant it ran: for a regular file at
   a fixed inode (O_NOFOLLOW already pinned that), the bytes behind it can
   still grow after the stat -- a concurrent writer, or the same file kept
   open and appended to -- so a size check taken once and a separate
   handle.readFile() taken after it leaves the same gap the open-once
   O_NOFOLLOW fix above closes for identity, just for size instead.
   Reading at most `limit` bytes through this handle -- never more than
   statSizeHint + 1, itself never more than maxBytes + 1 -- makes the read
   itself bound memory regardless of how large the file has grown to by the
   time this runs, rather than trusting the stat that preceded it. A file
   that grew past its own stat size is still caught: the loop stops at
   `limit` with real bytes left unread, so what comes back is a prefix that
   either fails to parse as JSON (safe: nothing past `limit` was ever
   touched) or, if `statSizeHint` itself already sat at the cap, trips the
   oversized check below. This is deliberately sized from `statSizeHint`
   rather than always allocating maxBytes + 1: the caller already knows the
   file's stat size and it is almost always far below the cap, so the
   common case (a normal-sized bundle) does not pay for the worst case's
   buffer. handle.read() can return short reads even for a regular file, so
   this loops until either `limit` is reached or read() reports EOF
   (bytesRead === 0). */
async function readBoundedUtf8(handle, statSizeHint, maxBytes) {
  const limit = Math.min(statSizeHint + 1, maxBytes + 1);
  const buffer = Buffer.allocUnsafe(limit);
  let total = 0;
  while (total < limit) {
    const { bytesRead } = await handle.read(buffer, total, limit - total, null);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  // total === limit means more was available and unread past that point:
  // either genuinely oversized (limit was capped by maxBytes + 1) or a
  // truncated read of a file that grew past statSizeHint (limit was capped
  // by that instead) -- in the second case JSON.parse on the resulting
  // prefix is expected to fail on its own, which is a safe outcome, not
  // one this function needs to distinguish from the first.
  if (total >= limit && total > maxBytes) return { oversized: true, text: undefined };
  return { oversized: false, text: buffer.toString('utf8', 0, total) };
}

function hasManagedState(cwd) {
  const target = paths(cwd);
  if (
    existsSync(target.answersJson) ||
    existsSync(target.contextJson) ||
    existsSync(target.cuePng) ||
    existsSync(target.cuesJson) ||
    existsSync(target.fontsManifestJson) ||
    isSeedDesignMd(path.resolve(cwd, 'DESIGN.md'))
  ) {
    return true;
  }
  for (const dir of [target.assetsDir, target.fontsDir]) {
    try {
      if (readdirSync(dir).length > 0) return true;
    } catch { /* directory absent: nothing staged there */ }
  }
  return false;
}

function printHelp() {
  console.log(`Usage: node design-context-import.mjs <bundle.json> [options]

Rebuild this project's design context from an exported bundle.

Options:
  --design skip|write  Write DESIGN.md when the bundle carries one and this
                       project has none (default: skip)
  --force              Replace an existing design context
  --help               Show this help

Output:
  IMPORTED N files
  DESIGN_MD carried|absent

See reference/design-context.md for the canonical agent flow.`);
}

const args = process.argv.slice(2);
if (!args.length || args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(args.length ? 0 : 1);
}

const source = args.find((arg) => !arg.startsWith('--'));
if (!source) {
  console.error('Name the bundle to import.');
  process.exit(1);
}

const designAt = args.indexOf('--design');
const design = designAt !== -1 && args[designAt + 1] ? args[designAt + 1] : 'skip';
if (!['skip', 'write'].includes(design)) {
  console.error('--design must be skip or write');
  process.exit(1);
}

/* Read and validate the bundle before migrate() (below) gets a chance to
   run. migrate() moves files on disk (a legacy-layout project's
   design-interview store into the current one); it used to run first, so a
   bundle that failed this same validation moments later -- oversized,
   malformed, not a regular file, too many files, invalid base64 -- still
   left that migration's filesystem side effects in place before the
   process exited on the bundle error. Invalid input must have no side
   effects at all, so every check the rest of the import would otherwise
   run first (the shallow envelope via validateBundle() and the per-file
   decode/size/count checks via decodeBundleFiles(), both pure and
   non-mutating) runs here too, not only inside importDesignContext(). */
let bundle;
try {
  const bundlePath = path.resolve(process.cwd(), source);
  // A separate stat(path)-then-readFile(path) pair looks the path up
  // twice, leaving a window for it to be replaced (with a symlink, a
  // FIFO/pipe, a device, or simply grown past what was checked) between the
  // two. Opening once and then fstat-ing and reading through that same fd
  // closes the window: O_NOFOLLOW refuses a symlink outright rather than
  // reading through it, and O_NONBLOCK matters for a FIFO specifically --
  // opening one for reading would otherwise block this whole CLI waiting for
  // a writer, before fstat ever got the chance to say this isn't a regular
  // file.
  const handle = await open(bundlePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const bundleStat = await handle.stat();
    // The size check above is only meaningful for a regular file: a FIFO or
    // character device commonly reports size 0 regardless of what actually
    // flows through it, so one named `bundle.json` would sail past that check
    // and then block (or stream unbounded data) in the read below, which has
    // no cap of its own.
    if (!bundleStat.isFile()) {
      throw new Error(`${bundlePath} is not a regular file.`);
    }
    // Cheap fast path only: an obviously oversized file is rejected here
    // without ever allocating the bounded-read buffer below. It is not the
    // enforcement -- the file can still grow past this snapshot before the
    // read that follows, which is what readBoundedUtf8() actually guards.
    if (bundleStat.size > MAX_BUNDLE_FILE_BYTES) {
      throw new Error(`This bundle is ${bundleStat.size} bytes; this release reads bundles up to ${MAX_BUNDLE_FILE_BYTES} bytes.`);
    }
    const { oversized, text } = await readBoundedUtf8(handle, bundleStat.size, MAX_BUNDLE_FILE_BYTES);
    if (oversized) {
      throw new Error(`This bundle grew larger than this release reads bundles up to (${MAX_BUNDLE_FILE_BYTES} bytes).`);
    }
    bundle = validateBundle(JSON.parse(text));
    decodeBundleFiles(bundle);
  } finally {
    await handle.close();
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

/* migrate() (below) reads from and writes through paths
   importDesignContext()'s own symlink rejection never covers (it runs too
   late, and does not know about migrate()'s legacy sources or its
   journalJsonl/assetsDir/fontsDir destinations): a symlinked `.impeccable`
   ancestor, or a symlinked legacy `design-interview` source, would let
   migrate() move content in or out of the project before the import call
   ever gets a chance to refuse. */
try {
  await assertMigrationSourcesNotSymlinked(process.cwd());
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

/* A live legacy-format session holds the OLD paths in its own constants, so
   migrate() defers rather than moving files out from under it. Proceeding
   here anyway would import into the new-layout store while that session
   keeps writing the old one -- two stores, one project, neither aware of the
   other. Refuse the same way the running-session check below does. */
const { deferred } = await migrate(process.cwd());
if (deferred) {
  console.error('A design context document from an older release is open. Close it, then import.');
  process.exit(1);
}
const target = paths(process.cwd());

/* A running session holds the store: importing under it would swap the run out
   from beneath the document someone is reading and the batch it may owe. */
const session = await readJsonSoft(target.sessionJson);
if (session && pidAlive(session.pid)) {
  console.error(`A design context document is open on http://127.0.0.1:${session.port}. Close it, then import.`);
  process.exit(1);
}

if (!args.includes('--force') && hasManagedState(process.cwd())) {
  console.error('This project already has a design context. Re-run with --force to replace it.');
  process.exit(1);
}

const result = await importDesignContext(process.cwd(), bundle, { design, force: args.includes('--force') });
console.log(`IMPORTED ${result.written} files`);
console.log(`DESIGN_MD ${result.designCarried ? 'carried' : 'absent'}${result.designWritten ? ' written' : ''}`);
