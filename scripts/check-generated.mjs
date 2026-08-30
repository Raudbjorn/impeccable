#!/usr/bin/env node
/**
 * Fail when the committed provider output does not match what the build
 * produces from the current source.
 *
 * The harness directories and ./plugin are generated artifacts that are
 * nonetheless committed, because `npx skills` installs from them directly.
 * That makes drift invisible: a source edit that is never followed by
 * `bun run build:release` ships stale output to every installer, and nothing
 * says so. This fork has no CI, so this is a local and pre-release gate
 * rather than an automated one; `scripts/release.mjs` already refuses a dirty
 * tree, which covers the release path but not day-to-day work.
 *
 *   bun run check:generated
 *
 * Exit 0 when the tree is in sync, 1 when it is not. Requires a clean working
 * tree for the generated paths, since it compares against the build's output
 * in place.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8' }).trim();
}

function changedPaths() {
  return git(['status', '--porcelain'])
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

const before = changedPaths();
if (before.length > 0) {
  console.error('check:generated needs a clean working tree; these files are already modified:');
  for (const file of before.slice(0, 20)) console.error(`  ${file}`);
  if (before.length > 20) console.error(`  ... and ${before.length - 20} more`);
  console.error('\nCommit or stash them, then run again.');
  process.exit(1);
}

console.log('Rebuilding provider output...');
execFileSync('bun', ['run', 'build:release'], { cwd: ROOT, stdio: 'ignore' });

const after = changedPaths();
if (after.length === 0) {
  console.log('✓ Committed provider output matches the build.');
  process.exit(0);
}

console.error(`✗ Generated output is stale: ${after.length} file(s) changed when rebuilt.\n`);
for (const file of after.slice(0, 30)) console.error(`  ${file}`);
if (after.length > 30) console.error(`  ... and ${after.length - 30} more`);
console.error('\nRun `bun run build:release` and commit the result.');
process.exit(1);
