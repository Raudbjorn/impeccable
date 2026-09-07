import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { findEngineBinary, ENGINE_MISSING_MESSAGE, engineEnv } from './lib/engine-bin.mjs';
import { handle } from '../skill/scripts/compose-export.mjs';

const binary = findEngineBinary();
const concept = (id, tier) => ({
  id, kind: 'concept', name: id, wellTier: tier, familyId: id, strength: 'dual',
  form: `A ${id} specimen folio, numbered plates around an open reading column`,
  lineage: 'Synthetic specimen created for integration testing', tags: ['reading', 'plates', 'numbering'],
  system: ['Palette/material: black ink on white paper', 'Type/composition: serif headings and plain body text',
    'Topology/navigation: numbered sections follow reading order', 'Controls/state: show the active reading section',
    'Responsive/motion: collapse marginal notes below the text'],
  spark: 'Numbered plates anchor each section while generous reading columns keep the specimen legible across the whole document.',
  webLeverage: 'Use semantic sections with addressable anchors',
  vernacular: { nav: 'Sections', menu: 'Contents', copy: 'Copy', copied: 'Copied', item: 'text', search: 'Find' },
});
const draft = () => ({
  entries: [concept('plate-one', 'graphic'), concept('plate-two', 'interaction'), concept('plate-three', 'atmosphere'),
    { id: 'reading-sequence', kind: 'composition', familyId: 'reading', form: 'Numbered reading sequence with notes',
      spark: 'An ordered reading sequence', surface: 'read', grain: 'view', platforms: ['web'],
      grammar: ['Staging/hierarchy: one reading column', 'Sequence/attention: follow numbered sections',
        'Controls/state: active section anchors', 'Adaptation: move notes below reading text'], webLeverage: 'Semantic sections and anchors' }],
  guidance: [{ kind: 'principle', statement: 'Keep the reading order addressable.', appliesTo: ['world', 'review'] }],
  claims: [{ kind: 'adapted', statement: 'Reading plates adapted to anchor navigation', citation: 'synthetic source' }],
  tokens: { bg: { $value: '#ffffff' }, text: { $value: '#111111' } },
});

test('Compose project selection, replay, drift, exports, and seed integration', { skip: !binary && ENGINE_MISSING_MESSAGE }, () => {
  const cwd = mkdtempSync(join(tmpdir(), 'impose-e2e-'));
  const run = (verb, input, ok = true) => {
    const result = spawnSync(binary, ['compose', verb], { cwd, env: engineEnv(binary), input: JSON.stringify(input), encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status === 0, ok, `${verb}: ${result.stdout}\n${result.stderr}`);
    return JSON.parse(ok ? result.stdout : result.stderr || result.stdout);
  };
  try {
    writeFileSync(join(cwd, 'PRODUCT.md'), '# Product\n\n## Positioning\nA reference manual for readers.\n\n## Operating Context\nWeb reading.\n\n## Evidence on Hand\nSynthetic fixtures.\n\n## Product Principles\nKeep reading accessible.\n');
    const data = draft();
    const valid = run('validate', { draft: data });
    run('review', { draftId: valid.draftId, actor: 'test-model', authority: 'machine', verdict: 'approved', reason: 'Synthetic checks passed' });
    run('select', { brief: 'reading', settings: { key: 'deadbeef', mode: 'read' } }, false);
    const selected = run('select', { brief: 'reading', settings: { key: 'deadbeef', scope: 'direction', mode: 'read', approvalPolicy: 'human-and-machine' } });
    assert.deepEqual(run('select', { op: 'replay', session: selected.session, round: 0 }), selected);
    assert.equal(selected.record.staging.id, 'reading-sequence');
    run('select', { op: 'round', session: selected.session, settings: { mode: 'operate' }, round: 1 }, false);
    run('select', { op: 'choose', session: selected.session, round: 0, entry: selected.record.staging.id, kind: 'pick' });
    run('review', { draftId: valid.draftId, actor: 'tester', authority: 'human', verdict: 'approved', reason: 'Reviewed the actual synthetic grammar' });
    run('adopt', { draftId: valid.draftId, reason: 'Use the reference grammar' });
    const bcp = run('export', { draftId: valid.draftId, format: 'bcp' });
    assert.match(readFileSync(bcp.path, 'utf8'), /not a certified BCP document/);
    const design = run('export', { draftId: valid.draftId, format: 'design' });
    assert.match(readFileSync(design.path, 'utf8'), /colors:/);
    assert.equal(run('export', { draftId: valid.draftId, format: 'design' }).reused, true);
    writeFileSync(join(cwd, 'brief.txt'), 'A reading reference with numbered plates');
    const seed = spawnSync(binary, ['concept-seed', '--project-catalog', cwd, '--brief-file', 'brief.txt', '--from', 'deadbeef', '--scope', 'direction', '--mode', 'read'], {
      cwd, env: engineEnv(binary, { IMPECCABLE_API_URL: 'http://127.0.0.1:9' }), encoding: 'utf8', timeout: 30000,
    });
    assert.equal(seed.status, 0, `${seed.stdout}\n${seed.stderr}`);
    assert.match(seed.stdout, /LOCAL SESSION/);
    assert.match(seed.stdout, /plate-one/);
    writeFileSync(join(cwd, 'page.html'), '<html><body><h1>Reading</h1><p>Numbered plates.</p></body></html>');
    const assessment = run('assess', { target: 'page.html', observation: 'static-dom' });
    assert.equal(assessment.report.observation, 'static-dom');
    writeFileSync(join(cwd, 'critique.md'), '# Critique\nSynthetic review.\n');
    for (const context of ['1280x800:initial', '375x812:initial']) {
      const saved = spawnSync(binary, ['critique-storage', 'write', 'page.html', join(cwd, 'critique.md')], {
        cwd, env: engineEnv(binary, { IMPECCABLE_CRITIQUE_META: JSON.stringify({ max_score: 40, observation: 'browser', observation_context: context }) }), encoding: 'utf8', timeout: 30000,
      });
      assert.equal(saved.status, 0, saved.stderr);
    }
    const trend = spawnSync(binary, ['critique-storage', 'trend', 'page.html'], { cwd, env: engineEnv(binary), encoding: 'utf8', timeout: 30000 });
    assert.equal(trend.status, 0, trend.stderr);
    const history = JSON.parse(trend.stdout);
    assert.equal(history.length, 2);
    assert.match(history[0].rubric_revision, /^[a-f0-9]{64}$/);
    assert.deepEqual(history.map(row => row.comparable_to_latest), [false, true]);
    writeFileSync(join(cwd, 'source.json'), JSON.stringify({ pages: [{ page: 1, text: 'Synthetic plate source' }] }));
    run('source', { target: 'source.json', kind: 'structured' });
    assert.equal(run('verify', { deep: true }).valid, true);
    writeFileSync(join(cwd, 'source.json'), '{}');
    assert.equal(run('verify', { deep: true }, false).valid, false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('package worker uses reject policies and fails on missing parsers or warnings', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'impose-export-'));
  try {
    await assert.rejects(handle({ format: 'world-theme', document: {}, config: {} }), /Configure themeModule/);
    const module = join(cwd, 'parser.mjs');
    writeFileSync(module, `export function parseWorldTheme(raw, options) {
      if (options.onContrastFailure !== 'reject' || options.unknownTokens !== 'reject') throw new Error('unsafe policy');
      return { ok: true, value: { issues: [{ code: 'W_CONTRAST_FAILED' }] } };
    }`);
    await assert.rejects(handle({ format: 'world-theme', document: {}, config: { themeModule: module } }), /validation failed/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('optional real processing and export workers', { skip: !binary || process.env.IMPOSE_PROCESSING_E2E !== '1' }, () => {
  const cwd = mkdtempSync(join(tmpdir(), 'impose-workers-'));
  const run = (verb, input) => {
    const result = spawnSync(binary, ['compose', verb], { cwd, env: engineEnv(binary), input: JSON.stringify(input), encoding: 'utf8', timeout: 200000 });
    assert.equal(result.status, 0, `${verb}: ${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  try {
    const setup = { install: ['extract', 'specimen'] };
    for (const [field, variable] of [['themeModule', 'IMPOSE_THEME_MODULE'], ['vernacularModule', 'IMPOSE_VERNACULAR_MODULE']]) {
      if (process.env[variable]) setup[field] = resolve(process.env[variable]);
    }
    run('setup', setup);
    writeFileSync(join(cwd, 'source.json'), JSON.stringify({ pages: [{ page: 1, text: 'Synthetic reading plate source.', spans: [] }] }));
    const source = run('source', { target: 'source.json', kind: 'structured' });
    const derived = run('derive', { sourceId: source.sourceId });
    assert.equal(derived.output.triage.ocrCorrectness, 'unassessed');
    assert.equal(run('derive', { sourceId: source.sourceId }).runId, derived.runId);
    const valid = run('validate', { draft: draft() });
    run('review', { draftId: valid.draftId, actor: 'tester', authority: 'human', verdict: 'approved', reason: 'Reviewed synthetic fixture' });
    const proposal = run('source', { op: 'propose', sourceId: source.sourceId, draftId: valid.draftId, entryId: 'plate-one', page: 1, actor: 'test-model' });
    run('review', { proposalId: proposal.id, actor: 'tester', authority: 'human', verdict: 'approved', bulk: true, reason: 'Accepted synthetic source pre-screen' });
    const bcp = run('export', { draftId: valid.draftId, format: 'bcp' });
    assert.match(readFileSync(bcp.path, 'utf8'), /human bulk acceptance/);
    const pdf = run('export', { draftId: valid.draftId, format: 'specimen' });
    assert.equal(readFileSync(pdf.path).subarray(0, 4).toString(), '%PDF');
    assert.equal(run('export', { draftId: valid.draftId, format: 'specimen' }).reused, true);
    for (const format of ['world-theme', 'vernacular']) {
      if (setup[format === 'world-theme' ? 'themeModule' : 'vernacularModule']) {
        assert.ok(existsSync(run('export', { draftId: valid.draftId, format, entryId: 'plate-one' }).path));
      }
    }
    assert.equal(run('verify', { deep: true }).valid, true);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
