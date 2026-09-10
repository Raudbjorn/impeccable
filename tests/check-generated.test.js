/**
 * Unit coverage for the two halves of the `check:generated` drift gate.
 *
 * Both have already been wrong in ways nothing could catch, because the gate
 * had no test and its logic was only reachable by running a full build:
 *
 * - The classifier swept `<configDir>/skills/` and `<configDir>/commands/`
 *   whole. Both syncs copy per entry and never remove the destination, so a
 *   repo-local `.github/skills/<other>/` or `.opencode/commands/<local>.md`
 *   blocked the gate over files `build:release` never writes. Narrowing that
 *   then over-corrected the other way, listing the OpenCode command bridge for
 *   every provider when factory.js emits it only for OpenCode.
 * - The porcelain reader parsed line-oriented `--porcelain`, which is display
 *   text: it C-quotes any path with a space and joins a rename onto one line.
 *   A dirty `.omp/agents/custom agent.md` therefore matched no prefix and was
 *   waved through, into a build about to rewrite it.
 *
 * The classifier is a pure predicate over a path string and the reader is a
 * pure function of git's raw bytes, so neither needs a repository or a build.
 */
import { describe, test, expect } from 'bun:test';
import {
  GENERATED_FILES,
  GENERATED_PREFIXES,
  GENERATED_SKILL,
  DEPRECATED_LOCAL_SKILLS,
  isGeneratedPath,
  parsePorcelainZ,
} from '../scripts/lib/generated-paths.mjs';
import { PROVIDERS } from '../scripts/lib/transformers/providers.js';

const NUL = '\0';

describe('isGeneratedPath', () => {
  test('claims the skill the build writes, in every synced provider', () => {
    const synced = Object.values(PROVIDERS).filter((p) => p.configDir !== '.codex');
    expect(synced.length).toBeGreaterThan(1);
    for (const { configDir } of synced) {
      expect(isGeneratedPath(`${configDir}/skills/${GENERATED_SKILL}/SKILL.md`)).toBe(true);
      expect(isGeneratedPath(`${configDir}/skills/${GENERATED_SKILL}/reference/audit.md`)).toBe(true);
    }
  });

  test('leaves a repo-local skill alone in every provider', () => {
    // The skills sync copies per entry and never removes the destination, so
    // a skill the build does not write is nobody's business but its owner's.
    for (const { configDir } of Object.values(PROVIDERS)) {
      expect(isGeneratedPath(`${configDir}/skills/some-other-skill/SKILL.md`)).toBe(false);
    }
  });

  test('claims the OpenCode command bridge and no other provider’s commands', () => {
    // factory.js gates the bridge on `provider === 'opencode'`, so a
    // user-owned commands file under any other provider is not generated.
    expect(isGeneratedPath(`.opencode/commands/${GENERATED_SKILL}.md`)).toBe(true);
    for (const { provider, configDir } of Object.values(PROVIDERS)) {
      if (provider === 'opencode') continue;
      expect(isGeneratedPath(`${configDir}/commands/${GENERATED_SKILL}.md`)).toBe(false);
    }
    // Even under OpenCode, only that exact file: it is an exact match, not a
    // prefix, so a hand-written sibling command survives.
    expect(isGeneratedPath('.opencode/commands/my-own-command.md')).toBe(false);
  });

  test('claims the deprecated skill stubs the build deletes', () => {
    // build.js removes `<configDir>/skills/<name>` for each of these on every
    // release build. A gate that did not claim them would filter the deletion
    // out of its staleness diff and report the tree in sync while it was
    // dirty, which is the one thing this script exists to prevent.
    expect(DEPRECATED_LOCAL_SKILLS.length).toBeGreaterThan(0);
    const synced = Object.values(PROVIDERS).filter((p) => p.configDir !== '.codex');
    for (const { configDir } of synced) {
      for (const name of DEPRECATED_LOCAL_SKILLS) {
        expect(isGeneratedPath(`${configDir}/skills/${name}/SKILL.md`)).toBe(true);
      }
    }
    // Still not a blanket claim on the directory: a name the build never
    // deletes stays the owner's.
    expect(isGeneratedPath('.claude/skills/some-other-skill/SKILL.md')).toBe(false);
  });

  test('claims a provider agents subtree whole, because that sync removes it first', () => {
    // Unlike skills and commands, syncRootOutputs rm -rf's the agents
    // destination before copying, so the build really does own everything
    // under it and an unrecognized name there is stale output, not a local file.
    const withAgents = Object.values(PROVIDERS).filter((p) => p.agentFormat);
    expect(withAgents.length).toBeGreaterThan(0);
    for (const { configDir } of withAgents) {
      expect(isGeneratedPath(`${configDir}/agents/impeccable-documenter.md`)).toBe(true);
      expect(isGeneratedPath(`${configDir}/agents/anything-else.md`)).toBe(true);
    }
  });

  test('claims the plugin subtree and each provider hook manifest', () => {
    expect(isGeneratedPath('plugin/skills/impeccable/SKILL.md')).toBe(true);
    expect(isGeneratedPath('plugin/hooks/post/impeccable.js')).toBe(true);
    expect(GENERATED_FILES.length).toBeGreaterThan(0);
    for (const file of GENERATED_FILES) expect(isGeneratedPath(file)).toBe(true);
  });

  test('ignores source, docs, and .codex skills', () => {
    // .codex is excluded from syncRootOutputs' skills/commands/agents loops;
    // only its hooks.json is generated, and that rides GENERATED_FILES.
    for (const file of [
      'skill/reference/audit.md',
      'crates/context/assets/omp-hook.js',
      'docs/CLI-CONTRACT.md',
      'scripts/build.js',
      'README.md',
      '.codex/skills/impeccable/SKILL.md',
      '.github/workflows/release-engine.yml',
      '.github/ISSUE_TEMPLATE/bug.md',
    ]) {
      expect(isGeneratedPath(file)).toBe(false);
    }
  });

  test('every prefix ends in a separator, so it cannot match a sibling by name', () => {
    // `.omp/agents` without the slash would also claim `.omp/agents-local/x`.
    for (const prefix of GENERATED_PREFIXES) expect(prefix.endsWith('/')).toBe(true);
  });
});

describe('parsePorcelainZ', () => {
  test('reads a path holding a space, which the quoted form corrupts', () => {
    // This is the case that shipped broken: line-oriented --porcelain reports
    // `?? ".omp/agents/custom agent.md"` with literal quote characters, and
    // slice(3) hands the filter a string starting with `"`, matching nothing.
    const paths = parsePorcelainZ(`?? .omp/agents/custom agent.md${NUL}`);
    expect(paths).toEqual(['.omp/agents/custom agent.md']);
    expect(paths.every(isGeneratedPath)).toBe(true);
  });

  test('keeps the leading space of an unstaged modification', () => {
    // The status column is a literal space for " M path", so the path starts
    // at index 3 exactly and the record must not be trimmed first.
    expect(parsePorcelainZ(` M plugin/hooks/post/impeccable.js${NUL}`)).toEqual([
      'plugin/hooks/post/impeccable.js',
    ]);
  });

  test('collects both ends of a rename from its two records', () => {
    // A rename spends a second record on the source path with no status
    // prefix. The old path is being removed and the new one written, so both
    // can be generated output and both have to be classified.
    const raw = `R  .omp/agents/new name.md${NUL}.omp/agents/impeccable-documenter.md${NUL} M skill/SKILL.src.md${NUL}`;
    expect(parsePorcelainZ(raw)).toEqual([
      '.omp/agents/new name.md',
      '.omp/agents/impeccable-documenter.md',
      'skill/SKILL.src.md',
    ]);
  });

  test('handles a copy the same way, and a rename that is the final record', () => {
    expect(parsePorcelainZ(`C  a/new.md${NUL}a/old.md${NUL}`)).toEqual(['a/new.md', 'a/old.md']);
    // A truncated stream must not throw or invent an undefined path.
    expect(parsePorcelainZ(`R  a/new.md${NUL}`)).toEqual(['a/new.md']);
  });

  test('does not treat R or C elsewhere in the record as a rename', () => {
    // The status is the first two characters only. A path beginning with `R`
    // must not swallow the record after it.
    const raw = `?? Recipes/notes.md${NUL}?? plugin/x.md${NUL}`;
    expect(parsePorcelainZ(raw)).toEqual(['Recipes/notes.md', 'plugin/x.md']);
  });

  test('is empty for a clean tree', () => {
    expect(parsePorcelainZ('')).toEqual([]);
  });
});
