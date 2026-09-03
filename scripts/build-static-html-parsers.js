#!/usr/bin/env node

/**
 * Generates cli/engine/vendor/static-html-parsers.mjs
 * by bundling htmlparser2, css-select, css-tree, and domutils for skill/plugin installs.
 *
 * Run: node scripts/build-static-html-parsers.js
 * Check: node scripts/build-static-html-parsers.js --check
 */

import { createHash } from 'node:crypto';
import fs from 'fs';
import os from 'node:os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const ENTRY = path.join(__dirname, 'lib/static-html-parsers.entry.mjs');
const OUT_DIR = path.join(ROOT, 'cli/engine/vendor');
const OUTPUT = path.join(OUT_DIR, 'static-html-parsers.mjs');
const HEADER_END = '*/\n';

// Builds the bundle body fresh via `bun build`, which resolves and inlines
// the full dependency graph (including transitive packages like
// source-map-js) from the current lockfile -- so this reflects any change
// anywhere in that graph, not just the direct packages' own versions.
function buildBody() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-static-html-parsers-'));
  const tmpFile = path.join(tmpDir, 'bundle.mjs');
  try {
    const result = spawnSync(
      'bun',
      ['build', ENTRY, '--outfile', tmpFile, '--target', 'node', '--format', 'esm'],
      { cwd: ROOT, encoding: 'utf8' },
    );
    if (result.status !== 0) {
      process.stderr.write(result.stderr || result.stdout || 'bun build failed\n');
      process.exit(result.status ?? 1);
    }
    return fs.readFileSync(tmpFile, 'utf8');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function digestOf(body) {
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

function header(digest) {
  return `/**
 * GENERATED -- do not edit. Source: scripts/lib/static-html-parsers.entry.mjs
 * Rebuild: node scripts/build-static-html-parsers.js
 * Source digest: ${digest}
 *
 * Bundles htmlparser2, css-select, css-tree, and domutils for skill/plugin installs.
 * Third-party licenses: see NOTICE.md.
 */
`;
}

function splitHeader(content) {
  const end = content.indexOf(HEADER_END);
  if (end === -1) throw new Error(`${path.relative(ROOT, OUTPUT)} is missing its generated header`);
  return content.slice(end + HEADER_END.length);
}

if (process.argv.includes('--check')) {
  const committedBody = splitHeader(fs.readFileSync(OUTPUT, 'utf8'));
  const freshBody = buildBody();
  if (freshBody !== committedBody) {
    process.stderr.write(
      'cli/engine/vendor/static-html-parsers.mjs is stale (a fresh rebuild differs byte-for-byte). Run: node scripts/build-static-html-parsers.js\n',
    );
    process.exit(1);
  }
  process.exit(0);
}

const body = buildBody();
const output = header(digestOf(body)) + body;
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUTPUT, output);
console.log(`Generated ${path.relative(ROOT, OUTPUT)} (${(Buffer.byteLength(output) / 1024).toFixed(1)} KB)`);
