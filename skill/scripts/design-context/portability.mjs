/** Taking a design context out of a project, and putting one into another.
 *
 * Two shapes, because they answer different questions. `design-context.md` is
 * for a reader, human or otherwise: one document that says what was decided
 * and why, which can be handed to another tool as the rules to follow. The
 * bundle is for this toolchain: everything needed to rebuild the store
 * somewhere else, including the bytes of the files the user supplied.
 *
 * The bundle carries the schema version, not the store. A store file's era is
 * readable from its own keys, and stamping the browser's submission would mean
 * rewriting what it sent.
 */

import { readFile, mkdir, readdir, rm, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import {
  paths,
  readAnswers,
  readContext,
  readJsonSoft,
  writeAnswers,
  writeContext,
  writeJsonAtomic,
  SCHEMA_VERSION,
} from './store.mjs';

const BUNDLE_KIND = 'impeccable-design-context';
const BUNDLE_SCHEMA = 1;

/* Generated cue PNGs run a few megabytes, so the per-file cap must clear
   them; MAX_BUNDLE_BYTES still bounds the whole. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;

const MIME = new Map([
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.gif', 'image/gif'],
  ['.woff2', 'font/woff2'], ['.woff', 'font/woff'], ['.ttf', 'font/ttf'], ['.otf', 'font/otf'],
]);

/* Exactly the three places an export puts bytes, and so exactly the three an
   import will write them back to. Anything else in a bundle is not ours.
   The negative lookahead excludes a bare "." or ".." as the file segment:
   without it, "assets/.." matches assets/[^/]+ (".." has no slash in it),
   resolves to the assets directory's parent, and writeFile() on a directory
   throws EISDIR instead of hitting the containment check below at all.
   The segment also excludes a literal backslash: on Windows, path.resolve
   treats "\" as a separator too, so "assets/..\answers.json" (no forward
   slash, so [^/]+ alone accepts it whole) resolves to the store's own
   answers.json, and the containment check below allows it right back in
   because that stays inside storeDir -- a bundle overwriting the record
   it was meant to only add to. No legitimate exported filename (see the
   MIME extension list above) ever contains a backslash. */
const ALLOWED_FILE = /^(assets\/(?!\.{1,2}$)[^/\\]+|fonts\/(?!\.{1,2}$)[^/\\]+|cue\.png)$/;

const SURFACE_LABELS = { persuade: 'Landing page', operate: 'Tool', read: 'Docs', experience: 'Portfolio' };
const ROLES = ['primary', 'secondary', 'tertiary', 'neutral'];
const PER_SURFACE = ['color-strategy', 'boundary-style', 'corner-style', 'depth-style', 'motion-energy'];

/* ============================================================
   Export
   ============================================================ */

async function collectFiles(cwd, { includeAssets = true } = {}) {
  const target = paths(cwd);
  const files = [];
  const skipped = [];
  let total = 0;

  const take = async (absolute, relative) => {
    // A symlink under the store could point anywhere on disk (a cloned
    // repo can carry one pointing at a local credential); readFile()
    // follows it, and the export bundle is meant to be handed to someone
    // else, so a followed link would base64-embed whatever it points at.
    // None of assets/, fonts/, or cue.png legitimately holds a link.
    let stat;
    try {
      stat = await lstat(absolute);
    } catch {
      return;
    }
    if (!stat.isFile()) {
      skipped.push({
        path: relative,
        bytes: 0,
        reason: stat.isSymbolicLink() ? 'symlink, not a real file' : 'not a regular file',
      });
      return;
    }
    let bytes;
    try {
      bytes = await readFile(absolute);
    } catch {
      return;
    }
    if (bytes.length > MAX_FILE_BYTES || total + bytes.length > MAX_BUNDLE_BYTES) {
      skipped.push({ path: relative, bytes: bytes.length, reason: 'too large for the bundle' });
      return;
    }
    total += bytes.length;
    files.push({
      path: relative,
      mime: MIME.get(path.extname(relative).toLowerCase()) || 'application/octet-stream',
      base64: bytes.toString('base64'),
    });
  };

  if (!includeAssets) return { files, skipped };

  for (const [dir, prefix] of [[target.assetsDir, 'assets'], [target.fontsDir, 'fonts']]) {
    let names = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) await take(path.join(dir, name), `${prefix}/${name}`);
  }
  await take(target.cuePng, 'cue.png');
  return { files, skipped };
}

async function buildBundle(cwd, { includeAssets = true, now = new Date() } = {}) {
  const target = paths(cwd);
  /* The pickerless interview seed (document.md's default path today) never
     writes answers.json: it writes DESIGN.md straight from the chat and, when
     the user supplied files, stages them under assets/. Requiring answers.json
     here made export fail for every fresh seed even with DESIGN.md and staged
     assets on disk. Missing answers is only a hard failure once nothing else
     is on record either, checked below once designMd and files are known.

     Preserved as `null` rather than coerced to `{}` so the import side can
     tell "the source had no questionnaire" apart from "the source answered
     every screen with empty defaults". The downstream `document.md` and
     `design-context.md` flows both key off the existence of `answers.json`
     to recognise a completed questionnaire, so an import that synthesizes
     an empty object would install a record that reads as fully answered. */
  const answers = await readAnswers(cwd);

  const stored = (await readContext(cwd)) || { schemaVersion: SCHEMA_VERSION };
  const cues = await readJsonSoft(target.cuesJson);
  const source = typeof answers?.['palette-source'] === 'string' ? answers['palette-source'] : '';
  /* A seed or custom palette names no cue, so there is no image and no dealt
     entry to carry. The hexes in the answers are the palette of record. */
  const chosenCuePalette = source && cues?.palette?.[source] ? cues.palette[source] : null;

  const { files, skipped } = await collectFiles(cwd, { includeAssets });
  let designMd = null;
  try {
    designMd = await readFile(path.resolve(cwd, 'DESIGN.md'), 'utf8');
  } catch {
    /* Not written yet, which an import is told about rather than guessing. */
  }

  if (!answers && !files.length && !designMd) {
    throw new Error('No design interview found. Run /impeccable document to create one.');
  }

  return {
    schemaVersion: BUNDLE_SCHEMA,
    kind: BUNDLE_KIND,
    exportedAt: now.toISOString(),
    product: { name: stored.context?.product?.name || '' },
    context: stored,
    answers,
    /* Whole, never trimmed: the questionnaire validates the manifest by its
       pair count and quietly falls back to its own set at any other number. */
    fonts: await readJsonSoft(target.fontsManifestJson),
    chosenCue: chosenCuePalette ? { slug: source, palette: chosenCuePalette } : null,
    designMd,
    files,
    ...(skipped.length ? { skipped } : {}),
  };
}

/* ============================================================
   The readable compilation
   ============================================================ */

const line = (label, value) => (value ? `- **${label}:** ${value}\n` : '');

function paletteTable(answers) {
  const rows = ROLES
    .map((role) => [role, String(answers[`palette-${role}`] || '')])
    .filter(([, hex]) => hex);
  if (!rows.length) return '';
  return `| Role | Value |\n| --- | --- |\n${rows.map(([role, hex]) => `| ${role} | \`${hex}\` |`).join('\n')}\n\n`;
}

/* `_chosen` (document.md's own name for the field) is a JSON-encoded array of
   the per-surface keys the user actually set; a `<key>-<mode>` field present
   in `answers` but missing from it is a preset minted when the surface was
   switched on, not a decision. Without this, an export declared "source of
   truth" reads a preset default back as if the user picked it. */
function chosenKeys(answers) {
  const raw = answers._chosen;
  try {
    if (typeof raw === 'string') return new Set(JSON.parse(raw));
    if (Array.isArray(raw)) return new Set(raw);
  } catch { /* malformed _chosen: fall through to "unknown", not "none chosen" */ }
  return null;
}

function perSurfaceTable(answers, surfaces) {
  const chosen = chosenKeys(answers);
  const rows = [];
  for (const key of PER_SURFACE) {
    for (const mode of surfaces) {
      const fieldKey = `${key}-${mode}`;
      const value = answers[fieldKey];
      if (!value) continue;
      const provisional = chosen ? !chosen.has(fieldKey) : false;
      rows.push([key, SURFACE_LABELS[mode] || mode, String(value), answers[key] === value, provisional]);
    }
  }
  if (!rows.length) return '';
  return `| Question | Surface | Answer |\n| --- | --- | --- |\n${rows
    .map(([key, label, value, leads, provisional]) => `| ${key} | ${label}${leads ? ' (leads)' : ''} | ${value}${provisional ? ' (preset, not chosen)' : ''} |`)
    .join('\n')}\n\n`;
}

/** One document a reader, or another tool, can follow without this toolchain. */
function renderMarkdown(bundle) {
  const context = bundle.context?.context || {};
  const answers = bundle.answers || {};
  const name = bundle.product?.name || 'This product';
  const surfaces = [].concat(answers['surface-modes'] || []).filter(Boolean);
  const out = [];

  out.push(`# Design context: ${name}\n\n`);
  out.push('The decisions this product\'s design follows, and the reasoning behind them. ');
  out.push('Exported from Impeccable; treat it as the source of truth for visual and product direction.\n\n');

  const audience = context.audience || {};
  if (Object.keys(audience).length) {
    out.push('## Audience\n\n');
    out.push(line('Primary', audience.primary));
    out.push(line('Secondary', audience.secondary));
    out.push(line('On arrival', audience.emotion));
    out.push(line('Leaving with', audience.leaving));
    if (audience.needs?.length) out.push(`- **Needs:** ${audience.needs.join('; ')}\n`);
    if (audience.trust?.length) out.push(`- **Trust triggers:** ${audience.trust.join('; ')}\n`);
    if (audience.inclusion?.length) out.push(`- **Must not exclude:** ${audience.inclusion.join('; ')}\n`);
    out.push('\n');
  }

  const product = context.product || {};
  if (Object.keys(product).length) {
    out.push('## Product\n\n');
    out.push(line('Purpose', product.purpose));
    out.push(line('Success', product.success));
    out.push(line('Platform', product.platform));
    out.push(line('Primary conversion', product.conversion));
    if (product.positioning?.not) out.push(`- **Not this:** ${product.positioning.not}\n`);
    if (product.positioning?.this) out.push(`- **This:** ${product.positioning.this}\n`);
    if (product.clarities?.length) out.push(`- **Clear first:** ${product.clarities.join('; ')}\n`);
    out.push('\n');
  }

  const brand = context.brand || {};
  if (Object.keys(brand).length) {
    out.push('## Brand\n\n');
    if (brand.words?.length) out.push(line('Words', brand.words.join(', ')));
    out.push(line('Personality', brand.personality));
    if (brand.commitments?.length) out.push(`- **Commitments:** ${brand.commitments.join('; ')}\n`);
    if (brand.voice?.length) {
      out.push('\nVoice, as wording rather than adjectives:\n\n');
      for (const pair of brand.voice) {
        if (pair?.say && pair?.not) out.push(`- Say: ${pair.say}\n  Not: ${pair.not}\n`);
      }
    }
    out.push('\n');
  }

  const interview = context.interview || {};
  if (interview.references?.length || interview.antiReference) {
    out.push('## References\n\n');
    for (const reference of interview.references || []) {
      if (typeof reference === 'string') out.push(`- ${reference}\n`);
      else if (reference?.name) out.push(`- **${reference.name}**${reference.takeaway ? `: ${reference.takeaway}` : ''}\n`);
    }
    const anti = interview.antiReference;
    if (typeof anti === 'string') out.push(`- **Anti-reference:** ${anti}\n`);
    else if (anti?.name) out.push(`- **Anti-reference:** ${anti.name}${anti.why ? ` (${anti.why})` : ''}\n`);
    out.push('\n');
  }

  out.push('## Decisions\n\n');
  if (surfaces.length) {
    out.push(`Surfaces: ${surfaces.map((mode) => SURFACE_LABELS[mode] || mode).join(', ')}. `);
    out.push('The first of these owns any answer stated once for the whole product.\n\n');
  }
  out.push('### Palette\n\n');
  out.push(paletteTable(answers));
  if (bundle.chosenCue?.slug) out.push(`Sampled from the generated cue \`${bundle.chosenCue.slug}\`.\n\n`);

  out.push('### Typography\n\n');
  out.push(line('Heading', answers['font-heading']));
  out.push(line('Body', answers['font-body']));
  out.push(line('Type scale', answers['type-scale'] && `${answers['type-scale']} (${answers['type-scale-ratio']})`));
  out.push('\n');

  if (answers['icon-pack-name']) {
    out.push('### Icons\n\n');
    out.push(`- **Pack:** ${answers['icon-pack-name']}${answers['icon-pack-license'] ? ` (${answers['icon-pack-license']})` : ''}\n`);
    if (answers['icon-pack-url']) out.push(`- **Source:** ${answers['icon-pack-url']}\n`);
    out.push('\nEvery icon comes from this pack; do not mix sets.\n\n');
  }

  const perSurface = perSurfaceTable(answers, surfaces);
  if (perSurface) {
    out.push('### Per surface\n\n');
    out.push(perSurface);
  }
  if (answers['layout-structure']) out.push(`Composition: ${answers['layout-structure']}, one answer for the whole product.\n\n`);

  if (bundle.designMd) {
    out.push('## DESIGN.md\n\n');
    out.push('The design document this context produced, verbatim.\n\n');
    out.push('<!-- begin DESIGN.md -->\n\n');
    out.push(bundle.designMd.trim());
    out.push('\n\n<!-- end DESIGN.md -->\n');
  }

  return out.join('');
}

export async function exportDesignContext(cwd, { outDir, includeAssets = true, now } = {}) {
  const bundle = await buildBundle(cwd, { includeAssets, now });
  const destination = outDir ? path.resolve(cwd, outDir) : paths(cwd).exportsDir;
  await mkdir(destination, { recursive: true });

  const markdownPath = path.join(destination, 'design-context.md');
  const bundlePath = path.join(destination, 'design-context.bundle.json');
  await writeFile(markdownPath, renderMarkdown(bundle));
  await writeJsonAtomic(bundlePath, bundle);
  return { markdownPath, bundlePath, skipped: bundle.skipped || [] };
}

/* ============================================================
   Import
   ============================================================ */

export function validateBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') throw new Error('That file is not a design context bundle');
  if (bundle.kind !== BUNDLE_KIND) throw new Error(`Expected a ${BUNDLE_KIND} bundle, found ${String(bundle.kind)}`);
  if (bundle.schemaVersion !== BUNDLE_SCHEMA) {
    throw new Error(`This bundle is schema version ${String(bundle.schemaVersion)}; this release reads ${BUNDLE_SCHEMA}. Update impeccable.`);
  }
  /* `answers: null` is the explicit "no questionnaire was answered"
     signal (the pickerless interview seed path); an object is the normal
     carried-record path. Anything else (undefined, a string, a number) is a
     malformed bundle. */
  if (bundle.answers !== null && (typeof bundle.answers !== 'object' || Array.isArray(bundle.answers))) {
    throw new Error('The bundle carries no answers');
  }
  return bundle;
}

export async function importDesignContext(cwd, bundle, { design = 'skip', force = false } = {}) {
  validateBundle(bundle);
  const target = paths(cwd);

  /* A forced import replaces the store; a plain one only ever runs against an
     empty one (design-context-import.mjs refuses otherwise). Without this,
     replacing an existing context only ever adds and overwrites what the new
     bundle names: an asset the old context had and the new one does not
     survives beside the new answers that no longer mention it, and the cue
     manifest and font manifest below, guarded on "nothing there yet", never
     update to the imported project's own choices. Clear the managed areas
     first so the store ends up exactly what the bundle describes, not a
     merge of the two. */
  if (force) {
    await rm(target.assetsDir, { recursive: true, force: true });
    await rm(target.fontsDir, { recursive: true, force: true });
    await rm(target.cuePng, { force: true });
    await rm(target.cuesJson, { force: true });
    await rm(target.fontsManifestJson, { force: true });
  }

  /* The questionnaire's existence is the trigger downstream readers key
     off, so the absent-answers signal must reach disk as an absent file,
     not as `{}` written under the same path. A bundle that does carry
     answers writes them as usual. */
  if (bundle.answers !== null) await writeAnswers(bundle.answers, cwd);
  const context = bundle.context && typeof bundle.context === 'object'
    ? bundle.context
    : { schemaVersion: SCHEMA_VERSION };
  await writeContext(context, cwd);

  let written = 0;
  for (const file of Array.isArray(bundle.files) ? bundle.files : []) {
    const relative = String(file?.path || '');
    /* Containment is not enough on its own: a bundle could otherwise name a
       store file and overwrite what was just written. Only the three places an
       export puts bytes are accepted. */
    if (!ALLOWED_FILE.test(relative)) {
      process.stderr.write(`Skipped ${relative || '(unnamed)'}: not a place a design context keeps files\n`);
      continue;
    }
    const absolute = path.resolve(target.storeDir, relative);
    const contained = path.relative(target.storeDir, absolute);
    // A real file's relative path is never empty; an empty result means
    // `relative` resolved to storeDir itself (writeFile() on a directory
    // throws EISDIR, uncaught, rather than skipping), same failure the
    // ALLOWED_FILE lookahead above already closes off, kept here in case a
    // future entry point reaches this loop past a differently-shaped check.
    if (!contained || contained.startsWith('..')) continue;
    /* Containment is also not enough against a symlink in the destination
       path: a plain import into a project whose `assets/` or `fonts/` is a
       pre-existing link to somewhere outside the store would follow that
       link and write the bundle's bytes wherever it points. Walk from the
       file's parent up to the store root, refuse any link along the way,
       and also refuse a link at the file itself if one already exists.
       `mkdir({recursive:true})` is still safe: on POSIX it refuses to
       traverse a symlinked directory component, so the walk is what
       actually blocks the follow. */
    let blocked = false;
    for (let cursor = path.dirname(absolute); cursor.startsWith(target.storeDir) && cursor !== target.storeDir; cursor = path.dirname(cursor)) {
      let parentStat;
      try {
        parentStat = await lstat(cursor);
      } catch {
        /* Parent does not yet exist (mkdir below will create it) or has
           already gone: nothing to check. */
        break;
      }
      if (parentStat.isSymbolicLink()) {
        process.stderr.write(`Skipped ${relative}: a symlinked component in the destination path would write outside the store\n`);
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    let existing;
    try {
      existing = await lstat(absolute);
    } catch {
      existing = null;
    }
    if (existing?.isSymbolicLink()) {
      process.stderr.write(`Skipped ${relative}: a pre-existing symlink at the destination would be followed\n`);
      continue;
    }
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, Buffer.from(String(file.base64 || ''), 'base64'));
    written += 1;
  }

  /* The questionnaire cannot run without a cue manifest: its palette screen
     loads the deck and the built-in seeds together, and neither arrives if the
     file is missing. An imported project gets a valid one either way, carrying
     the chosen cue's dealt values when the bundle brought them. */
  if (!(await readJsonSoft(target.cuesJson))) {
    await writeJsonAtomic(target.cuesJson, {
      cues: [],
      ...(bundle.chosenCue?.slug ? { palette: { [bundle.chosenCue.slug]: bundle.chosenCue.palette } } : { palette: {} }),
    });
  }
  if (bundle.fonts && !(await readJsonSoft(target.fontsManifestJson))) {
    await writeJsonAtomic(target.fontsManifestJson, bundle.fonts);
  }

  let designWritten = false;
  if (design === 'write' && typeof bundle.designMd === 'string' && bundle.designMd.trim()) {
    const designPath = path.resolve(cwd, 'DESIGN.md');
    if (!(await readFile(designPath, 'utf8').then(() => true).catch(() => false))) {
      await writeFile(designPath, bundle.designMd);
      designWritten = true;
    }
  }

  return { written, designWritten, designCarried: typeof bundle.designMd === 'string' && Boolean(bundle.designMd.trim()) };
}
