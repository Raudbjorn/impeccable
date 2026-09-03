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

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { migrate, paths, pidAlive, readJsonSoft } from './design-context/store.mjs';
import {
  assertMigrationSourcesNotSymlinked,
  importDesignContext,
  validateBundle,
  MAX_BUNDLE_FILE_BYTES,
} from './design-context/portability.mjs';

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
function isSeedDesignMd(designPath) {
  try {
    return /<!--\s*SEED\b/.test(readFileSync(designPath, 'utf8'));
  } catch {
    return false;
  }
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

let bundle;
try {
  const bundlePath = path.resolve(process.cwd(), source);
  // The per-entry checks inside importDesignContext bound decoded file
  // payloads; they say nothing about the serialized bundle itself, which
  // readFile() below would otherwise load whole into memory (then JSON.parse
  // the whole thing) before any of those checks ever run. Reject an
  // oversized file by its own size, before reading or parsing it at all.
  const bundleStat = await stat(bundlePath);
  // The size check above is only meaningful for a regular file: a FIFO or
  // character device commonly reports size 0 regardless of what actually
  // flows through it, so one named `bundle.json` would sail past that check
  // and then block (or stream unbounded data) in the readFile() below,
  // which has no cap of its own.
  if (!bundleStat.isFile()) {
    throw new Error(`${bundlePath} is not a regular file.`);
  }
  if (bundleStat.size > MAX_BUNDLE_FILE_BYTES) {
    throw new Error(`This bundle is ${bundleStat.size} bytes; this release reads bundles up to ${MAX_BUNDLE_FILE_BYTES} bytes.`);
  }
  bundle = validateBundle(JSON.parse(await readFile(bundlePath, 'utf8')));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const result = await importDesignContext(process.cwd(), bundle, { design, force: args.includes('--force') });
console.log(`IMPORTED ${result.written} files`);
console.log(`DESIGN_MD ${result.designCarried ? 'carried' : 'absent'}${result.designWritten ? ' written' : ''}`);
