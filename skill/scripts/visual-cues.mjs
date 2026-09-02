#!/usr/bin/env node
// visual-cues.mjs — compile step for document seed visual cues.
// Pipeline doc: skill/reference/visual-cues.md (canonical; this help text is not).
//
// Each cue is one full-bleed hero scene staging a planned four-color palette.
//
//   node visual-cues.mjs compile <hero.png> --slug <two-word-slug>
//       [--palette "primary=#RRGGBB;secondary=...;tertiary=...;neutral=..."]
//       [--out <dir>]   (default: .impeccable/visual-cues)
//     Copies the hero untouched to <slug>.png (removing the source when it
//     is an intermediate inside <out>, so the folder holds one file per
//     cue, not a byte-identical pair), finds each planned palette hex's
//     closest pixel in the hero, and updates <out>/cues.json.
//     The hero must be square: generation happens on a square canvas
//     (a size/aspect parameter, not just a prompt line), and a non-square
//     input is a generation to redo, not an image to fix up here.
//
//   node visual-cues.mjs hash <path...>
//     Prints one sha256 per file (portable md5/md5sum stand-in): Step 5's
//     uniqueness gate, catching two subagents that raced onto one default
//     output filename before compile ever runs.
//
// PNG decode is the shared decoder in lib/png.mjs (handles every color
// type, bit depth, and interlacing); this script only needs RGBA pixels.

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, realpathSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodePng } from './lib/png.mjs';

// The pipeline ships squares, and squaring after the fact always loses
// something (cropping eats scene, padding invents background), so square
// is required at the source: the generation call must pin a 1:1 canvas.
// A non-square input here means that call must be redone.
function requireSquare(img, label) {
  if (img.width !== img.height) {
    throw new Error(`${label} is ${img.width}x${img.height}, not square; regenerate it with the tool's square (1:1) size/aspect parameter, a prompt line alone does not pin the canvas`);
  }
}

// ----------------------------------------------------------------- palette

// role=#RRGGBB per entry; a legacy trailing @x,y is accepted and ignored
// (the search below beats model-reported coordinates every time).
const PALETTE_ENTRY = /^([a-z][a-z-]*)=(#[0-9a-fA-F]{6})(?:@\d+,\d+)?$/;

function parsePalette(str) {
  const out = {};
  for (const part of str.split(';')) {
    const m = part.trim().match(PALETTE_ENTRY);
    if (!m) throw new Error(`bad palette entry "${part.trim()}" (expected role=#RRGGBB)`);
    out[m[1]] = { hex: m[2].toUpperCase() };
  }
  return out;
}

// The parent designed the palette, so the planned hex is known; what needs
// measuring is where and how faithfully the hero staged it. Search the whole
// hero for the pixel closest to each planned hex. hex stays the planned
// value; snapped is the closest rendered pixel; at is its hero position.
function snapPalette(img, palette) {
  const out = {};
  // Sample on a grid instead of every pixel: ~150 samples per axis is dense
  // enough to find a representative patch of any staged color, and scanning
  // a 1500x1500 hero at full resolution for every role adds up otherwise.
  const step = Math.max(1, Math.floor(Math.min(img.width, img.height) / 150));
  for (const [role, entry] of Object.entries(palette)) {
    const pr = parseInt(entry.hex.slice(1, 3), 16);
    const pg = parseInt(entry.hex.slice(3, 5), 16);
    const pb = parseInt(entry.hex.slice(5, 7), 16);
    let best = Infinity;
    let bx = 0;
    let by = 0;
    // Squared Euclidean distance in RGB space; skipping the sqrt is fine
    // since only the relative ordering of distances matters here.
    for (let y = 0; y < img.height; y += step) {
      for (let x = 0; x < img.width; x += step) {
        const o = (y * img.width + x) * 4;
        const dr = img.data[o] - pr;
        const dg = img.data[o + 1] - pg;
        const db = img.data[o + 2] - pb;
        const d = dr * dr + dg * dg + db * db;
        if (d < best) { best = d; bx = x; by = y; }
      }
    }
    const o = (by * img.width + bx) * 4;
    const snapped = `#${[img.data[o], img.data[o + 1], img.data[o + 2]]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()}`;
    out[role] = { hex: entry.hex, snapped, at: [bx, by] };
  }
  return out;
}

// ---------------------------------------------------------------- cues.json

// Reads the existing cues.json (if any) and merges this cue in, so compiling
// the six concepts one after another accumulates into one shared manifest
// instead of each compile overwriting the last.
function updateCuesJson(outDir, slug, palette) {
  const path = join(outDir, 'cues.json');
  let data = {};
  if (existsSync(path)) data = JSON.parse(readFileSync(path, 'utf8'));
  data.cues = data.cues || [];
  if (!data.cues.includes(slug)) data.cues.push(slug);
  if (palette) {
    data.palette = data.palette || {};
    data.palette[slug] = palette;
  }
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  return data;
}

// -------------------------------------------------------------------- CLI

// Minimal flag parser: positional args collect into `_`, everything after
// a `--name` becomes args.name. Good enough for this script's small,
// fixed set of options; no need for a dependency here.
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

// Errors surface as JSON on stderr (matching the success shape on stdout)
// so the calling agent can parse either outcome the same way.
function fail(msg) {
  console.error(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

function cmdCompile(args) {
  const [heroFile] = args._;
  const slug = args.slug;
  if (!heroFile || !slug) {
    fail('usage: visual-cues.mjs compile <hero.png> --slug <slug> [--palette "..."] [--out <dir>]');
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)+$/.test(slug)) fail(`slug "${slug}" must be lowercase words joined by hyphens (e.g. amber-dusk)`);
  const outDir = resolve(args.out || '.impeccable/visual-cues');
  const hero = decodePng(readFileSync(resolve(heroFile)));
  requireSquare(hero, 'hero');

  mkdirSync(outDir, { recursive: true });
  const heroPath = join(outDir, `${slug}.png`);
  const srcPath = resolve(heroFile);
  copyFileSync(srcPath, heroPath); // the hero ships untouched, no crop
  // Subagents drop `<slug>-hero.png` intermediates into the out dir; once
  // the canonical `<slug>.png` exists, that intermediate is a byte-identical
  // duplicate that doubles the folder, so remove it. A source outside the
  // out dir (a native tool's own output folder) is not ours to delete.
  if (srcPath !== heroPath && dirname(srcPath) === outDir) unlinkSync(srcPath);

  // --palette is optional: the agent may compile before it has finished
  // designing the palette, and can re-run compile later once it has hexes.
  let palette = null;
  if (args.palette) palette = snapPalette(hero, parsePalette(args.palette));

  updateCuesJson(outDir, slug, palette);

  console.log(JSON.stringify({
    ok: true,
    slug,
    hero: heroPath,
    palette,
    cuesJson: join(outDir, 'cues.json'),
  }, null, 2));
}

// The uniqueness gate (Step 5 of visual-cues.md): two subagents racing on a
// shared default output filename produce identical bytes under two paths,
// and that is the one duplication compile's own per-file checks (square,
// slug shape) never catch, because each hero is compiled on its own. `md5`
// exists on macOS but not stock Linux (`md5sum` does, with a different
// output format); sha256 via node:crypto works identically everywhere this
// toolchain already requires node to run at all.
function cmdHash(args) {
  const files = args._;
  if (!files.length) fail('usage: visual-cues.mjs hash <path...>');
  for (const file of files) {
    const digest = createHash('sha256').update(readFileSync(resolve(file))).digest('hex');
    console.log(`${digest}  ${file}`);
  }
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  try {
    if (cmd === 'compile') cmdCompile(args);
    else if (cmd === 'hash') cmdHash(args);
    else fail('usage: visual-cues.mjs compile <hero.png> --slug <slug> [options] | hash <path...> (see reference/visual-cues.md)');
  } catch (err) {
    fail(err.message);
  }
}

// Only auto-run when invoked directly (`node visual-cues.mjs ...`), not
// when another module imports it. import.meta.url is Node's realpath of
// the entry file, so
// argv[1] must be realpath'd too, not just path.resolve'd: a skill
// installed via symlink (the standard `skills link`/install path) makes
// argv[1] the symlink path, which never equality-matches the resolved
// realpath, so main() silently never ran.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  main();
}
