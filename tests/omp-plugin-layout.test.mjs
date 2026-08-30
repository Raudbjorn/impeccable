/**
 * The committed ./plugin subtree against oh-my-pi's documented plugin layout.
 *
 * oh-my-pi installs plugins via `omp plugin marketplace add <owner/repo>` and
 * reads `.omp-plugin/plugin.json` first, falling back to
 * `.claude-plugin/plugin.json`. Its expected tree is `skills/<name>/SKILL.md`,
 * `agents/`, `commands/`, `hooks/pre|post/`, `tools/`. Skills from that channel
 * are discovered at priority 90, second only to a native `.omp` install.
 *
 * We do not ship a separate `.omp-plugin` manifest: the Claude one is read as
 * the documented fallback, and a second manifest would be one more artifact to
 * keep in sync for no behavior difference.
 *
 * This is a structural check against a layout read from oh-my-pi's docs, not
 * evidence that a real `omp` install works. That is what
 * docs/OH-MY-PI-LIVE-TEST.md exists to establish.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = path.join(ROOT, 'plugin');

describe('plugin subtree as an oh-my-pi plugin', () => {
  it('carries a manifest oh-my-pi can read, pointing at a skills directory', () => {
    const manifestPath = path.join(PLUGIN, '.claude-plugin', 'plugin.json');
    assert.ok(fs.existsSync(manifestPath), 'oh-my-pi falls back to .claude-plugin/plugin.json');

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    assert.equal(typeof manifest.name, 'string');
    assert.equal(typeof manifest.description, 'string');
    assert.ok(manifest.skills, 'the manifest must name a skills directory');

    const skillsDir = path.join(PLUGIN, manifest.skills.replace(/^\.\//, ''));
    assert.ok(fs.existsSync(skillsDir), `${manifest.skills} must exist in the subtree`);
  });

  it('lays skills out one directory deep, which is all oh-my-pi scans', () => {
    // Discovery is <skills-root>/<skill-name>/SKILL.md and is NOT recursive:
    // a nested group directory is silently invisible rather than an error.
    const skillsDir = path.join(PLUGIN, 'skills');
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    assert.ok(entries.length > 0, 'the subtree must ship at least one skill');

    for (const entry of entries) {
      const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
      assert.ok(fs.existsSync(skillMd), `${entry.name}/SKILL.md must sit one level down, not nested deeper`);
      const text = fs.readFileSync(skillMd, 'utf-8');
      // oh-my-pi requires a description for plugin-sourced skills; without it
      // the skill loads but is never selected.
      assert.match(text, /^---\n[\s\S]*?\ndescription:/m, `${entry.name} needs a frontmatter description`);
    }
  });

  it('records that plugin-channel agents carry a Claude-only path form', () => {
    // Known limitation, asserted so it cannot regress into a surprise: the
    // plugin agents resolve scripts against ${CLAUDE_PLUGIN_ROOT}, which
    // oh-my-pi does not substitute. A native .omp/agents install (built by
    // the omp-md agent format) is the supported path there.
    const agentsDir = path.join(PLUGIN, 'agents');
    if (!fs.existsSync(agentsDir)) return;
    const agents = fs.readdirSync(agentsDir).filter((name) => name.endsWith('.md'));
    assert.ok(agents.length > 0);
    const sample = fs.readFileSync(path.join(agentsDir, agents[0]), 'utf-8');
    assert.match(
      sample,
      /\$\{CLAUDE_PLUGIN_ROOT\}/,
      'if this stops holding, revisit whether the plugin channel can carry agents for oh-my-pi',
    );
  });
});
