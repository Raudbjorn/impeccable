import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  AI_LABEL,
  GATE_LABEL,
  GATE_MARKER,
  REJECT_MARKER,
  evaluateComment,
  evaluateIssue,
  loadTemplates,
  parseArgs,
  skipIfPullRequest,
  proseWordCount,
} from '../scripts/github/issue-gate.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

## How did you run impeccable?

Via \`npx impeccable detect\` as documented.

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

