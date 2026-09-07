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
 * Exit 0 when the tree is in sync, 1 when it is not. Only the generated
 * harness/plugin paths need to start clean, since those are what this
 * script diffs against a fresh rebuild; an uncommitted SOURCE edit (the
 * exact case this script exists to catch -- a `skill/` change that never
 * got `bun run build:release`) is expected and must not block the run.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS } from './lib/transformers/providers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A provider's configDir is its ROOT, not its generated-output root: e.g.
// `.github/` also holds hand-maintained `workflows/` and `ISSUE_TEMPLATE/`,
// and `.codex/skills` is never synced at all (build.js's syncRootOutputs
// explicitly excludes '.codex' from the skills/commands/agents loops --
// only its hooks.json is generated, via the separate, unfiltered
// syncRootHookManifests pass). Mirror the actual synced subpaths instead of
// sweeping every file under each provider's directory.
const SYNCED_PROVIDERS = Object.values(PROVIDERS).filter((p) => p.configDir !== '.codex');

const GENERATED_PREFIXES = [
  ...SYNCED_PROVIDERS.map((p) => `${p.configDir}/skills/`),
  ...SYNCED_PROVIDERS.map((p) => `${p.configDir}/commands/`),
  ...Object.values(PROVIDERS).filter((p) => p.agentFormat).map((p) => `${p.configDir}/agents/`),
  'plugin/',
];

// Hook manifests are single named files (syncRootHookManifests), not
// subtrees, and run over every provider regardless of the .codex skills
// exclusion above -- .codex/hooks.json is real generated output.
const GENERATED_FILES = Object.values(PROVIDERS)
  .filter((p) => p.emitHooks)
  .map((p) => `${p.configDir}/${p.hooksManifestRel || 'hooks/hooks.json'}`);

function isGeneratedPath(file) {
  return GENERATED_PREFIXES.some((prefix) => file.startsWith(prefix)) || GENERATED_FILES.includes(file);
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8' });
}

function changedPaths() {
  // Do not trim() the raw output before splitting: porcelain's leading
  // status column is a literal space for "modified, not staged" ( M path),
  // and trimming the whole multi-line string eats that space off only the
  // FIRST line, corrupting its slice(3) into missing its leading character.
  return git(['status', '--porcelain'])
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.slice(3).trim());
}

const before = changedPaths().filter(isGeneratedPath);
if (before.length > 0) {
  console.error('check:generated needs the generated harness/plugin paths to start clean; these are already modified:');
  for (const file of before.slice(0, 20)) console.error(`  ${file}`);
  if (before.length > 20) console.error(`  ... and ${before.length - 20} more`);
  console.error('\nCommit or stash them, then run again.');
  process.exit(1);
}

console.log('Rebuilding provider output...');
execFileSync('bun', ['run', 'build:release'], { cwd: ROOT, stdio: 'ignore' });

const after = changedPaths().filter(isGeneratedPath);
if (after.length === 0) {
  console.log('✓ Committed provider output matches the build.');
  process.exit(0);
}

console.error(`✗ Generated output is stale: ${after.length} file(s) changed when rebuilt.\n`);
for (const file of after.slice(0, 30)) console.error(`  ${file}`);
if (after.length > 30) console.error(`  ... and ${after.length - 30} more`);
console.error('\nRun `bun run build:release` and commit the result.');
process.exit(1);
