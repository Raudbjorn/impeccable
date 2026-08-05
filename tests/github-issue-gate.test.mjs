import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  AI_LABEL,
  CLOSE_MARKER,
  GATE_LABEL,
  GATE_MARKER,
  REJECT_MARKER,
  evaluateComment,
  evaluateIssue,
  evaluateSweep,
  loadTemplates,
  parseArgs,
  proseWordCount,
} from '../scripts/github/issue-gate.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = '2026-08-05T12:00:00Z';

let templates;
before(() => {
  templates = loadTemplates(join(REPO_ROOT, '.github', 'ISSUE_TEMPLATE'));
});

const FILLED_BUG_BODY = `## What happened?

Running the detect command against a directory crashes with a TypeError.

## Steps to reproduce

1. Run \`npx impeccable detect src/\`
2. Watch it crash

## Expected behavior

A findings report.

## Provider & environment

- **Provider** (Cursor / Claude Code / Gemini CLI / Codex / Copilot / Kiro / OpenCode): Cursor
- **Provider version**: 2.4.0
- **OS**: macOS 15

## Additional context

None.
`;

function issue(overrides = {}) {
  return {
    number: 42,
    title: '[Bug] detect crashes on directories',
    body: FILLED_BUG_BODY,
    state: 'open',
    createdAt: '2026-08-01T00:00:00Z',
    authorLogin: 'outside-reporter',
    authorAssociation: 'NONE',
    labels: [],
    comments: [],
    ...overrides,
  };
}

function comment(authorLogin, createdAt, body) {
  return { authorLogin, createdAt, body };
}

function words(count) {
  return Array.from({ length: count }, (_, i) => `word${i}`).join(' ');
}

describe('issue gate templates', () => {
  it('derives required sections from the real templates', () => {
    const bug = templates.find((template) => template.file === 'bug_report.md');
    const feature = templates.find((template) => template.file === 'feature_request.md');
    assert.deepEqual(bug.requiredSections, ['what happened', 'steps to reproduce', 'provider & environment']);
    assert.deepEqual(feature.requiredSections, ['what problem does this solve', 'proposed solution']);
  });
});

describe('issue body gate', () => {
  it('passes a properly filled bug report', () => {
    const plan = evaluateIssue(issue(), { templates });
    assert.equal(plan.verdict, 'pass');
    assert.deepEqual(plan.reasons, []);
    assert.equal(plan.shouldComment, false);
    assert.equal(plan.shouldClose, false);
  });

  it('passes a properly filled feature request', () => {
    const plan = evaluateIssue(issue({
      body: [
        '## What problem does this solve?',
        '',
        'The audit command has no way to scope to one route.',
        '',
        '## Proposed solution',
        '',
        'Accept a path argument that narrows the audit to matching files.',
      ].join('\n'),
    }), { templates });
    assert.equal(plan.verdict, 'pass');
  });

  it('rejects and closes a body with no template sections at all', () => {
    const plan = evaluateIssue(issue({
      body: 'hey the tool is broken please fix asap. also add dark mode.',
    }), { templates });
    assert.equal(plan.verdict, 'reject');
    assert.deepEqual(plan.labelsToAdd, [GATE_LABEL]);
    assert.equal(plan.shouldClose, true);
    assert.equal(plan.shouldComment, true);
    assert.match(plan.comment, /none of the template sections/);
    assert.ok(plan.comment.includes(REJECT_MARKER));
  });

  it('flags untouched template placeholders as empty sections', () => {
    const bugTemplate = templates.find((template) => template.file === 'bug_report.md');
    const untouched = [...bugTemplate.scaffoldLines].length > 0;
    assert.ok(untouched);
    const plan = evaluateIssue(issue({
      body: [
        '## What happened?',
        '',
        '<!-- A clear description of the bug. -->',
        '',
        '## Steps to reproduce',
        '',
        '1. ',
        '2. ',
        '3. ',
        '',
        '## Provider & environment',
        '',
        '- **Provider** (Cursor / Claude Code / Gemini CLI / Codex / Copilot / Kiro / OpenCode):',
        '- **Provider version**: ',
        '- **OS**: ',
      ].join('\n'),
    }), { templates });
    assert.equal(plan.verdict, 'needs-work');
    assert.equal(plan.reasons.length, 3);
    assert.match(plan.reasons[0], /section "what happened" is empty/);
    assert.equal(plan.shouldClose, false);
    assert.deepEqual(plan.labelsToAdd, [GATE_LABEL]);
  });

  it('names a missing required section', () => {
    const plan = evaluateIssue(issue({
      body: [
        '## What happened?',
        '',
        'The build fails.',
        '',
        '## Provider & environment',
        '',
        '- **OS**: macOS 15 and provider Cursor 2.4.0',
      ].join('\n'),
    }), { templates });
    assert.equal(plan.verdict, 'needs-work');
    assert.deepEqual(plan.reasons, ['missing section "steps to reproduce" from the bug report template']);
  });

  it('flags an oversized prose body even when the structure passes', () => {
    const plan = evaluateIssue(issue({
      body: FILLED_BUG_BODY + '\n' + words(700),
    }), { templates });
    assert.equal(plan.verdict, 'needs-work');
    assert.equal(plan.reasons.length, 1);
    assert.match(plan.reasons[0], /the limit is 600/);
  });

  it('does not count fenced code blocks or details blocks against the budget', () => {
    const plan = evaluateIssue(issue({
      body: `${FILLED_BUG_BODY}\n\`\`\`\n${words(700)}\n\`\`\`\n<details><summary>log</summary>\n${words(700)}\n</details>\n`,
    }), { templates });
    assert.equal(plan.verdict, 'pass');
  });

  it('treats author sub-headings as section content, not section boundaries', () => {
    const plan = evaluateIssue(issue({
      body: [
        '## What happened?',
        '',
        'Install fails for the grok provider.',
        '',
        '## Steps to reproduce',
        '',
        '### A. Clean project',
        '',
        '1. Run `npx impeccable install --providers=grok`',
        '',
        '### B. Another provider already installed',
        '',
        '1. Seed a Claude install first, then run the same command.',
        '',
        '## Provider & environment',
        '',
        '- **OS**: macOS 15, CLI 4.0.4',
      ].join('\n'),
    }), { templates });
    assert.equal(plan.verdict, 'pass');
  });

  it('labels disclosed AI assistance without failing the issue', () => {
    const plan = evaluateIssue(issue({
      body: `AI-assisted: yes\n\n${FILLED_BUG_BODY}`,
    }), { templates });
    assert.equal(plan.verdict, 'pass');
    assert.equal(plan.aiAssisted, true);
    assert.deepEqual(plan.labelsToAdd, [AI_LABEL]);
  });

  it('exempts maintainers and repo members', () => {
    const maintainer = evaluateIssue(issue({ authorLogin: 'pbakaus', body: 'quick note' }), { templates });
    assert.equal(maintainer.exempt, true);
    const member = evaluateIssue(issue({ authorAssociation: 'COLLABORATOR', body: 'quick note' }), { templates });
    assert.equal(member.exempt, true);
  });

  it('comments only once per issue', () => {
    const plan = evaluateIssue(issue({
      body: 'no structure here',
      labels: [GATE_LABEL],
      comments: [comment('github-actions[bot]', '2026-08-01T01:00:00Z', REJECT_MARKER)],
      state: 'closed',
    }), { templates });
    assert.equal(plan.verdict, 'reject');
    assert.equal(plan.shouldComment, false);
    assert.equal(plan.shouldClose, false);
    assert.deepEqual(plan.labelsToAdd, []);
  });

  it('ignores gate markers posted by untrusted commenters', () => {
    const plan = evaluateIssue(issue({
      body: 'no structure here',
      comments: [comment('drive-by', '2026-08-01T01:00:00Z', REJECT_MARKER)],
    }), { templates });
    assert.equal(plan.shouldComment, true);
  });

  it('clears the label and reopens a gate-closed issue once it passes', () => {
    const plan = evaluateIssue(issue({
      state: 'closed',
      labels: [GATE_LABEL],
      comments: [comment('github-actions[bot]', '2026-08-01T01:00:00Z', REJECT_MARKER)],
    }), { templates });
    assert.equal(plan.verdict, 'pass');
    assert.deepEqual(plan.labelsToRemove, [GATE_LABEL]);
    assert.equal(plan.shouldReopen, true);
  });

  it('does not reopen issues the gate did not close', () => {
    const plan = evaluateIssue(issue({
      state: 'closed',
      labels: [GATE_LABEL],
    }), { templates });
    assert.equal(plan.shouldReopen, false);
  });
});

describe('sweep', () => {
  it('closes an issue still failing five days after the warning', () => {
    const plan = evaluateSweep(issue({
      body: 'still no structure',
      labels: [GATE_LABEL],
      comments: [comment('github-actions[bot]', '2026-07-30T12:00:00Z', GATE_MARKER)],
    }), { templates, now: NOW });
    assert.equal(plan.shouldSweepClose, false);

    const oversized = evaluateSweep(issue({
      body: FILLED_BUG_BODY + '\n' + words(700),
      labels: [GATE_LABEL],
      comments: [comment('github-actions[bot]', '2026-07-30T12:00:00Z', GATE_MARKER)],
    }), { templates, now: NOW });
    assert.equal(oversized.shouldSweepClose, true);
    assert.match(oversized.sweepComment, /failing for 6 days/);
    assert.ok(oversized.sweepComment.includes(CLOSE_MARKER));
  });

  it('does not close before the warning has aged past close-days', () => {
    const plan = evaluateSweep(issue({
      body: FILLED_BUG_BODY + '\n' + words(700),
      labels: [GATE_LABEL],
      comments: [comment('github-actions[bot]', '2026-08-03T12:00:00Z', GATE_MARKER)],
    }), { templates, now: NOW });
    assert.equal(plan.shouldSweepClose, false);
  });

  it('lets a fixed issue pass instead of closing it', () => {
    const plan = evaluateSweep(issue({
      labels: [GATE_LABEL],
      comments: [comment('github-actions[bot]', '2026-07-25T12:00:00Z', GATE_MARKER)],
    }), { templates, now: NOW });
    assert.equal(plan.verdict, 'pass');
    assert.equal(plan.shouldSweepClose, false);
    assert.deepEqual(plan.labelsToRemove, [GATE_LABEL]);
  });
});

describe('comment gate', () => {
  const base = {
    commentAuthorLogin: 'outside-reporter',
    commentAuthorAssociation: 'NONE',
    issueAuthorLogin: 'outside-reporter',
    issueCreatedAt: '2026-08-05T10:00:00Z',
    commentCreatedAt: '2026-08-05T10:10:00Z',
  };

  it('minimizes an oversized early self-reply', () => {
    const result = evaluateComment({ ...base, commentBody: words(400) });
    assert.equal(result.shouldMinimize, true);
    assert.match(result.reasons[0], /400 words of prose/);
  });

  it('leaves short self-replies alone', () => {
    const result = evaluateComment({ ...base, commentBody: 'Forgot to say: version 2.4.0.' });
    assert.equal(result.shouldMinimize, false);
  });

  it('leaves long comments from other participants alone', () => {
    const result = evaluateComment({
      ...base,
      commentAuthorLogin: 'helpful-stranger',
      commentBody: words(400),
    });
    assert.equal(result.shouldMinimize, false);
  });

  it('leaves late self-replies alone', () => {
    const result = evaluateComment({
      ...base,
      commentCreatedAt: '2026-08-05T12:30:00Z',
      commentBody: words(400),
    });
    assert.equal(result.shouldMinimize, false);
  });

  it('does not count pasted logs against the comment budget', () => {
    const result = evaluateComment({
      ...base,
      commentBody: `Full log below.\n\`\`\`\n${words(900)}\n\`\`\``,
    });
    assert.equal(result.shouldMinimize, false);
  });

  it('exempts maintainers and members', () => {
    const maintainer = evaluateComment({
      ...base,
      commentAuthorLogin: 'abdulwahabone',
      issueAuthorLogin: 'abdulwahabone',
      commentBody: words(400),
    });
    assert.equal(maintainer.shouldMinimize, false);
    const member = evaluateComment({
      ...base,
      commentAuthorAssociation: 'MEMBER',
      commentBody: words(400),
    });
    assert.equal(member.shouldMinimize, false);
  });
});

describe('helpers', () => {
  it('counts prose words outside code and details blocks', () => {
    assert.equal(proseWordCount('one two three'), 3);
    assert.equal(proseWordCount('one\n```\nskip these words\n```\ntwo'), 2);
    assert.equal(proseWordCount('one <details>skip skip</details> two'), 2);
    assert.equal(proseWordCount('<!-- skip --> one'), 1);
  });

  it('parses workflow arguments', () => {
    const options = parseArgs(['--apply', '--repo', 'pbakaus/impeccable', '--issue', '42', '--comment-id', '99']);
    assert.equal(options.apply, true);
    assert.equal(options.issue, 42);
    assert.equal(options.commentId, '99');

    assert.throws(() => parseArgs(['--max-words', '0']), /positive/);
    assert.throws(() => parseArgs(['--unknown']), /Unknown argument/);
  });
});
