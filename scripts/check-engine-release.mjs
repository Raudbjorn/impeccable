#!/usr/bin/env node
/**
 * Release-order guard (triage decision D4).
 *
 * The launcher (skill/scripts/impeccable), the npm shim (cli/bin/cli.js), and
 * `impeccable install` all dead-end unless the engine release for the pinned
 * ENGINE_VERSION exists FIRST: the supported platform binaries and checksum
 * sidecars in this fork's engine-v<version> GitHub Release.
 * Tagging a skill release or merging new pins before those assets are
 * published breaks installs that need to download the engine.
 *
 * This script verifies, for the pinned engine version, that:
 *   1. each supported release binary impeccable-<os>-<arch> is fetchable
 *   2. each binary's .sha256 sidecar is valid and matches the binary
 *
 * Exits 0 when everything verifies, non-zero (naming what is missing or invalid)
 * otherwise. release.mjs runs it before an engine-dependent release. npm
 * platform packages are optional: the shim can download from GitHub.
 *
 *   node scripts/check-engine-release.mjs            # check the pinned ENGINE_VERSION
 *   node scripts/check-engine-release.mjs --json     # machine-readable report
 *
 * Environment:
 *   IMPECCABLE_DOWNLOAD_BASE  release root (default: the public repo's GitHub Releases)
 */
import {
  ENGINE_TARGETS,
  DEFAULT_DOWNLOAD_BASE,
  readEngineVersion,
  assetUrl,
  fetchVerifiedBinary,
} from './fetch-engine.mjs';

/**
 * Check every asset for one engine version. Returns { ok, version, base, missing }
 * where missing lists absent or invalid assets as { kind, target, what, url }.
 */
export async function checkEngineRelease({
  version = readEngineVersion(),
  base = process.env.IMPECCABLE_DOWNLOAD_BASE || DEFAULT_DOWNLOAD_BASE,
} = {}) {
  const missing = [];

  await Promise.all(
    ENGINE_TARGETS.map(async (target) => {
      try {
        await fetchVerifiedBinary(target, version, base);
      } catch (err) {
        missing.push({ kind: 'verification', target, what: err.message, url: assetUrl(version, target, base) });
      }
    })
  );

  missing.sort((a, b) => ENGINE_TARGETS.indexOf(a.target) - ENGINE_TARGETS.indexOf(b.target));

  return { ok: missing.length === 0, version, base, missing };
}

function report(result) {
  const { ok, version, base, missing } = result;
  if (ok) {
    console.log(`✓ engine v${version} release is complete: binaries + .sha256 for ${ENGINE_TARGETS.join(', ')} are verified.`);
    console.log(`  release base: ${base}`);
    return;
  }
  console.error(`✗ engine v${version} release is INCOMPLETE — ${missing.length} target(s) failed verification:`);
  for (const m of missing) {
    console.error(`  · ${m.what}`);
    console.error(`      ${m.url}`);
  }
  console.error('');
  console.error(`Publish engine-v${version} with its binaries and .sha256 sidecars before`);
  console.error('releasing the skill/CLI or merging new engine pins. See docs/ENGINE.md.');
  console.error(`  release base: ${base}`);
}

async function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  const result = await checkEngineRelease();
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    report(result);
  }
  return result.ok ? 0 : 1;
}

// Run only when invoked directly, not when imported by release.mjs.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}
