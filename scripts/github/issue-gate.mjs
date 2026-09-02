#!/usr/bin/env node
// Issue gate: deterministic slop control for GitHub issues.
//
// Three gates, all mechanical:
//   1. Template structure: the body must contain the required section headings
//      from one of the issue templates.
//   2. Prose length: the body may not exceed a word budget once fenced code
//      blocks and <details> blocks are excluded, so context dumps fail while
//      long logs stay legal.
//   3. Comment dumps: an oversized comment from the issue author within the
//      first hour of the issue's life gets minimized as off-topic.
//
// Issues with no template structure at all are closed immediately; partial
// failures are labeled and warned once. Every check re-runs on edit, and an
// issue the gate closed is reopened automatically once it passes.
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MINUTE_MS = 60 * 1000;

export const GATE_LABEL = 'policy: needs template';
export const AI_LABEL = 'ai-assisted';

export const LABEL_DEFS = [
  { name: GATE_LABEL, color: 'b60205', description: 'Issue body fails the template checks and will be closed if not edited' },
  { name: AI_LABEL, color: 'c5def5', description: 'Author disclosed AI assistance in the issue body' },
];

export const GATE_MARKER = '<!-- impeccable-issue-gate:needs-template -->';
export const REJECT_MARKER = '<!-- impeccable-issue-gate:reject -->';

const DEFAULT_MAINTAINERS = ['pbakaus', 'abdulwahabone'];
const DEFAULT_TRUSTED_MARKER_AUTHORS = ['github-actions', 'github-actions[bot]'];
const EXEMPT_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const AI_DISCLOSURE = /^\s*(?:[-*>\s]*)ai-assisted:\s*yes\b/im;

// Sections a legitimate report can leave empty. Everything else in a template
// is required. Normalized (lowercase, no trailing punctuation).
const OPTIONAL_SECTIONS = new Set([
  'expected behavior',
  'additional context',
  'alternatives considered',
  'provider(s) this applies to',
  'willing to work on a fix',
  'willing to work on this',
]);

export const DEFAULT_MAX_PROSE_WORDS = 600;
export const DEFAULT_COMMENT_MAX_PROSE_WORDS = 300;
export const DEFAULT_COMMENT_WINDOW_MINUTES = 60;

// --- prose measurement -------------------------------------------------------

export function stripNonProse(markdown) {
  return String(markdown || '')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/<details[\s\S]*?<\/details>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
}

export function proseWordCount(markdown) {
  return stripNonProse(markdown).split(/\s+/).filter(Boolean).length;
}

// --- template parsing --------------------------------------------------------

export function normalizeHeading(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[?:!.]+$/, '')
    .replace(/\s+/g, ' ');
}

function extractHeadings(markdown) {
  const headings = [];
  // Scan the same prose-only view proseWordCount() uses: a heading wrapped
  // inside a fenced code block (or an HTML comment / <details> block) is not
  // structure, it's quoted text, and counting it let a body with every
  // required heading fenced and zero real prose pass the gate untouched.
  for (const line of stripNonProse(String(markdown || '')).split(/\r?\n/)) {
    const match = line.match(/^#{2,3}\s+(.+)$/);
    if (match) headings.push(normalizeHeading(match[1]));
  }
  return headings;
}

function stripFrontmatter(markdown) {
  const match = String(markdown || '').match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  return match ? markdown.slice(match[0].length) : markdown;
}

export function parseTemplate(fileName, raw) {
  const body = stripFrontmatter(raw);
  const nameMatch = raw.match(/^name:\s*(.+)$/m);
  const headings = extractHeadings(body);
  return {
    file: fileName,
    name: nameMatch ? nameMatch[1].trim() : fileName,
    headings,
    requiredSections: headings.filter((heading) => !OPTIONAL_SECTIONS.has(heading)),
  };
}

export function loadTemplates(dir) {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => parseTemplate(file, readFileSync(join(dir, file), 'utf-8')));
}

// --- issue evaluation --------------------------------------------------------

export function evaluateIssue(issue, options = {}) {
  const templates = options.templates || [];
  const maxProseWords = Number.isFinite(options.maxProseWords)
    ? options.maxProseWords
    : DEFAULT_MAX_PROSE_WORDS;
  const maintainers = loginSet(options.maintainers || DEFAULT_MAINTAINERS);
  const trustedMarkerAuthors = loginSet(options.trustedMarkerAuthors || DEFAULT_TRUSTED_MARKER_AUTHORS);
  const repo = options.repo || '';

  const author = normalizeLogin(issue.authorLogin);
  const labels = new Set(issue.labels || []);
  const comments = issue.comments || [];

  const base = {
    number: issue.number,
    title: issue.title,
    author,
    exempt: false,
    verdict: 'pass',
    reasons: [],
    aiAssisted: false,
    labelsToAdd: [],
    labelsToRemove: [],
    shouldComment: false,
    comment: '',
    shouldClose: false,
    shouldReopen: false,
  };

  // Disclosure labeling mirrors the body for every author, exempt or not; the
  // exemption below only covers the template and length gates.
  const body = String(issue.body || '');
  base.aiAssisted = AI_DISCLOSURE.test(body);
  if (base.aiAssisted && !labels.has(AI_LABEL)) base.labelsToAdd.push(AI_LABEL);
  if (!base.aiAssisted && labels.has(AI_LABEL)) base.labelsToRemove.push(AI_LABEL);

  if (maintainers.has(author) || EXEMPT_ASSOCIATIONS.has(issue.authorAssociation)) {
    return { ...base, exempt: true };
  }

  const bodyHeadings = new Set(extractHeadings(body));
  const anyTemplateHeading = templates.some(
    (template) => template.headings.some((heading) => bodyHeadings.has(heading)),
  );

  const reasons = [];
  let verdict = 'pass';

  if (!anyTemplateHeading) {
    verdict = 'reject';
    reasons.push('the body contains none of the issue template sections');
  } else {
    const primary = templates
      .map((template) => ({
        template,
        matched: template.requiredSections.filter((section) => bodyHeadings.has(section)).length,
      }))
      .sort((a, b) => b.matched - a.matched)[0].template;
    for (const section of primary.requiredSections) {
      if (!bodyHeadings.has(section)) {
        reasons.push(`missing section "${section}" from the ${primary.name.toLowerCase()} template`);
      }
    }
  }

  const words = proseWordCount(body);
  if (words > maxProseWords) {
    reasons.push(
      `the body has ${words} words of prose outside code blocks and <details> blocks; the limit is ${maxProseWords}. Trim to the essentials and move logs into a <details> block or a gist`,
    );
  }

  if (verdict !== 'reject' && reasons.length > 0) verdict = 'needs-work';

  const plan = { ...base, verdict, reasons };

  if (verdict === 'pass') {
    if (labels.has(GATE_LABEL)) plan.labelsToRemove.push(GATE_LABEL);
    const closedByGate = hasMarker(comments, REJECT_MARKER, trustedMarkerAuthors);
    plan.shouldReopen = issue.state === 'closed' && labels.has(GATE_LABEL) && closedByGate;
    return plan;
  }

  if (!labels.has(GATE_LABEL)) plan.labelsToAdd.push(GATE_LABEL);

  if (verdict === 'reject') {
    plan.shouldClose = issue.state === 'open';
    plan.shouldComment = !hasMarker(comments, REJECT_MARKER, trustedMarkerAuthors);
    plan.comment = rejectComment(repo);
    return plan;
  }

  plan.shouldComment = !hasMarker(comments, GATE_MARKER, trustedMarkerAuthors);
  plan.comment = needsWorkComment(reasons, { repo });
  return plan;
}

// --- comment evaluation ------------------------------------------------------

export function evaluateComment(input, options = {}) {
  const maxProseWords = Number.isFinite(options.maxProseWords)
    ? options.maxProseWords
    : DEFAULT_COMMENT_MAX_PROSE_WORDS;
  const windowMinutes = Number.isFinite(options.windowMinutes)
    ? options.windowMinutes
    : DEFAULT_COMMENT_WINDOW_MINUTES;
  const maintainers = loginSet(options.maintainers || DEFAULT_MAINTAINERS);

  const commentAuthor = normalizeLogin(input.commentAuthorLogin);
  const issueAuthor = normalizeLogin(input.issueAuthorLogin);
  const result = { shouldMinimize: false, reasons: [] };

  if (maintainers.has(commentAuthor)) return result;
  if (EXEMPT_ASSOCIATIONS.has(input.commentAuthorAssociation)) return result;
  if (commentAuthor !== issueAuthor) return result;

  const minutesSinceIssue = (toDate(input.commentCreatedAt).getTime()
    - toDate(input.issueCreatedAt).getTime()) / MINUTE_MS;
  if (!(minutesSinceIssue >= 0 && minutesSinceIssue <= windowMinutes)) return result;

  const words = proseWordCount(input.commentBody);
  if (words <= maxProseWords) return result;

  result.shouldMinimize = true;
  result.reasons.push(
    `self-reply with ${words} words of prose within ${Math.round(minutesSinceIssue)} minutes of opening the issue; the limit is ${maxProseWords}. This is the context-dump pattern the gate folds away`,
  );
  return result;
}

// --- comment copy --------------------------------------------------------------

function templatesUrl(repo) {
  return repo
    ? `https://github.com/${repo}/tree/main/.github/ISSUE_TEMPLATE`
    : '.github/ISSUE_TEMPLATE';
}

export function needsWorkComment(reasons, { repo = '' } = {}) {
  return [
    GATE_MARKER,
    'Thanks for filing this. It does not pass the issue template checks yet:',
    '',
    ...reasons.map((reason) => `- ${reason}`),
    '',
    `Please edit the issue body itself (not a new comment) to follow one of the [issue templates](${templatesUrl(repo)}). The checks run again on every edit and clear the label once they pass.`,
    '',
    'If AI helped write this issue, include the line `AI-assisted: yes` in the body.',
  ].join('\n');
}

export function rejectComment(repo = '') {
  return [
    REJECT_MARKER,
    'Closing this because the body does not use either issue template: none of the template sections were found.',
    '',
    `To continue, edit the issue body to follow one of the [issue templates](${templatesUrl(repo)}). The checks run again on every edit, and this issue is reopened automatically once they pass.`,
    '',
    'If AI helped write this issue, include the line `AI-assisted: yes` in the body.',
  ].join('\n');
}

// --- driver ------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const repo = options.repo || process.env.GITHUB_REPOSITORY;
  if (!repo || !repo.includes('/')) {
    throw new Error('Missing repository. Pass --repo owner/name or set GITHUB_REPOSITORY.');
  }
  options.repo = repo;
  options.templates = loadTemplates(options.templatesDir);

  if (options.apply && options.ensureLabels) ensureLabels(repo);

  if (options.commentId) {
    runCommentGate(repo, options);
    return;
  }

  if (options.issue) {
    const issue = fetchIssue(repo, options.issue);
    if (!issue) throw new Error(`Issue #${options.issue} not found.`);
    if (skipIfPullRequest(issue, options.issue)) return;
    const plan = evaluateIssue(issue, options);
    printPlan(plan, options);
    if (options.apply) applyIssuePlan(repo, plan);
    return;
  }

  throw new Error('Nothing to do. Pass --issue N or --issue N --comment-id ID.');
}

function runCommentGate(repo, options) {
  const comment = fetchComment(repo, options.commentId);
  const issue = fetchIssue(repo, options.issue);
  if (!comment || !issue) throw new Error('Comment or issue not found.');
  if (skipIfPullRequest(issue, options.issue)) return;

  const result = evaluateComment({
    commentBody: comment.body,
    commentAuthorLogin: comment.authorLogin,
    commentAuthorAssociation: comment.authorAssociation,
    commentCreatedAt: comment.createdAt,
    issueAuthorLogin: issue.authorLogin,
    issueCreatedAt: issue.createdAt,
  }, {
    maxProseWords: options.commentMaxProseWords,
    windowMinutes: options.windowMinutes,
    maintainers: options.maintainers,
  });

  if (!result.shouldMinimize) {
    console.log(`comment ${options.commentId} on #${options.issue}: pass`);
    return;
  }

  console.log(`${options.apply ? 'apply' : 'dry-run'} comment ${options.commentId} on #${options.issue}: minimize (${result.reasons.join('; ')})`);
  if (options.apply) minimizeComment(comment.nodeId);
}

// Exempt plans still reach here: they carry only disclosure-label actions.
function applyIssuePlan(repo, plan) {
  if (plan.shouldReopen) reopenIssue(repo, plan.number);
  for (const label of plan.labelsToRemove) removeLabel(repo, plan.number, label);
  if (plan.labelsToAdd.length > 0) addLabels(repo, plan.number, plan.labelsToAdd);
  if (plan.shouldComment) postComment(repo, plan.number, plan.comment);
  if (plan.shouldClose) closeIssue(repo, plan.number);
}

function printPlan(plan, { apply }) {
  const changes = [
    plan.exempt ? 'exempt' : `verdict=${plan.verdict}`,
    plan.labelsToAdd.length ? `add=${plan.labelsToAdd.join(',')}` : '',
    plan.labelsToRemove.length ? `remove=${plan.labelsToRemove.join(',')}` : '',
    plan.shouldComment ? 'comment' : '',
    plan.shouldClose ? 'close' : '',
    plan.shouldReopen ? 'reopen' : '',
  ].filter(Boolean);
  console.log(`${apply ? 'apply' : 'dry-run'} #${plan.number} ${plan.title || ''}: ${changes.join(' ')}`);
  for (const reason of plan.reasons) console.log(`  - ${reason}`);
}

export function parseArgs(argv) {
  const options = {
    apply: false,
    ensureLabels: true,
    issue: null,
    commentId: null,
    templatesDir: '.github/ISSUE_TEMPLATE',
    maxProseWords: DEFAULT_MAX_PROSE_WORDS,
    commentMaxProseWords: DEFAULT_COMMENT_MAX_PROSE_WORDS,
    windowMinutes: DEFAULT_COMMENT_WINDOW_MINUTES,
    maintainers: DEFAULT_MAINTAINERS,
    now: new Date(),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--dry-run') options.apply = false;
    else if (arg === '--no-label-ensure') options.ensureLabels = false;
    else if (arg === '--repo') options.repo = requireValue(argv, ++i, arg);
    else if (arg === '--issue') options.issue = Number(requireValue(argv, ++i, arg));
    else if (arg === '--comment-id') options.commentId = requireValue(argv, ++i, arg);
    else if (arg === '--templates-dir') options.templatesDir = requireValue(argv, ++i, arg);
    else if (arg === '--max-words') options.maxProseWords = Number(requireValue(argv, ++i, arg));
    else if (arg === '--comment-max-words') options.commentMaxProseWords = Number(requireValue(argv, ++i, arg));
    else if (arg === '--comment-window-minutes') options.windowMinutes = Number(requireValue(argv, ++i, arg));
    else if (arg === '--maintainers') options.maintainers = splitList(requireValue(argv, ++i, arg));
    else if (arg === '--now') options.now = new Date(requireValue(argv, ++i, arg));
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (options.issue !== null && !Number.isInteger(options.issue)) {
    throw new Error('--issue must be an integer.');
  }
  if (!Number.isFinite(options.maxProseWords) || options.maxProseWords <= 0) {
    throw new Error('--max-words must be a positive number.');
  }
  if (Number.isNaN(options.now.getTime())) throw new Error('--now must be a valid date.');

  return options;
}

// --- gh plumbing ---------------------------------------------------------------

function normalizeIssue(raw) {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body || '',
    state: raw.state,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    authorLogin: raw.user?.login || '',
    authorAssociation: raw.author_association || '',
    labels: (raw.labels || []).map((label) => (typeof label === 'string' ? label : label.name)),
    isPullRequest: Boolean(raw.pull_request),
    comments: [],
  };
}

/**
 * GitHub's issues endpoint returns pull requests too, so `--issue <n>` with a
 * PR number (a manual workflow_dispatch is the reachable path) lands here with
 * a PR in hand. A PR carries no issue template, so gating it would label,
 * comment on, or close it for headings it was never meant to have.
 */
export function skipIfPullRequest(issue, number) {
  if (!issue.isPullRequest) return false;
  console.log(`#${number} is a pull request, not an issue. The gate only runs on issues; nothing to do.`);
  return true;
}

function fetchIssue(repo, number) {
  const raw = runGhJson(['api', `repos/${repo}/issues/${number}`]);
  if (!raw || !raw.number) return null;
  const issue = normalizeIssue(raw);
  issue.comments = fetchIssueComments(repo, number);
  return issue;
}

function fetchIssueComments(repo, number) {
  const pages = runGhJson([
    'api',
    '--paginate',
    '--slurp',
    `repos/${repo}/issues/${number}/comments?per_page=100`,
  ]);
  const flat = Array.isArray(pages) ? pages.flat() : [];
  return flat.map((comment) => ({
    authorLogin: comment.user?.login || '',
    createdAt: comment.created_at,
    body: comment.body || '',
  }));
}

function fetchComment(repo, commentId) {
  const raw = runGhJson(['api', `repos/${repo}/issues/comments/${commentId}`]);
  if (!raw || !raw.id) return null;
  return {
    id: raw.id,
    nodeId: raw.node_id,
    body: raw.body || '',
    createdAt: raw.created_at,
    authorLogin: raw.user?.login || '',
    authorAssociation: raw.author_association || '',
  };
}

function ensureLabels(repo) {
  for (const label of LABEL_DEFS) {
    const encoded = encodeURIComponent(label.name);
    const get = runGh(['api', `repos/${repo}/labels/${encoded}`], { allowFailure: true, quiet: true });
    if (get.status === 0) continue;
    runGh([
      'api',
      '-X',
      'POST',
      `repos/${repo}/labels`,
      '-f',
      `name=${label.name}`,
      '-f',
      `color=${label.color}`,
      '-f',
      `description=${label.description}`,
    ], { allowFailure: true });
  }
}

function addLabels(repo, number, labels) {
  const args = ['api', '-X', 'POST', `repos/${repo}/issues/${number}/labels`];
  for (const label of labels) args.push('-f', `labels[]=${label}`);
  runGh(args);
}

function removeLabel(repo, number, label) {
  runGh([
    'api',
    '-X',
    'DELETE',
    `repos/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`,
  ], { allowFailure: true });
}

function postComment(repo, number, body) {
  runGh(['api', '-X', 'POST', `repos/${repo}/issues/${number}/comments`, '-f', `body=${body}`]);
}

function closeIssue(repo, number) {
  runGh([
    'api',
    '-X',
    'PATCH',
    `repos/${repo}/issues/${number}`,
    '-f',
    'state=closed',
    '-f',
    'state_reason=not_planned',
  ]);
}

function reopenIssue(repo, number) {
  runGh(['api', '-X', 'PATCH', `repos/${repo}/issues/${number}`, '-f', 'state=open']);
}

function minimizeComment(nodeId) {
  runGh([
    'api',
    'graphql',
    '-f',
    'query=mutation($id: ID!) { minimizeComment(input: { subjectId: $id, classifier: OFF_TOPIC }) { minimizedComment { isMinimized } } }',
    '-f',
    `id=${nodeId}`,
  ]);
}

// --- shared helpers ------------------------------------------------------------

function hasMarker(comments = [], marker, trustedAuthors) {
  return comments.some((comment) => isTrustedMarkerComment(comment, marker, trustedAuthors));
}

function isTrustedMarkerComment(comment, marker, trustedAuthors) {
  if (typeof comment?.body !== 'string' || !comment.body.includes(marker)) return false;
  return trustedAuthors.has(normalizeLogin(comment.authorLogin));
}

function toDate(value) {
  return value instanceof Date ? value : new Date(value);
}

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function loginSet(logins) {
  return new Set(logins.map(normalizeLogin).filter(Boolean));
}

function normalizeLogin(login) {
  return String(login || '').toLowerCase();
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

function runGhJson(args) {
  const result = runGh(args, { quiet: true });
  try {
    return JSON.parse(result.stdout || '{}');
  } catch (err) {
    throw new Error(`Failed to parse gh JSON output: ${err.message}`);
  }
}

function runGh(args, options = {}) {
  const result = spawnSync('gh', args, {
    encoding: 'utf-8',
    env: process.env,
  });
  if (!options.quiet && result.stdout) process.stdout.write(result.stdout);
  if (!options.quiet && result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`gh ${args.join(' ')} failed with exit ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result;
}

function printHelp() {
  console.log(`Usage: node scripts/github/issue-gate.mjs [--repo owner/name] [--apply] <mode>

Default mode is a dry run.

Modes:
  --issue N                       evaluate one issue body (workflow: issues opened/edited)
  --issue N --comment-id ID       evaluate one comment (workflow: issue_comment created)

Options:
  --apply                         mutate labels, comments, and issue state
  --dry-run                       print planned changes without mutating GitHub
  --repo owner/name               repository (defaults to GITHUB_REPOSITORY)
  --templates-dir path            issue template dir (default: .github/ISSUE_TEMPLATE)
  --max-words n                   prose word budget for issue bodies (default: ${DEFAULT_MAX_PROSE_WORDS})
  --comment-max-words n           prose word budget for early self-replies (default: ${DEFAULT_COMMENT_MAX_PROSE_WORDS})
  --comment-window-minutes n      self-reply window after issue creation (default: ${DEFAULT_COMMENT_WINDOW_MINUTES})
  --maintainers a,b               logins exempt from all gates
  --no-label-ensure               skip creating gate labels
`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
