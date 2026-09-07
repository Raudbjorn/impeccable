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

// The skills and commands syncs copy PER ENTRY and never remove the
// destination directory, precisely so unrelated repo-local skills and command
// files survive a build (build.js's syncRootOutputs, and the header of
// scripts/lib/root-commands-sync.mjs). So the build owns only the entries it
// writes, not the directories they sit in: sweeping `<configDir>/skills/`
// wholesale made an edit to someone's own `.github/skills/<other>/...` or
// `.opencode/commands/<local>.md` block this script, over files the release
// build never touches.
//
// Both names come from the same place -- the skill list the build reads from
// `skill/`, written out as `skills/<skill.name>/` and, for OpenCode, the
// bridge file `commands/<skill.name>.md` (factory.js:410). This repo ships
// exactly one skill (see CLAUDE.md), so one constant covers both and keeps
// them from drifting apart.
const GENERATED_SKILL = 'impeccable';

const GENERATED_PREFIXES = [
  ...SYNCED_PROVIDERS.map((p) => `${p.configDir}/skills/${GENERATED_SKILL}/`),
  // Agents are the exception: syncRootOutputs rm -rf's the whole agents
  // destination before copying, so the build really does own that subtree.
  ...Object.values(PROVIDERS).filter((p) => p.agentFormat).map((p) => `${p.configDir}/agents/`),
  'plugin/',
];

// Hook manifests are single named files (syncRootHookManifests), not
// subtrees, and run over every provider regardless of the .codex skills
// exclusion above -- .codex/hooks.json is real generated output.
const GENERATED_FILES = [
  ...Object.values(PROVIDERS)
    .filter((p) => p.emitHooks)
    .map((p) => `${p.configDir}/${p.hooksManifestRel || 'hooks/hooks.json'}`),
  // Only OpenCode gets a command bridge (factory.js gates it on
  // `provider === 'opencode'`), so listing this path for every provider
  // reintroduced the bug above one directory down: a user-owned
  // `.github/commands/impeccable.md` would block a gate the build never
  // writes to.
  ...Object.values(PROVIDERS)
    .filter((p) => p.provider === 'opencode')
    .map((p) => `${p.configDir}/commands/${GENERATED_SKILL}.md`),
];

function isGeneratedPath(file) {
  return GENERATED_PREFIXES.some((prefix) => file.startsWith(prefix)) || GENERATED_FILES.includes(file);
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8' });
}

function changedPaths() {
  // -z, not the line-oriented form. Plain `--porcelain` is display text: it
  // C-quotes any path with a space, a quote, or a non-ASCII byte, and writes
  // a rename as `old -> new` on one line. Read literally, a dirty
  // `.omp/agents/custom agent.md` arrives as `"..."` and matches no prefix,
  // so the preflight waves through a file `build:release` is about to
  // rewrite. NUL-delimited output is never quoted and never joined.
  //
  // Do not trim the records either: the status column is a literal space for
  // "modified, not staged" ( M path), so the path begins at index 3 exactly.
  const records = git(['status', '--porcelain', '-z']).split('\0').filter((r) => r.length > 0);
  const paths = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const status = record.slice(0, 2);
    paths.push(record.slice(3));
    // A rename or copy spends a second record on its source path, with no
    // status prefix of its own. Both ends matter here: the old path is being
    // removed and the new one written, and either can be generated output.
    if (status.includes('R') || status.includes('C')) {
      const source = records[i + 1];
      if (source !== undefined) {
        paths.push(source);
        i++;
      }
    }
  }
  return paths;
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
// Inherit rather than ignore: when build:release fails, its own validator or
// compiler error is the whole diagnostic, and swallowing it leaves the caller
// with nothing but an execFileSync stack trace for a gate whose job is to
// tell them what is wrong.
execFileSync('bun', ['run', 'build:release'], { cwd: ROOT, stdio: 'inherit' });

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
