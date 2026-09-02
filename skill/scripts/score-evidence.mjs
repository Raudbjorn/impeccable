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

import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Apply the evidence-item scoring formula to a list of evidence items.
 *
 * Rounding uses Math.round (round-half-up), a deliberate choice for this
 * from-scratch port; it differs from Python's round() (round-half-to-even)
 * at exact .5 boundaries. Both are defensible, but only one is implemented
 * here, and tests pin it.
 */
export function score(items, { center = 50, scale = 8, densityDenom = 20 } = {}) {
  if (
    !Number.isFinite(center) || center < 0 || center > 100 ||
    !Number.isFinite(scale) || scale < 0 ||
    !Number.isFinite(densityDenom) || densityDenom <= 0
  ) {
    throw new Error(
      `invalid options (center=${center}, scale=${scale}, densityDenom=${densityDenom}). ` +
        'center must be 0-100, scale must be non-negative, densityDenom must be a positive finite number.',
    );
  }

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
    if (!item || typeof item !== 'object' || typeof item.impact !== 'number' || !Number.isFinite(item.impact)) {
      const label = item && typeof item === 'object' ? JSON.stringify(item.item_id ?? item) : JSON.stringify(item);
      throw new Error(
        `item ${label} has a non-numeric impact (${JSON.stringify(item && typeof item === 'object' ? item.impact : undefined)}). ` +
          'Every item must carry the impact looked up from its catalog entry before scoring; Stage 1 LLM output does not include one.',
      );
    }
  }

  const netImpact = items.reduce((sum, item) => sum + item.impact, 0);
  if (!Number.isFinite(netImpact)) {
    throw new Error(
      `net impact across ${totalItems} items is not finite (${netImpact}). ` +
        'Individual impacts were all finite, but their sum overflowed; refusing to silently emit a null/NaN score.',
    );
  }
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
  // Object.create(null) rather than {}: keyOf() returns caller-controlled
  // strings (heuristic_id/source), and a plain-object bucket map lets a key
  // like "__proto__" or "constructor" resolve to an inherited Object.prototype
  // member instead of a fresh bucket -- silently dropping that item from the
  // breakdown and, for a caller that holds score() in a long-lived process
  // rather than a one-shot CLI invocation, writing NaN properties onto the
  // shared global prototype.
  const buckets = Object.create(null);
  for (const item of items) {
    const key = keyOf(item);
    if (!buckets[key]) buckets[key] = { items: 0, net_impact: 0 };
    buckets[key].items += 1;
    buckets[key].net_impact += item.impact;
  }
  // Copy onto a plain object before returning: callers (including
  // JSON.stringify and assert.deepStrictEqual in tests) expect an ordinary
  // Object.prototype-backed map, and the null-prototype guard above is only
  // needed during accumulation.
  return { ...buckets };
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

  try {
    const raw = args.input === '-' ? await readStdin() : fs.readFileSync(args.input, 'utf8');
    const data = JSON.parse(raw);

    let items;
    if (Array.isArray(data)) items = data;
    else if (data && Array.isArray(data.items)) items = data.items;
    else {
      process.stderr.write('score-evidence: input must be a list of items or {items: [...]}\n');
      return 2;
    }

    const result = score(items, {
      center: args.center,
      scale: args.scale,
      densityDenom: args.densityDenom,
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (err) {
    // A bad file path, malformed JSON, or an invalid item/option all land here.
    // A user-invoked CLI should report a short reason and a clean exit code,
    // not an uncaught-exception stack trace.
    process.stderr.write(`score-evidence: ${err.message}\n`);
    return 2;
  }
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
