#!/usr/bin/env node
/** Write this project's design context out in two forms.
 *
 *   node <scripts_path>/design-context-export.mjs [--out DIR] [--no-assets]
 *
 * design-context.md          one document a reader or another tool can follow
 * design-context.bundle.json everything needed to rebuild the store elsewhere
 *
 * Prints one EXPORTED line per file written. Exit 1 when the project has no
 * design interview to export.
 */

import { migrate } from './design-context/store.mjs';
import { assertMigrationSourcesNotSymlinked, exportDesignContext } from './design-context/portability.mjs';

function printHelp() {
  console.log(`Usage: node design-context-export.mjs [options]

Write the design context to a readable document and a portable bundle.

Options:
  --out DIR      Where to write (default: .impeccable/design-context/exports)
  --no-assets    Leave supplied files and the cue image out of the bundle
  --help         Show this help

Output:
  EXPORTED PATH  One line per file written

See reference/design-context.md for the canonical agent flow.`);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  printHelp();
  process.exit(0);
}

const readValue = (name) => {
  const exact = args.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const at = args.indexOf(name);
  return at !== -1 && args[at + 1] && !args[at + 1].startsWith('--') ? args[at + 1] : '';
};

const unknown = args.find((arg) => arg.startsWith('--')
  && !['--out', '--no-assets', '--help'].some((flag) => arg === flag || arg.startsWith(`${flag}=`)));
if (unknown) {
  console.error(`Unknown option: ${unknown}`);
  process.exit(1);
}

try {
  // migrate() (below) reads from and writes through paths
  // exportDesignContext()'s own symlink rejection never covers (it runs
  // too late, and does not know about migrate()'s legacy sources or its
  // journalJsonl/assetsDir/fontsDir destinations): a symlinked
  // `.impeccable` ancestor, or a symlinked legacy `design-interview`
  // source, would let migrate() move content in or out of the project
  // before the export call ever gets a chance to refuse.
  await assertMigrationSourcesNotSymlinked(process.cwd());
  await migrate(process.cwd());

  const { markdownPath, bundlePath, skipped } = await exportDesignContext(process.cwd(), {
    outDir: readValue('--out') || undefined,
    includeAssets: !args.includes('--no-assets'),
  });
  for (const entry of skipped) {
    console.error(`Skipped ${entry.path} (${entry.bytes} bytes): ${entry.reason}`);
  }
  console.log(`EXPORTED ${markdownPath}`);
  console.log(`EXPORTED ${bundlePath}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
