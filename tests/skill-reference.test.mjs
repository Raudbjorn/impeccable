import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('skill reference authoring contracts', () => {
  it('keeps direction contracts in development-only surface briefs', () => {
    const newWork = readFileSync(join(ROOT, 'skill/reference/new-work.md'), 'utf-8').replace(/\r\n?/g, '\n');
    const recordDecision = newWork.match(/## 5\. Record the decision\n([\s\S]*?)\n## 6\./)?.[1] ?? '';

    assert.match(recordDecision, /development-only contract/);
    assert.match(recordDecision, /under `## Direction contract` in the relevant surface brief/);
    assert.match(recordDecision, /read the brief once more/i);
    assert.match(recordDecision, /all six contract blocks and the seed key/);

    for (const block of ['THESIS', 'OWN-WORLD', 'STORY', 'FIRST VIEWPORT', 'FORM', 'FINISH']) {
      assert.match(recordDecision, new RegExp(`${block}:`));
    }

    for (const browserArtifact of [
      /HTML or framework comments/,
      /hidden DOM/,
      /<template>/,
      /`data-\*` attributes/,
      /serialized props or state/,
      /React Server Component payloads/,
      /client bundles/,
      /metadata or JSON-LD/,
      /accessibility-only text/,
    ]) {
      assert.match(recordDecision, browserArtifact);
    }

    assert.match(recordDecision, /Never copy the direction contract into implementation source or any browser-delivered artifact/);
    assert.doesNotMatch(newWork, /contract in the artifact's opening comment/);
    assert.doesNotMatch(newWork, /survives the production build/);
    assert.doesNotMatch(newWork, /grep the built output/);
    assert.doesNotMatch(newWork, /emitted markup/);
    assert.doesNotMatch(newWork, /first child of the document's body/);
  });

  it('keeps reduced-motion guidance on the animation build path', () => {
    const animate = readFileSync(join(ROOT, 'skill/reference/animate.md'), 'utf-8').replace(/\r\n?/g, '\n');
    const accessibility = animate.match(/## Accessibility and control\n([\s\S]*?)\n## Verify/)?.[1] ?? '';
    const verify = animate.match(/## Verify\n([\s\S]*?)(?:\n## |$)/)?.[1] ?? '';

    assert.match(accessibility, /prefers-reduced-motion/);
    assert.match(accessibility, /intentional alternative/);
    assert.match(accessibility, /not disabling all motion/);
    assert.match(verify, /reduced[- ]motion/i);
  });

  it('uses an exact content fingerprint before inheriting a critique snapshot', () => {
    const critique = readFileSync(join(ROOT, 'skill/reference/critique.md'), 'utf-8').replace(/\r\n?/g, '\n');
    const polish = readFileSync(join(ROOT, 'skill/reference/polish.md'), 'utf-8').replace(/\r\n?/g, '\n');

    assert.match(critique, /records an exact content fingerprint/);
    assert.match(polish, /compares the file's exact current content fingerprint/);
    assert.match(polish, /Unchanged staged, unstaged, or untracked content remains current/);
    assert.match(polish, /any byte change, deletion, or replacement with a non-file closes the backlog/);
    assert.match(polish, /latest "<resolved target>" --json/);
    assert.match(polish, /exact `snapshot_file` identity/);
    assert.match(polish, /close "<resolved target>" "<snapshot_file returned by latest>"/);
    assert.match(polish, /if a newer critique landed meanwhile, its backlog stays live/);
    assert.doesNotMatch(polish, /git status|git log/);
  });

  // Regression: craft-floor.md's cultural-symbol-palette rule
  // (<!-- rule:skill-reflex-cultural-palette -->) is the short reflex a
  // model reads right before editing UI; its explicit-brief override only
  // lives in visual-cues.md's fuller PALETTE RULES section. Nothing ties
  // the two together, so an edit to either file can silently drop the
  // override -- craft-floor.md's own line names no exception at all -- and
  // the reflex hardens into a rule with no escape hatch for a client's own
  // documented palette. This does not verify a model actually follows the
  // rule (that needs a real LLM call; see tests/skill-behavior's scenario
  // 16), only that the two files still agree the override exists.
  it('keeps the cultural-symbol-palette rule paired with its explicit-brief override', () => {
    const craftFloor = readFileSync(join(ROOT, 'skill/reference/craft-floor.md'), 'utf-8').replace(/\r\n?/g, '\n');
    const visualCues = readFileSync(join(ROOT, 'skill/reference/visual-cues.md'), 'utf-8').replace(/\r\n?/g, '\n');

    assert.match(
      craftFloor,
      /cultural-symbol palette[\s\S]{0,300}<!-- rule:skill-reflex-cultural-palette -->/,
      'craft-floor.md must still carry the cultural-symbol-palette reflex rule and its marker',
    );
    assert.match(
      visualCues,
      /cultural-symbol palette/,
      'visual-cues.md must still state the same rule in its PALETTE RULES section',
    );
    assert.match(
      visualCues,
      /explicit brief[\s\S]{0,20}names the cultural palette overrides this rule/,
      'visual-cues.md must still carry the explicit-brief override -- craft-floor.md names no exception at all, so this is the only place it lives',
    );
  });
});
