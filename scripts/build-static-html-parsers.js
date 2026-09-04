#!/usr/bin/env node

/**
 * Generates cli/engine/vendor/static-html-parsers.mjs
 * by bundling htmlparser2, css-select, css-tree, and domutils for skill/plugin installs.
 *
 * Run: node scripts/build-static-html-parsers.js
 * Check: node scripts/build-static-html-parsers.js --check
 * List bundled packages (JSON): node scripts/build-static-html-parsers.js --list-packages
 *
 * --output <path> overrides the committed bundle path for --check, so tests
 * can point it at a disposable copy instead of tampering with the real file.
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
const HEADER_PREFIX = `/**
 * GENERATED -- do not edit. Source: scripts/lib/static-html-parsers.entry.mjs
`;

// bun's bundler prefixes each concatenated module with a comment naming its
// path relative to wherever node_modules physically resolves to (through
// symlinks, if any) -- not relative to --outfile. That makes the raw output
// depend on the checkout's location and layout: the same source, built from
// two different directories (or through a symlinked node_modules), produces
// byte-different files. Every such line is exactly a bare path comment (no
// other `//`-line shape appears in this bundle), so strip them outright --
// they carry no functional meaning, and removing them is what makes the
// committed output reproducible across machines and CI checkouts.
const MODULE_PATH_COMMENT_RE = /^\/\/ (?:\.\.\/)*\S+\.(?:mjs|cjs|jsx?|tsx?|json)\n/gm;

function stripModulePathComments(body) {
  return body.replace(MODULE_PATH_COMMENT_RE, '');
}

// Builds the bundle to `outfile` fresh via `bun build`, which resolves and
// inlines the full dependency graph (including transitive packages like
// source-map-js) from the current lockfile -- so this reflects any change
// anywhere in that graph, not just the direct packages' own versions.
function rawBuild(outfile) {
  const result = spawnSync(
    'bun',
    ['build', ENTRY, '--outfile', outfile, '--target', 'node', '--format', 'esm'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    const error = new Error(result.stderr || result.stdout || 'bun build failed');
    error.exitCode = result.status ?? 1;
    throw error;
  }
  return fs.readFileSync(outfile, 'utf8');
}

function withTempBuild(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impeccable-static-html-parsers-'));
  try {
    return fn(rawBuild(path.join(tmpDir, 'bundle.mjs')));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function buildBody() {
  return withTempBuild(stripModulePathComments);
}

// The module-path comments this script strips from the shipped bundle are
// also the only place that names every package (direct and transitive) bun
// actually inlined -- read them from a throwaway, unstripped build instead
// of re-deriving the dependency graph another way.
function listBundledPackages() {
  return withTempBuild((raw) => [
    ...new Set([...raw.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)\//g)].map((m) => m[1])),
  ].sort());
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

function splitHeader(content, sourcePath) {
  const end = content.indexOf(HEADER_END);
  if (end === -1 || !content.startsWith(HEADER_PREFIX)) {
    throw new Error(`${path.relative(ROOT, sourcePath)} is missing its generated header`);
  }
  return content.slice(end + HEADER_END.length);
}

function outputOverride() {
  const flagIndex = process.argv.indexOf('--output');
  return flagIndex === -1 ? OUTPUT : process.argv[flagIndex + 1];
}

try {
  if (process.argv.includes('--list-packages')) {
    console.log(JSON.stringify(listBundledPackages()));
    process.exit(0);
  }

  if (process.argv.includes('--check')) {
    const target = outputOverride();
    const committedBody = splitHeader(fs.readFileSync(target, 'utf8'), target);
    const freshBody = buildBody();
    if (freshBody !== committedBody) {
      process.stderr.write(
        `${path.relative(ROOT, target)} is stale (a fresh rebuild differs byte-for-byte). Run: node scripts/build-static-html-parsers.js\n`,
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
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
  process.exit(error?.exitCode ?? 1);
}
