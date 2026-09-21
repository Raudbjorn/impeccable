#!/usr/bin/env node
// `impeccable` npm shim: finds the platform binary and execs it with argv.
// Order: $IMPECCABLE_BIN, the @impeccable/cli-<os>-<arch> optional dependency,
// the version-pinned user cache (~/.impeccable/bin/<version>/), then a
// download into that cache from the public release channel.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');
const OS = process.platform;
const ARCH = process.arch;
const TARGET = `${OS}-${ARCH}`;
const EXE = 'impeccable';
const PLATFORM_PKG = `@impeccable/cli-${TARGET}`;
// The engine version travels as the pinned optionalDependency range.
const VERSION = String(pkg.optionalDependencies?.[PLATFORM_PKG] || Object.values(pkg.optionalDependencies || {})[0] || '').replace(/^[^\d]*/, '');
const CACHE_ROOT = process.env.IMPECCABLE_HOME || path.join(os.homedir(), '.impeccable');
const CACHED = path.join(CACHE_ROOT, 'bin', VERSION, EXE);
const BASE = (process.env.IMPECCABLE_DOWNLOAD_BASE || 'https://github.com/Raudbjorn/impeccable/releases/download').replace(/\/$/, '');
const URL = `${BASE}/engine-v${VERSION}/impeccable-${TARGET}`;

function exists(p) { try { return !!p && fs.statSync(p).isFile(); } catch { return false; } }
// npm writes a repository URL several ways for the same repo (`git+https://`,
// bare `https://`, with or without `.git`, or the `github:owner/name`
// shorthand), so compare the repo it identifies rather than the string. A
// package that names a different repo is another distribution's build and is
// declined; the reason is printed, because silently falling through to a
// download looks identical to having no package at all.
function repoIdentity(repository) {
  const url = typeof repository === 'string' ? repository : repository?.url;
  if (!url) return null;
  const m = String(url).match(/(?:github\.com[/:]|^github:)([^/]+)\/([^/#]+?)(?:\.git)?(?:#.*)?$/i);
  return m ? `${m[1].toLowerCase()}/${m[2].toLowerCase()}` : String(url);
}
function fromPackage() {
  let manifest;
  try { manifest = require.resolve(`${PLATFORM_PKG}/package.json`); } catch { return null; }
  try {
    const installed = require(manifest);
    const want = repoIdentity(pkg.repository);
    const got = repoIdentity(installed.repository);
    if (installed.version !== VERSION) {
      process.stderr.write(`impeccable: ignoring ${PLATFORM_PKG}@${installed.version}; this build pins ${VERSION}.\n`);
      return null;
    }
    if (want && got !== want) {
      process.stderr.write(`impeccable: ignoring ${PLATFORM_PKG} built from ${got ?? 'an unknown repo'}; this build expects ${want}.\n`);
      return null;
    }
    return path.join(path.dirname(manifest), 'bin', EXE);
  } catch (err) {
    process.stderr.write(`impeccable: ignoring unreadable ${PLATFORM_PKG} (${err.message}).\n`);
    return null;
  }
}
async function download() {
  if (!VERSION) return null;
  const res = await fetch(URL, { redirect: 'follow' });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  // Fail closed, like the skill launcher and `impeccable install`: a sidecar
  // that cannot be fetched, or that carries no hash, refuses the download
  // instead of caching an unverified binary. Nothing is written until the
  // hash matches, so a refusal leaves the cache dir untouched.
  const sum = await fetch(`${URL}.sha256`, { redirect: 'follow' }).then(r => (r.ok ? r.text() : ''), () => '');
  const expected = sum.trim().split(/\s+/)[0].toLowerCase();
  if (!expected) {
    throw new Error(
      `cannot verify ${URL} against ${URL}.sha256 (sidecar unavailable or empty); `
      + 'refusing the unverified download',
    );
  }
  if (createHash('sha256').update(buf).digest('hex') !== expected) {
    throw new Error(`checksum mismatch downloading ${URL}`);
  }
  fs.mkdirSync(path.dirname(CACHED), { recursive: true });
  const tmp = `${CACHED}.part.${process.pid}`;
  try {
    fs.writeFileSync(tmp, buf, { mode: 0o755 });
    fs.renameSync(tmp, CACHED);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw err;
  }
  return CACHED;
}
async function locate() {
  const envBin = process.env.IMPECCABLE_BIN;
  if (exists(envBin)) return envBin;
  const fromPkg = fromPackage();
  if (exists(fromPkg)) return fromPkg;
  if (exists(CACHED)) return CACHED;
  return download().catch((err) => { process.stderr.write(`impeccable: ${err.message}\n`); return null; });
}

// `--version` / `-v` is answered by the shim itself: the number users mean
// is this npm package's version, not the engine's (docs/CLI-CONTRACT.md).
const argv = process.argv.slice(2);
if (argv[0] === '--version' || argv[0] === '-v') {
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}

if (OS !== 'linux' || ARCH !== 'x64') {
  process.stderr.write(`impeccable: unsupported platform ${TARGET}; supported: linux-x64.\n`);
  process.exit(127);
}

const bin = await locate();
if (!bin) {
  process.stderr.write(
    `impeccable: no binary for ${TARGET}. Install ${PLATFORM_PKG}@${VERSION}, set IMPECCABLE_BIN, `
    + `or download impeccable-${TARGET} v${VERSION} from ${BASE} into ${CACHED}.\n`,
  );
  process.exit(127);
}
const result = spawnSync(bin, argv, {
  stdio: 'inherit',
  env: { IMPECCABLE_SELF: 'npx impeccable', ...process.env },
});
if (result.error) {
  process.stderr.write(`impeccable: failed to run ${bin}: ${result.error.message}\n`);
  process.exit(127);
}
process.exit(result.status === null ? 1 : result.status);
