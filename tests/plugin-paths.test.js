/**
 * Unit coverage for the plugin subtree script-path rewrite (issue #523).
 *
 * The ./plugin subtree copies the dist/claude-code output, whose
 * {{scripts_path}} resolves to the project-relative
 * `.claude/skills/impeccable/scripts`. Run from the plugin cache, that path
 * points into the user's project: a plugin-only user gets MODULE_NOT_FOUND,
 * and a dual-install user silently runs the project's older skill copy. The
 * rewrite swaps every markdown instruction to the `<skill-base-dir>` form
 * and drops the node pre-approval: no frontmatter rule can bind approval to
 * the loaded plugin root, and an unbound wildcard would auto-approve any
 * same-shaped path anywhere on disk.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  rewritePluginMarkdown,
  rewritePluginAgentMarkdown,
  rewritePluginMarkdownTree,
  verifyPluginSkillRewrite,
  verifyPluginAgentRewrite,
  CLAUDE_PROJECT_SCRIPTS_PATH,
  AGENT_EMBED_FALLBACK,
  AGENT_PATH_NOTE,
} from '../scripts/lib/plugin-paths.js';

describe('rewritePluginMarkdown', () => {
  test('rewrites a script instruction to the quoted skill-base-dir form', () => {
    const input = 'Run `node .claude/skills/impeccable/scripts/context.mjs` once per session.';
    expect(rewritePluginMarkdown(input)).toBe(
      'Run `node "<skill-base-dir>/scripts/context.mjs"` once per session.',
    );
  });

  test('rewrites every occurrence, quoting the script path but not the arguments', () => {
    const input = [
      'node .claude/skills/impeccable/scripts/live.mjs',
      'node .claude/skills/impeccable/scripts/live-poll.mjs --reply EVENT_ID done',
    ].join('\n');
    const output = rewritePluginMarkdown(input);
    expect(output).not.toContain(CLAUDE_PROJECT_SCRIPTS_PATH);
    expect(output).toContain('node "<skill-base-dir>/scripts/live.mjs"');
    expect(output).toContain('node "<skill-base-dir>/scripts/live-poll.mjs" --reply EVENT_ID done');
  });

  test('quotes the engine launcher path and leaves the verb outside the quotes', () => {
    const output = rewritePluginMarkdown(
      'Run `<skill-base-dir>/scripts/impeccable context` once, then `<skill-base-dir>/scripts/impeccable.cmd doctor --json`; ' +
      'already quoted: `"<skill-base-dir>/scripts/impeccable" hooks on`.',
    );
    expect(output).toContain('`"<skill-base-dir>/scripts/impeccable" context`');
    expect(output).toContain('`"<skill-base-dir>/scripts/impeccable.cmd" doctor --json`');
    expect(output).not.toContain('""<skill-base-dir>');
  });

  test('quotes commands already in the skill-base-dir form without double-quoting', () => {
    // SKILL.src.md's Setup step 1 carries the token form natively; a base
    // directory with spaces splits an unquoted path before node sees it.
    const input =
      'Run `node <skill-base-dir>/scripts/context.mjs` once per session. ' +
      'Already quoted: `node "<skill-base-dir>/scripts/detect.mjs"`.';
    expect(rewritePluginMarkdown(input)).toBe(
      'Run `node "<skill-base-dir>/scripts/context.mjs"` once per session. ' +
      'Already quoted: `node "<skill-base-dir>/scripts/detect.mjs"`.',
    );
  });

  test('removes the node pre-approval instead of widening it', () => {
    const frontmatter = [
      'allowed-tools:',
      '  - Bash(npx impeccable *)',
      '  - Bash(.claude/skills/impeccable/scripts/impeccable *)',
      '---',
      '',
    ].join('\n');
    const output = rewritePluginMarkdown(frontmatter);
    // The generic path rewrite alone would leave Bash(<skill-base-dir>/scripts/impeccable *),
    // a dead literal, and any wildcard replacement would auto-approve
    // same-shaped paths outside the plugin. The line must go entirely.
    expect(output).not.toContain('scripts/impeccable *');
    expect(output).toContain('  - Bash(npx impeccable *)\n---');
  });

  test('drops the project-path fallback clause from Setup step 1', () => {
    const input =
      '1. Run `node <skill-base-dir>/scripts/context.mjs` once per session, where `<skill-base-dir>` is the ' +
      "loaded base directory the runtime reports for this skill; keep cwd at the user's project. " +
      'That base directory resolves every `.claude/skills/impeccable/scripts/impeccable <verb>` command in this skill ' +
      'and its references, and `.claude/skills/impeccable/scripts` is the fallback only when the runtime ' +
      'reports no base directory. Pass a named source file or route as `--target <path>`.';
    const output = rewritePluginMarkdown(input);
    expect(output).toContain(
      'Every `"<skill-base-dir>/scripts/impeccable" <verb>` command in this skill and its references resolves against that base directory.',
    );
    // The naive rewrite would keep the fallback clause and name the token as
    // its own fallback for when there is no base directory to resolve it.
    expect(output).not.toContain('fallback');
    expect(output).not.toContain(CLAUDE_PROJECT_SCRIPTS_PATH);
  });

  test('leaves unrelated project-relative paths alone', () => {
    const input = 'State lives in `.impeccable/live/roots.json` and `.claude/settings.json`.';
    expect(rewritePluginMarkdown(input)).toBe(input);
  });
});

describe('rewritePluginAgentMarkdown', () => {
  // The real source sentence shape: command, purpose clause, next sentence.
  const sourceStep =
    'after every generation, run `node .claude/skills/impeccable/scripts/embed-prompt.mjs <asset> ' +
    '--prompt "<the prompt used>"` so the prompt lives inside the image itself. The build thread ' +
    'composes what you made.';

  test('rewrites agent instructions to the quoted plugin-root variable form', () => {
    // A spawned agent never loads SKILL.md, so the <skill-base-dir> token
    // Setup defines is unresolvable in its prompt. Claude Code substitutes
    // ${CLAUDE_PLUGIN_ROOT} inline in plugin agent content.
    const output = rewritePluginAgentMarkdown(sourceStep);
    expect(output).toContain(
      'run `node "${CLAUDE_PLUGIN_ROOT}/skills/impeccable/scripts/embed-prompt.mjs" <asset> --prompt "<the prompt used>"`',
    );
  });

  test('appends the sidecar fallback as its own sentence, not mid-sentence', () => {
    const output = rewritePluginAgentMarkdown(sourceStep);
    // The fallback follows the full embed sentence and precedes the next one.
    expect(output).toContain(
      `so the prompt lives inside the image itself.${AGENT_EMBED_FALLBACK} The build thread`,
    );
  });

  test('never emits the skill-base-dir token into an agent file', () => {
    const output = rewritePluginAgentMarkdown(sourceStep);
    expect(output).not.toContain('<skill-base-dir>');
    expect(output).not.toContain(CLAUDE_PROJECT_SCRIPTS_PATH);
  });

  test('closes the file with the path note, exactly once', () => {
    // The plugin subtree ships two path forms on purpose. A reader who only
    // ever opens plugin/agents/*.md sees no reason for the difference, and
    // reads it as drift against the skill references (review finding).
    const output = rewritePluginAgentMarkdown(sourceStep);
    expect(output).toContain(AGENT_PATH_NOTE.trim());
    expect(output.split('Script paths above resolve').length - 1).toBe(1);
    expect(output.endsWith(AGENT_PATH_NOTE)).toBe(true);
  });

  test('the path note survives verifyPluginAgentRewrite', () => {
    // The note explains the skill-base-dir contrast without naming the token,
    // because the verifier rejects that string in an agent file. Naming it
    // would fail the build on the note itself.
    const output = rewritePluginAgentMarkdown(sourceStep);
    const notePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-agent-note-')), 'agent.md');
    fs.writeFileSync(notePath, output);
    expect(() => verifyPluginAgentRewrite(notePath)).not.toThrow();
  });

  test('does not add the path note to skill reference files', () => {
    expect(rewritePluginMarkdown(sourceStep)).not.toContain('Script paths above resolve');
  });
});

describe('verifyPluginAgentRewrite', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-agent-verify-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const writeAgent = (contents) => {
    const p = path.join(root, 'agent.md');
    fs.writeFileSync(p, contents);
    return p;
  };

  const sourceStep =
    'run `node .claude/skills/impeccable/scripts/embed-prompt.mjs <asset> --prompt "<p>"` ' +
    'so the prompt lives inside the image itself. Next sentence.';

  test('accepts a correctly rewritten agent file', () => {
    const p = writeAgent(rewritePluginAgentMarkdown(sourceStep));
    expect(() => verifyPluginAgentRewrite(p)).not.toThrow();
  });

  test('fails when an unresolvable path form survives', () => {
    const p = writeAgent('run `node "<skill-base-dir>/scripts/embed-prompt.mjs"` please.');
    expect(() => verifyPluginAgentRewrite(p)).toThrow(/cannot\s+resolve/);
  });

  test('fails when the embed instruction lost its fallback sentence', () => {
    // Simulate a source rewording that breaks the fallback anchor: the
    // sentence-splice regex no-ops when no period follows the command.
    const reworded = sourceStep.replace(
      ' so the prompt lives inside the image itself. Next sentence.',
      ' -- no closing period',
    );
    const p = writeAgent(rewritePluginAgentMarkdown(reworded));
    expect(() => verifyPluginAgentRewrite(p)).toThrow(/sidecar/);
  });
  test('rejects a script path a replacement truncated mid-command', () => {
    // The embed fallback anchors on "closing backtick, then up to the first
    // period". A second `node ...` command in the same sentence puts that
    // period inside its own `.mjs`, so the fallback lands mid-command and
    // eats the script name. The fallback is still present, so the check for
    // it passes; only a path-shape check catches this.
    const file = path.join(root, 'truncated.md');
    fs.writeFileSync(
      file,
      'run `node "${CLAUDE_PLUGIN_ROOT}/skills/impeccable/scripts/embed-prompt.mjs" <a>`, then '
      + '`node "${CLAUDE_PLUGIN_ROOT}/skills/impeccable/scripts/generate-image.'
      + AGENT_EMBED_FALLBACK,
    );
    expect(() => verifyPluginAgentRewrite(file)).toThrow(/truncated script path/);
  });

  test('asset producer keeps cwd at the project root (no cd into scripts path)', () => {
    // The asset producer (and any future agent) must use the resolved
    // scripts path only as the prefix of every `impeccable <verb>` command.
    // A `cd` (or any other cwd change) into the plugin cache would make
    // `.impeccable/...` paths and comp/plate file locations resolve under
    // the plugin directory instead of the consuming project root, which
    // would silently break every script the agent runs. Read the real
    // source agent file (after the rewrite pipeline runs, the committed
    // plugin copy carries the same contract): the input-contract paragraph
    // must say so verbatim, and the step list must not say to cd.
    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const srcPath = path.join(ROOT, 'skill/agents/impeccable-asset-producer.md');
    const committedPath = path.join(ROOT, 'plugin/agents/impeccable-asset-producer.md');
    expect(fs.existsSync(srcPath)).toBe(true);
    const src = fs.readFileSync(srcPath, 'utf-8');
    expect(src).toContain('only as the prefix of every `impeccable <verb>` command');
    expect(src).toContain('do not `cd` into it');
    expect(src).toContain('stays at the consuming project root');
    expect(src).not.toMatch(/Run every `node ...` command below from that scripts path/);
    // The committed plugin copy carries the same cwd contract after the
    // rewrite pipeline runs; the source agent file is the input and the
    // committed copy is the artifact, and they MUST agree. If the
    // committed copy is ever missing, that is itself a contract failure
    // (a generated-output drift must not be silently absorbed) — assert
    // its existence up front, then assert the same wording against both.
    expect(fs.existsSync(committedPath)).toBe(true);
    const committed = fs.readFileSync(committedPath, 'utf-8');
    expect(committed).toContain('only as the prefix of every `impeccable <verb>` command');
    expect(committed).toContain('do not `cd` into it');
    expect(committed).toContain('stays at the consuming project root');
    expect(committed).not.toMatch(/Run every `node ...` command below from that scripts path/);
  });
});

describe('rewritePluginMarkdownTree', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-plugin-paths-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('rewrites .md files recursively and leaves scripts untouched', () => {
    const write = (rel, contents) => {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, contents);
    };
    write('SKILL.md', 'Run `node .claude/skills/impeccable/scripts/context.mjs`.');
    write('reference/live.md', 'node .claude/skills/impeccable/scripts/live.mjs');
    // hook-admin.mjs installs project-scoped hooks; its project path is correct.
    write(
      'scripts/hook-admin.mjs',
      'const cmd = \'node "${CLAUDE_PROJECT_DIR}/.claude/skills/impeccable/scripts/hook.mjs"\';',
    );

    rewritePluginMarkdownTree(root);

    expect(fs.readFileSync(path.join(root, 'SKILL.md'), 'utf-8')).toBe(
      'Run `node "<skill-base-dir>/scripts/context.mjs"`.',
    );
    expect(fs.readFileSync(path.join(root, 'reference/live.md'), 'utf-8')).toBe(
      'node "<skill-base-dir>/scripts/live.mjs"',
    );
    expect(fs.readFileSync(path.join(root, 'scripts/hook-admin.mjs'), 'utf-8')).toContain(
      '${CLAUDE_PROJECT_DIR}/.claude/skills/impeccable/scripts/hook.mjs',
    );
  });

  test('applies the agent rewrite when passed for an agents tree', () => {
    const agentsDir = path.join(root, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, 'impeccable-asset-producer.md'),
      'run `node .claude/skills/impeccable/scripts/embed-prompt.mjs <asset>`',
    );

    rewritePluginMarkdownTree(agentsDir, rewritePluginAgentMarkdown);

    expect(fs.readFileSync(path.join(agentsDir, 'impeccable-asset-producer.md'), 'utf-8')).toBe(
      'run `node "${CLAUDE_PLUGIN_ROOT}/skills/impeccable/scripts/embed-prompt.mjs" <asset>`'
      + AGENT_PATH_NOTE,
    );
  });

  test('is a no-op on a missing directory', () => {
    expect(() => rewritePluginMarkdownTree(path.join(root, 'does-not-exist'))).not.toThrow();
  });
});

describe('verifyPluginSkillRewrite', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-plugin-verify-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const writeSkill = (contents) => {
    const p = path.join(root, 'SKILL.md');
    fs.writeFileSync(p, contents);
    return p;
  };

  const goodSkill = [
    'allowed-tools:',
    '  - Bash(.claude/skills/impeccable/scripts/impeccable *)',
    '',
    '1. Run `<skill-base-dir>/scripts/impeccable context` once per session, where `<skill-base-dir>` is the ' +
      "loaded base directory the runtime reports for this skill; keep cwd at the user's project. " +
      'That base directory resolves every `.claude/skills/impeccable/scripts/impeccable <verb>` command in this skill ' +
      'and its references, and `.claude/skills/impeccable/scripts` is the fallback only when the runtime ' +
      'reports no base directory.',
  ].join('\n');

  test('accepts a correctly rewritten SKILL.md', () => {
    const p = writeSkill(rewritePluginMarkdown(goodSkill));
    expect(() => verifyPluginSkillRewrite(p)).not.toThrow();
  });

  test('fails the build when the Setup fallback sentence no longer matched', () => {
    // Simulate SKILL.src.md rewording step 1: the sentence replacement
    // no-ops, so the plugin copy keeps the project path as its fallback.
    const reworded = goodSkill.replace('is the fallback only when', 'is used only when');
    const p = writeSkill(rewritePluginMarkdown(reworded));
    expect(() => verifyPluginSkillRewrite(p)).toThrow(/Setup step 1 fallback sentence/);
  });

  test('fails the build when a launcher pre-approval survives the removal', () => {
    const reworded = goodSkill.replace(
      'Bash(.claude/skills/impeccable/scripts/impeccable *)',
      'Bash(.claude/skills/impeccable/scripts/impeccable.cmd *)',
    );
    const p = writeSkill(rewritePluginMarkdown(reworded));
    expect(() => verifyPluginSkillRewrite(p)).toThrow(/pre-approves an engine launcher/);
  });

  test('fails the build when a legacy node pre-approval survives', () => {
    // The Node-era line is gone from SKILL.src.md, but a copy that still
    // carries one must fail the same way as a surviving launcher line.
    const p = writeSkill(
      rewritePluginMarkdown(goodSkill).replace(
        'allowed-tools:\n',
        'allowed-tools:\n  - Bash(node <skill-base-dir>/scripts/*)\n',
      ),
    );
    expect(() => verifyPluginSkillRewrite(p)).toThrow(/pre-approves an engine launcher or node script path/);
  });

  test('fails the build when the project-relative scripts path survives at all', () => {
    // Simulate a path shape the replacements don't know: the rewritten copy
    // still names the project scripts directory somewhere new.
    const p = writeSkill(
      rewritePluginMarkdown(goodSkill) +
      '\nState lives next to `.claude/skills/impeccable/scripts` on disk.',
    );
    expect(() => verifyPluginSkillRewrite(p)).toThrow(/still contains the project-relative scripts path/);
  });
});
