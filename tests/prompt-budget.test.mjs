/**
 * Context budget for the always-resident prompt surface.
 *
 * SKILL.md is loaded into every session that touches this skill, so its size
 * is paid on every run whether or not a command is invoked. The frontmatter
 * `description` is paid even harder: harnesses list it in the system prompt
 * for skill selection, so it competes with every other installed skill.
 *
 * These ceilings are a ratchet, not a target. They are set just above the
 * current rendered size: adding to SKILL.md is meant to require a deliberate
 * decision to raise a number, and paying prose down should lower it. The
 * assertions render provider output straight from source into a temp
 * directory rather than reading committed harness snapshots, so a
 * SKILL.src.md or transformer change is caught here, before a release build
 * regenerates the tracked copies.
 *
 * If one of these fails, the question is not "what is the new number" but
 * "does this belong in the always-resident file, or in a reference the router
 * loads only when it applies".
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSourceFiles, readPatterns } from '../scripts/lib/utils.js';
import { createTransformer, PROVIDERS } from '../scripts/lib/transformers/index.js';
import { rewritePluginMarkdownTree } from '../scripts/lib/plugin-paths.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Raise deliberately, with the reason in the commit message.
const SKILL_MD_MAX_BYTES = 12_300;
const DESCRIPTION_MAX_BYTES = 1_400;

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-prompt-budget-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const { skills } = readSourceFiles(ROOT);
const patterns = readPatterns(ROOT);

// Render straight from source: the claude-code and omp variants come from
// their own transformer, and the plugin variant is built the same way
// build.js builds it (copy the claude-code output, then apply the plugin
// markdown rewrite) rather than a second hand-rolled render path.
createTransformer(PROVIDERS['claude-code'])(skills, tmpRoot, patterns);
createTransformer(PROVIDERS.omp)(skills, tmpRoot, patterns);

const claudeSkillDir = path.join(tmpRoot, 'claude-code', '.claude', 'skills', 'impeccable');
const pluginSkillDir = path.join(tmpRoot, 'plugin', 'skills', 'impeccable');
fs.mkdirSync(path.dirname(pluginSkillDir), { recursive: true });
fs.cpSync(claudeSkillDir, pluginSkillDir, { recursive: true });
rewritePluginMarkdownTree(pluginSkillDir);

// One representative per emission shape rather than all ten: the placeholder
// substitutions differ, the body does not.
const RENDERED_SKILLS = [
  path.join(claudeSkillDir, 'SKILL.md'),
  path.join(tmpRoot, 'omp', '.omp', 'skills', 'impeccable', 'SKILL.md'),
  path.join(pluginSkillDir, 'SKILL.md'),
];

function frontmatterDescription(text) {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  assert.ok(match, 'SKILL.md must open with YAML frontmatter');
  const line = match[1].split('\n').find((entry) => entry.startsWith('description:'));
  assert.ok(line, 'SKILL.md frontmatter must carry a description');
  return line.slice('description:'.length).trim();
}

describe('prompt budget', () => {
  for (const abs of RENDERED_SKILLS) {
    const rel = path.relative(tmpRoot, abs);
    it(`${rel} stays inside the always-resident budget`, () => {
      assert.ok(fs.existsSync(abs), `${rel} was not rendered; the transformer output shape changed`);
      const text = fs.readFileSync(abs, 'utf-8');

      assert.ok(
        Buffer.byteLength(text) <= SKILL_MD_MAX_BYTES,
        `${rel} is ${Buffer.byteLength(text)} bytes, over the ${SKILL_MD_MAX_BYTES} ceiling. `
        + 'Move what does not need to be resident into a reference file, or raise the ceiling on purpose.',
      );

      const description = frontmatterDescription(text);
      assert.ok(
        Buffer.byteLength(description) <= DESCRIPTION_MAX_BYTES,
        `${rel}'s description is ${Buffer.byteLength(description)} bytes, over the ${DESCRIPTION_MAX_BYTES} ceiling. `
        + 'It is listed in the system prompt of every session, alongside every other installed skill.',
      );
    });
  }
});
