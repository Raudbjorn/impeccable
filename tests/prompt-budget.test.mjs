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
 * assertions measure RENDERED provider output rather than the source, so a
 * transformer that inflates the shipped file is caught even when the source
 * is unchanged.
 *
 * If one of these fails, the question is not "what is the new number" but
 * "does this belong in the always-resident file, or in a reference the router
 * loads only when it applies".
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Raise deliberately, with the reason in the commit message.
const SKILL_MD_MAX_BYTES = 11_500;
const DESCRIPTION_MAX_BYTES = 1_400;

// One representative per emission shape rather than all ten: the placeholder
// substitutions differ, the body does not.
const RENDERED_SKILLS = [
  '.claude/skills/impeccable/SKILL.md',
  '.omp/skills/impeccable/SKILL.md',
  'plugin/skills/impeccable/SKILL.md',
];

function frontmatterDescription(text) {
  const match = /^---\n([\s\S]*?)\n---/.exec(text);
  assert.ok(match, 'SKILL.md must open with YAML frontmatter');
  const line = match[1].split('\n').find((entry) => entry.startsWith('description:'));
  assert.ok(line, 'SKILL.md frontmatter must carry a description');
  return line.slice('description:'.length).trim();
}

describe('prompt budget', () => {
  for (const rel of RENDERED_SKILLS) {
    it(`${rel} stays inside the always-resident budget`, () => {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) return; // provider output not built in this checkout
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
