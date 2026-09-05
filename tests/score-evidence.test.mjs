/**
 * Tests for the evidence-item scorer and its catalog data.
 * Run with: node --test tests/score-evidence.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { score } from '../skill/scripts/score-evidence.mjs';
const ANTIPATTERNS = JSON.parse(readFileSync(new URL('../crates/live/assets/antipatterns.json', import.meta.url), 'utf8'));

const SCRIPT = fileURLToPath(new URL('../skill/scripts/score-evidence.mjs', import.meta.url));
const DATA_DIR = fileURLToPath(new URL('../skill/scripts/data/critique-evidence/', import.meta.url));

describe('score()', () => {
  it('reproduces the ported formula\'s worked example (6 items, net +3 -> final 58)', () => {
    const items = [{ impact: 1 }, { impact: 1 }, { impact: 1 }, { impact: 1 }, { impact: -1 }, { impact: 0 }];
    const result = score(items);
    assert.equal(result.final, 58);
    assert.equal(result.raw, 59.8);
    assert.equal(result.multiplier, 0.825);
    assert.equal(result.total_items, 6);
    assert.equal(result.net_impact, 3);
  });

  it('returns the center score at the minimum multiplier for zero items', () => {
    const result = score([]);
    assert.deepEqual(result, {
      final: 50,
      raw: 50,
      multiplier: 0.75,
      total_items: 0,
      net_impact: 0,
      by_heuristic: {},
      by_source: {},
    });
  });

  it('rounds an exact .5 boundary half-up (JS convention, not Python banker\'s rounding)', () => {
    // 8 items, net impact -18: normalized = -18/sqrt(8), raw clamps to 0,
    // multiplier = 0.75 + 0.25*(8/20) = 0.85, exact = 50 + (0-50)*0.85 = 7.5.
    const items = [{ impact: -18 }, ...Array.from({ length: 7 }, () => ({ impact: 0 }))];
    const result = score(items);
    assert.equal(result.raw, 0);
    assert.equal(result.multiplier, 0.85);
    assert.equal(result.final, 8);
  });

  it('breaks totals down by heuristic and source', () => {
    const items = [
      { impact: 2, heuristic_id: 'vss', source: 'llm' },
      { impact: -1, heuristic_id: 'vss', source: 'detector' },
      { impact: 1, heuristic_id: 'amd', source: 'llm' },
    ];
    const result = score(items);
    assert.deepEqual(result.by_heuristic, {
      vss: { items: 2, net_impact: 1 },
      amd: { items: 1, net_impact: 1 },
    });
    assert.deepEqual(result.by_source, {
      llm: { items: 2, net_impact: 3 },
      detector: { items: 1, net_impact: -1 },
    });
  });

  it('clamps raw to [0, 100] before applying the confidence multiplier', () => {
    const items = Array.from({ length: 50 }, () => ({ impact: 5 }));
    const result = score(items);
    assert.equal(result.raw, 100);
    assert.ok(result.final <= 100);
  });

  it('rejects an item with a non-numeric impact instead of producing a NaN/null score', () => {
    // Stage 1 LLM output has no `impact` field; the orchestrator must attach it
    // from the catalog before scoring (see critique-evidence.md Stage 3).
    assert.throws(() => score([{ heuristic_id: 'vss', item_id: 'vss-pos-loading-feedback' }]), /non-numeric impact/);
    assert.throws(() => score([{ impact: 'high' }]), /non-numeric impact/);
    assert.throws(() => score([{ impact: NaN }]), /non-numeric impact/);
  });

  it('rejects impact values that coerce to a number instead of being genuinely numeric', () => {
    // Number(null) === 0 and Number('') === 0; a malformed item must not
    // silently score as a legitimate zero-impact item.
    assert.throws(() => score([{ impact: null }]), /non-numeric impact/);
    assert.throws(() => score([{ impact: '' }]), /non-numeric impact/);
    assert.throws(() => score([{ impact: false }]), /non-numeric impact/);
    assert.throws(() => score([{ impact: [] }]), /non-numeric impact/);
  });

  it('rejects invalid center/scale/densityDenom options instead of producing an out-of-range score', () => {
    const items = [{ impact: -100 }];
    assert.throws(() => score(items, { densityDenom: -0.1 }), /invalid options/);
    assert.throws(() => score(items, { densityDenom: 0 }), /invalid options/);
    assert.throws(() => score(items, { center: -1 }), /invalid options/);
    assert.throws(() => score(items, { center: 101 }), /invalid options/);
    assert.throws(() => score(items, { scale: -1 }), /invalid options/);
    assert.throws(() => score(items, { center: NaN }), /invalid options/);
  });

  it('rejects a non-array items argument instead of coercing via .length', () => {
    // { length: 0 } and '' both have a .length of 0; without an explicit
    // Array.isArray check they'd silently take the zero-items branch.
    assert.throws(() => score({ length: 0 }), /must be an array/);
    assert.throws(() => score(''), /must be an array/);
    assert.throws(() => score(null), /must be an array/);
  });
});

describe('score-evidence.mjs CLI', () => {
  it('scores items via stdin', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '-'], {
      input: JSON.stringify([{ impact: 3 }, { impact: -1 }]),
      encoding: 'utf-8',
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.total_items, 2);
    assert.equal(parsed.net_impact, 2);
  });

  it('scores items from a file path argument', () => {
    const dir = mkdtempSync(join(tmpdir(), 'imp-score-evidence-'));
    try {
      const itemsFile = join(dir, 'items.json');
      writeFileSync(itemsFile, JSON.stringify([{ impact: 3 }, { impact: -1 }]));
      const r = spawnSync(process.execPath, [SCRIPT, itemsFile], { encoding: 'utf-8' });
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.total_items, 2);
      assert.equal(parsed.net_impact, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts {items: [...]} envelope input via stdin', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '-'], {
      input: JSON.stringify({ items: [{ impact: 1 }] }),
      encoding: 'utf-8',
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).total_items, 1);
  });

  it('respects --center/--scale/--density-denom overrides', () => {
    const r = spawnSync(
      process.execPath,
      [SCRIPT, '-', '--center', '0', '--scale', '1', '--density-denom', '1'],
      { input: JSON.stringify([{ impact: 10 }]), encoding: 'utf-8' },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.raw, 10);
    assert.equal(parsed.multiplier, 1);
  });

  it('exits 2 with a usage message when no input is given', () => {
    const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf-8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage/);
  });

  it('exits 2 with a clean message (no stack trace) on malformed JSON input', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '-'], { input: '{not json', encoding: 'utf-8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^score-evidence: /);
    assert.doesNotMatch(r.stderr, /^\s+at\s/m);
  });

  it('exits 2 with a clean message (no stack trace) on an unreadable file path', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '/no/such/file.json'], { encoding: 'utf-8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /^score-evidence: /);
    assert.doesNotMatch(r.stderr, /^\s+at\s/m);
  });

  it('exits 2 with a clean message (no stack trace) on a non-finite --center override', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '-', '--center', 'not-a-number'], {
      input: JSON.stringify([{ impact: 1 }]),
      encoding: 'utf-8',
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /invalid options/);
  });

  it('exits 2 with a clean message on an item with a non-numeric impact', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '-'], {
      input: JSON.stringify([{ impact: null }]),
      encoding: 'utf-8',
    });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /non-numeric impact/);
  });
});

describe('critique-evidence catalog data', () => {
  const heuristicFiles = readdirSync(DATA_DIR).filter((f) => f.startsWith('heuristic-'));

  it('ships all 10 heuristic catalogs', () => {
    assert.equal(heuristicFiles.length, 10);
  });

  it('every heuristic catalog is valid JSON with unique item ids', () => {
    for (const file of heuristicFiles) {
      const data = JSON.parse(readFileSync(join(DATA_DIR, file), 'utf-8'));
      const ids = [
        ...data.catalog.positive,
        ...data.catalog.negative,
        ...data.catalog.critical_negative,
      ].map((item) => item.id);
      assert.equal(new Set(ids).size, ids.length, `duplicate item id within ${file}`);
    }
  });

  it('detector-items.json only references rule ids that currently exist in the anti-pattern registry', () => {
    // Import the live registry array rather than regex-scraping its source
    // text: a scrape only tracks whatever quoting/formatting the regex was
    // written against, so a reflow or a quote-style change could silently
    // stop enforcing this drift guard instead of failing loudly.
    const currentIds = new Set(ANTIPATTERNS.map((rule) => rule.id));
    const detectorItems = JSON.parse(readFileSync(join(DATA_DIR, 'detector-items.json'), 'utf-8'));

    const staleIds = detectorItems.items.filter((item) => !currentIds.has(item.id)).map((i) => i.id);
    assert.deepEqual(staleIds, [], 'detector-items.json references rule ids retired from the registry');

    const ids = detectorItems.items.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate rule id in detector-items.json');
  });

  it('every current registry rule has a detector-item entry (authored or default)', () => {
    const currentIds = ANTIPATTERNS.map((rule) => rule.id);
    const detectorItems = JSON.parse(readFileSync(join(DATA_DIR, 'detector-items.json'), 'utf-8'));
    const coveredIds = new Set(detectorItems.items.map((item) => item.id));

    const missing = currentIds.filter((id) => !coveredIds.has(id));
    assert.deepEqual(missing, [], 'registry rules missing from detector-items.json');
  });

  it('every catalog item\'s impact sign matches its positive/negative/critical_negative bucket', () => {
    for (const file of heuristicFiles) {
      const data = JSON.parse(readFileSync(join(DATA_DIR, file), 'utf-8'));
      for (const item of data.catalog.positive) {
        assert.ok(item.impact > 0, `${file}: positive item ${item.id} has non-positive impact ${item.impact}`);
      }
      for (const item of data.catalog.negative) {
        assert.ok(item.impact < 0, `${file}: negative item ${item.id} has non-negative impact ${item.impact}`);
      }
      for (const item of data.catalog.critical_negative) {
        assert.ok(item.impact < 0, `${file}: critical_negative item ${item.id} has non-negative impact ${item.impact}`);
      }
    }
  });

  it('every heuristic_id used by detector-items.json and the heuristic catalogs matches a real catalog code', () => {
    const catalogCodes = new Set(
      heuristicFiles.map((file) => JSON.parse(readFileSync(join(DATA_DIR, file), 'utf-8')).heuristic_id),
    );
    assert.equal(catalogCodes.size, 10, 'heuristic catalogs must use 10 distinct heuristic_id codes');

    const detectorItems = JSON.parse(readFileSync(join(DATA_DIR, 'detector-items.json'), 'utf-8'));
    const usedCodes = new Set(detectorItems.items.map((item) => item.heuristic_id));
    const phantom = [...usedCodes].filter((code) => !catalogCodes.has(code));
    assert.deepEqual(phantom, [], 'detector-items.json references a heuristic_id with no matching catalog file');
  });
});
