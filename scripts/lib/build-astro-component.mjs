// Builds an Astro-sourced component into skill/scripts/<name>/: the shape
// scripts/build-picker.mjs pioneered for the picker, generalized so a new
// component can reuse it instead of hand-rolling the same astro-build,
// copy-to-output, sync-provider-output plumbing. See docs/add-branding.md
// for the walkthrough of adding a new component this way.
//
// skill/scripts/<name>/ is gitignored build output; `bun run build:release`
// regenerates it and syncs the result into every provider directory.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, rm } from 'node:fs/promises';
import path from 'node:path';

// - root: repo root (import.meta.url-derived in the caller)
// - name: component name; output lands at skill/scripts/<name>/
// - astroConfig: path to the component's astro.config.mjs, relative to root
// - assetsDir: optional path to a directory copied wholesale into
//   <output>/assets/. Omit when the component has no runtime assets of its
//   own (Vite already inlines anything it can see).
// - extraFiles: optional [{ from, to }] pairs copied straight into the
//   output root after the astro build, `to` relative to the output dir. For
//   files a page fetches at runtime rather than importing (a data file next
//   to the page, a favicon), so they skip Vite entirely rather than being
//   fetched through it.
export async function buildAstroComponent({ root, name, astroConfig, assetsDir = null, extraFiles = [] }) {
  const buildDir = path.join(root, `build-${name}`);
  const outputDir = path.join(root, `skill/scripts/${name}`);

  await rm(buildDir, { recursive: true, force: true });
  execFileSync('bun', ['x', 'astro', 'build', '--config', astroConfig], {
    cwd: root,
    stdio: 'inherit',
  });

  // astro build honors astroConfig's own outDir; nothing here enforces that
  // it matches build-${name}. A silent mismatch would otherwise surface as
  // an opaque ENOENT from cp() below, so name the expected directory and the
  // config that controls it while the real cause is still knowable.
  if (!existsSync(buildDir)) {
    throw new Error(
      `Expected the astro build to write to ${buildDir}, but nothing is there. `
        + `Check outDir in ${astroConfig} matches build-${name} (relative to ${root}).`,
    );
  }

  await rm(outputDir, { recursive: true, force: true });
  await cp(buildDir, outputDir, { recursive: true });

  if (assetsDir) {
    await cp(assetsDir, path.join(outputDir, 'assets'), { recursive: true });
  }
  for (const { from, to } of extraFiles) {
    await cp(from, path.join(outputDir, to), { recursive: true });
  }

  await rm(buildDir, { recursive: true, force: true });
  return outputDir;
}
