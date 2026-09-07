/**
 * Which repo paths `bun run build:release` owns, and how to read the paths
 * `git status` reports.
 *
 * Split out of scripts/check-generated.mjs so both halves are unit-testable
 * without a git repository or a build: the classifier is a pure predicate over
 * a path string, and the porcelain reader is a pure function of git's raw
 * bytes. Both have been wrong in ways no test could see (a directory-wide
 * prefix claiming repo-local files, a line-oriented parser reading C-quoted
 * display text as a literal path), which is why they live here now.
 */
import { PROVIDERS } from './transformers/providers.js';

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
export const GENERATED_SKILL = 'impeccable';

// Skill directories the build DELETES from every synced harness dir. They
// ship in dist/ so the cleanup script can redirect users, but they must not
// sit in the repo's own provider dirs. `build:release` removes them
// unconditionally, which makes them build-owned territory: a gate that did
// not claim them would filter out the deletion and report the tree in sync
// while it was dirty. Exported so build.js and this classifier cannot drift.
export const DEPRECATED_LOCAL_SKILLS = [
  'frontend-design', 'teach-impeccable',
  'arrange', 'normalize', 'onboard', 'extract',
  // v3.0 consolidation: standalone skills -> /impeccable sub-commands
  'adapt', 'animate', 'audit', 'bolder', 'clarify', 'colorize',
  'critique', 'delight', 'distill', 'harden', 'layout', 'optimize',
  'overdrive', 'polish', 'quieter', 'shape', 'typeset',
];

export const GENERATED_PREFIXES = [
  ...SYNCED_PROVIDERS.map((p) => `${p.configDir}/skills/${GENERATED_SKILL}/`),
  ...SYNCED_PROVIDERS.flatMap((p) => DEPRECATED_LOCAL_SKILLS.map((name) => `${p.configDir}/skills/${name}/`)),
  // Agents are the exception: syncRootOutputs rm -rf's the whole agents
  // destination before copying, so the build really does own that subtree.
  ...Object.values(PROVIDERS).filter((p) => p.agentFormat).map((p) => `${p.configDir}/agents/`),
  'plugin/',
];

// Hook manifests are single named files (syncRootHookManifests), not
// subtrees, and run over every provider regardless of the .codex skills
// exclusion above -- .codex/hooks.json is real generated output.
export const GENERATED_FILES = [
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

export function isGeneratedPath(file) {
  return GENERATED_PREFIXES.some((prefix) => file.startsWith(prefix)) || GENERATED_FILES.includes(file);
}

/**
 * Read `git status --porcelain -z` output into plain paths.
 *
 * NUL-delimited, not line-oriented: the plain form is display text, which
 * C-quotes any path holding a space, a quote, or a non-ASCII byte, and writes
 * a rename as `old -> new` on one line. NUL output is never quoted and never
 * joined. A rename or copy spends a SECOND record on its source path with no
 * status prefix of its own; both ends are collected, since the old path is
 * being removed and the new one written and either can be generated output.
 *
 * The records are not trimmed: the status column is a literal space for
 * "modified, not staged" ( M path), so the path begins at index 3 exactly.
 */
export function parsePorcelainZ(raw) {
  const records = raw.split('\0').filter((r) => r.length > 0);
  const paths = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const status = record.slice(0, 2);
    paths.push(record.slice(3));
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
