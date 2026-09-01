#!/usr/bin/env node
// Deterministic scorer for the evidence-item path (see reference/critique-evidence.md).
//
// Reads a JSON file (or stdin) containing a list of evidence items
// (LLM-collected and/or detector-emitted) and produces the score JSON
// envelope. Ported from the CodefiLabs/impeccable fork's score-evidence.py;
// this file is the source of truth going forward, not a wrapper around it.
//
// Item shape:
//   { heuristic_id: "vss", item_id: "vss-pos-loading-feedback",
//     impact: 3, source: "llm" | "detector", citation: "..." }
//
// The scorer does NOT validate item_id against any catalog. The caller is
// responsible for filtering unknown item_ids and logging warnings.
//
// Usage:
//   score-evidence.mjs items.json [--center 50] [--scale 8] [--density-denom 20]
//   cat items.json | score-evidence.mjs -

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as fs from 'node:fs';

/**
 * Apply the evidence-item scoring formula to a list of evidence items.
 *
 * Rounding uses Math.round (round-half-up), a deliberate choice for this
 * from-scratch port; it differs from Python's round() (round-half-to-even)
 * at exact .5 boundaries. Both are defensible, but only one is implemented
 * here, and tests pin it.
 */
export function score(items, { center = 50, scale = 8, densityDenom = 20 } = {}) {
  const totalItems = items.length;

  if (totalItems === 0) {
    return {
      final: Math.round(center),
      raw: round2(center),
      multiplier: 0.75,
      total_items: 0,
      net_impact: 0,
      by_heuristic: {},
      by_source: {},
    };
  }

  for (const item of items) {
    if (!Number.isFinite(Number(item.impact))) {
      throw new Error(
        `score-evidence: item ${JSON.stringify(item.item_id ?? item)} has a non-numeric impact (${item.impact}). ` +
          'Every item must carry the impact looked up from its catalog entry before scoring; Stage 1 LLM output does not include one.',
      );
    }
  }

  const netImpact = items.reduce((sum, item) => sum + Number(item.impact), 0);
  const normalized = netImpact / Math.sqrt(totalItems);
  const raw = clamp(center + normalized * scale, 0, 100);
  const density = Math.min(1, totalItems / densityDenom);
  const multiplier = 0.75 + 0.25 * density;
  const final = Math.round(center + (raw - center) * multiplier);

  return {
    final,
    raw: round2(raw),
    multiplier: round3(multiplier),
    total_items: totalItems,
    net_impact: netImpact,
    by_heuristic: breakdownBy(items, (item) => item.heuristic_id ?? 'unknown'),
    by_source: breakdownBy(items, (item) => item.source ?? 'unknown'),
  };
}

function breakdownBy(items, keyOf) {
  const buckets = {};
  for (const item of items) {
    const key = keyOf(item);
    if (!buckets[key]) buckets[key] = { items: 0, net_impact: 0 };
    buckets[key].items += 1;
    buckets[key].net_impact += Number(item.impact);
  }
  return buckets;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function parseArgs(argv) {
  const args = { input: undefined, center: 50, scale: 8, densityDenom: 20 };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--center') args.center = Number(argv[++i]);
    else if (arg === '--scale') args.scale = Number(argv[++i]);
    else if (arg === '--density-denom') args.densityDenom = Number(argv[++i]);
    else positional.push(arg);
  }
  args.input = positional[0];
  return args;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args.input) {
    process.stderr.write('usage: score-evidence.mjs <items.json|-> [--center N] [--scale N] [--density-denom N]\n');
    return 2;
  }

  const raw = args.input === '-' ? await readStdin() : readFileSync(args.input, 'utf8');
  const data = JSON.parse(raw);

  let items;
  if (Array.isArray(data)) items = data;
  else if (data && Array.isArray(data.items)) items = data.items;
  else {
    process.stderr.write('Input must be a list of items or {items: [...]}\n');
    return 2;
  }

  const result = score(items, {
    center: args.center,
    scale: args.scale,
    densityDenom: args.densityDenom,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return 0;
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
