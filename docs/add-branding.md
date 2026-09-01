# The picker: a case study, and how to build a component like it

The picker was the design-context questionnaire's browser UI: an Astro-sourced
page at `picker/`, built to `skill/scripts/picker/`, served by a trio of
`*-server.mjs`/`*-doc-session.mjs`/`*-doc-poll.mjs` scripts, synced into every
provider's `skills/impeccable/scripts/`. It has since been removed from this
project, in full, along with the reference-doc sections and command
capabilities that depended on it (`design-context open`/`edit`, and Step 7 of
the seed-mode flow in `skill/reference/visual-cues.md`, which is now the only
place that flow stops short: cue generation and font-pair composition still
work, but nothing collects a palette pick or produces `answers.json`).

This document is two things: a record of what the picker was and how its
pieces fit together, kept because a future component (a replacement UI, or
something unrelated) starts from a known shape instead of guesswork; and a
practical guide, in the final chapter, for building one.

## The personalization surface the document used to have

The design-context document (`picker/scripts/dcx/dcx-document.js`, gone with
the rest of `picker/`) had two spots that showed imagery not guaranteed to
exist:

- **Brand assets** (`composeBrandAssetsArticle`, category `brand`). It read
  whatever the run's own questionnaire submission rendered into the article
  (`renderedBrandAssets()`, walking `.dcx-mark` and `.dcx-board` elements for
  marks and moodboard/reference images the user actually uploaded). When that
  list was empty, the section was skipped entirely: no placeholder fallback
  shipped by the time the file was removed.
- **Cards** (`composeComponentsArticle`, category `components`). Three demo
  cards showed "cards with media" component patterns. Their image came from
  `componentCardImageTag(cueAlt)`, which emitted a real `<img>` only when
  `window.dcxCueImageSrc` named the run's chosen visual cue; otherwise it
  emitted nothing and the card rendered text-only.

## What `<brand-name>` added

Before it was pruned, a placeholder brand called `<brand-name>` (an
atelier-style flower shop) filled both of those spots. Five image files, all
under the now-gone `picker/assets/`:

```
picker/assets/brand/placeholders/<brand-name>-primary-mark.png         768x768   logo
picker/assets/brand/placeholders/<brand-name>-atelier-seal.png         768x768   logo
picker/assets/brand/placeholders/<brand-name>-seasonal-moodboard.webp  960x720   moodboard
picker/assets/brand/placeholders/<brand-name>-material-reference.webp  960x720   reference
picker/assets/components/<brand-name>-ikebana-card.jpg                 800x1200  card photo
```

`brand/placeholders/` was the only path in the whole `picker/assets/` tree
nested two directories deep; every other category (`audience/`, `product/`,
`color/`, `typography/`, `material/`) was a flat `<category>/<file>.png`.

Two wiring points pulled those files into `dcx-document.js`:

1. A `BRAND_PLACEHOLDER_ASSETS` array, one object per file, each carrying the
   fields `composeBrandAssetsArticle` needed to render a `<figure>`: `src`
   (the `/assets/...` path above), `kind` (`"logo"` / `"moodboard"` /
   `"reference"`, which chose the caption's label), `title`, `alt`, and the
   image's own `width`/`height`. `composeBrandAssetsArticle` fell back to this
   array whenever the run's own upload list (`renderedBrandAssets()`) was
   empty: `const assets = uploaded.length ? uploaded : BRAND_PLACEHOLDER_ASSETS;`.
2. A `FALLBACK_CARD_IMAGE` constant naming the ikebana photo, read by an
   earlier `componentCardImage(fallbackAlt, cueAlt)` (later replaced by
   `componentCardImageTag`, which dropped the fallback). Rather than rendering
   nothing when there was no cue, that version always emitted a real `src`,
   either the run's cue or the vendored photo, with `data-dcx-swap-src` wired
   to a delegated error listener so a cue that failed to load swapped to the
   same fallback photo instead of showing a broken image.

The theme carried through to `tests/picker-server.test.mjs`'s fixture identity
too (both the test file and the fixtures are gone now): a font-manifest
fixture styled as a florist (nav `Bouquets`/`Workshops`/`Seasonal`, copy like
"Flowers shaped by hand", gallery items `Market bunch`/`Table vase`/`Ceremony`,
`footerMark: '© <brand-name>'`), and a separate context fixture using
`{ product: { name: '<brand-name>' } }`. Both were arbitrary sample data
(nothing asserted on the literal strings).

## The picker's own section icons

Separate from end-user branding above: the picker also had a set of
per-section icons for the design-context document's own UI chrome, not tied
to any particular brand. 26 files total, in two shapes.

24 were small square PNGs, one per detail-article subsection, grouped by
category under `picker/assets/`:

| File | Category dir | Detail label it illustrated |
| --- | --- | --- |
| `audience-groups-foil.png` | `audience/` | "Who they are" |
| `emotional-journey-foil.png` | `audience/` | "Emotional journey" / "Emotional state" |
| `needs-foil.png` | `audience/` | "Needs" |
| `trust-triggers-foil.png` | `audience/` | "Trust triggers" |
| `inclusion-foil.png` | `audience/` | "Who must not be excluded" |
| `brand-personality-foil.png` | `brand/` | "Personality" |
| `brand-voice-foil.png` | `brand/` | "Voice" |
| `brand-principles-foil.png` | `brand/` | "Principles" |
| `brand-commitments-foil.png` | `brand/` | "Commitments" |
| `color-palette-foil.png` | `color/` | "The cue" and "Palette" (shared by both) |
| `color-strategy-per-surface-foil.png` | `color/` | "Strategy per surface" |
| `material-layout-structure-foil.png` | `material/` | "Layout structure" |
| `material-boundaries-per-surface-foil.png` | `material/` | "Boundaries per surface" |
| `material-corners-per-surface-foil.png` | `material/` | "Corners per surface" |
| `material-depth-per-surface-foil.png` | `material/` | "Depth per surface" |
| `product-purpose-foil.png` | `product/` | "Purpose" |
| `product-positioning-foil.png` | `product/` | "Positioning" |
| `product-primary-conversion-foil.png` | `product/` | "Primary conversion" |
| `product-clear-first-foil.png` | `product/` | "What must be clear first" |
| `product-principles-foil.png` | `product/` | "Product principles" |
| `product-operating-context-foil.png` | `product/` | "Operating context" |
| `product-surfaces-foil.png` | `product/` | "Surfaces" |
| `typography-pair-foil.png` | `typography/` | "The pair" |
| `typography-type-scale-foil.png` | `typography/` | "Type scale" |

The other two, also under `audience/` but a different mechanism entirely:
`kinpaku-gold-leaf.png` and `verdigris-patina.png` were texture photos, not
per-section icons. They named the site's own two brand accents (`--ks-kinpaku`
and `--ks-patina` in the vendored `picker/styles/vendor/kinpaku-tokens.css`),
not a placeholder brand.

**How they were wired.** `dcx-audience.js`'s `SECTION_META` (five entries, one
per audience subsection) each carried an optional `icon: "<filename>.png"`
field; `enhanceAudienceArticle` built the `<figure><img></figure>` only
`if (meta.icon)`. `dcx-detail.js`'s `DETAIL_META[category][label]` held a
`[ledeText, iconPath?]` tuple; `enhanceSection` built the icon `<figure>` only
`if (icon)`. `dcx-rail.js` had two SVG `<pattern>` fills (`patinaPattern`,
`goldPattern`) used as the `stroke` for the "material rail" progress
indicator, one for the inactive track and one for the active/completed
segment, each layering a texture `<image>` at partial opacity over a solid
base `<rect>` (`fill: var(--ks-patina)` / `var(--ks-kinpaku)`).

## The picker's own page chrome

Three more files, plain tool chrome (the same bucket as the section icons: the
picker's own UI, not end-user content), each a different mechanism:

- **`favicon.svg`**: the browser-tab icon. One line in `Picker.astro`'s
  `<head>`: `<link rel="icon" type="image/svg+xml" href="./favicon.svg" />`.
- **`hero-dark.jpg`**: a decorative, `aria-hidden` background image behind the
  questionnaire's start screen. `index.astro` rendered it as
  `<div class="picker-hero-art" style="background-image: url('assets/hero-dark.jpg')" aria-hidden="true">`,
  positioned `absolute; inset: 0; z-index: 0` behind `#picker-form`
  (`z-index: 1`), faded to `opacity: 0` on every screen except the start and
  finish via a `:has(#picker-form[data-current="..."])` selector list (an
  opinion about screens judged "against a plain ground").
- **`kinpaku-gold-leaf.jpg`**: a texture overlay on the picker's own primary
  button, named after the same `--ks-kinpaku` gold accent. Set as a CSS custom
  property on `<body>` (`style="--pk-foil: url('/assets/kinpaku-gold-leaf.jpg')"`),
  consumed by a `.picker-page .ks-button.ks-button-primary::before`
  pseudo-element at 0.38 opacity (0.26 on hover, 0 when disabled) layered over
  the button's solid `background: var(--ks-kinpaku)` fill.

## The picker's server scripts

Three scripts under `skill/scripts/` gave the static page a live backend,
following the naming convention `<component>-server.mjs`,
`<component>-doc-session.mjs`, `<component>-doc-poll.mjs`. The shape mirrors
`skill/scripts/live/` (the live-editing overlay for a different feature),
which solves the same class of problem: a static page needs a process to talk
to, and an agent needs a one-shot way to wait on that process without holding
a connection open itself.

- **`picker-server.mjs`**: static serving of the built page and its assets,
  the boot contract (draft/answer prefill, `--fresh`, `--doc` for reopening),
  the submit endpoint (writes `answers.json`, copies the chosen cue,
  autosaves a draft as the questionnaire runs), and the spawn step: on
  submit, it forked a detached `picker-doc-session.mjs` process so the
  browser tab could stay connected to a live document after the server that
  served the initial page was done. Imported `SEEDS` from `palette.mjs` and
  the store functions from `design-context/store.mjs`.
- **`picker-doc-session.mjs`**: the session shell for the live document-edit
  loop: an HTTP server with its own port and timers, gated by a per-run token
  recorded (with its pid) in `runtime/session.json`, so a poller could find
  and trust the right session without the origin being the security boundary.
  Depended on `design-context/session-routes.mjs` (`createSaveRoutes`, HTTP
  handlers for applying a staged batch of edits to the store) and
  `design-context/bindings.mjs` (the editable-field registry those routes
  used to know where a given field lived). Both were removed alongside it:
  neither had another consumer.
- **`picker-doc-poll.mjs`**: the agent-side poll CLI. One-shot: it blocked
  until one event and printed it as JSON (`edit_request`, `save_batch`,
  `timeout`, `exit`), the same one-shot-poll shape `live-server.mjs`'s own
  poll CLI uses, so an agent harness never needed to hold a connection open
  waiting on either feature. Depended only on `design-context/store.mjs`.

`design-context/store.mjs` and `design-context/portability.mjs` (the store
itself, and the export/import bundle format) are unaffected by any of this:
both are still used today by the independent `design-context export`/`import`
commands, which never depended on the picker or its live session.

## Adding a new component with its own `assets/` and `index.html`

The general mechanism behind the picker, for building a second component
under `skill/scripts/`: how a `<component>/` Astro project at the repo root
ends up as `skill/scripts/<component>/index.html` (with an optional
`assets/`), synced into every provider directory the same way the picker was.
There's no live reference implementation to copy from any more (see the case
study above for what one looked like, or check out an older commit), but the
mechanism itself is intact and unused, waiting for a first consumer.

### The mechanism

Three pieces, each already generic:

1. **The build script.** `scripts/lib/build-astro-component.mjs` exports
   `buildAstroComponent({ root, name, astroConfig, assetsDir, extraFiles })`.
   It runs `bun x astro build --config <astroConfig>`, copies the result to
   `skill/scripts/<name>/`, then (both optional) copies `assetsDir` wholesale
   into `<output>/assets/` and copies each `{ from, to }` pair in `extraFiles`
   to the output root. A component's own `scripts/build-<name>.mjs` is a thin
   wrapper around it, doing only whatever data generation that component
   needs done fresh every build ahead of the call (the picker's was writing
   `hook-rules.json` from the canonical detector registry) plus wiring its own
   `package.json` script (`build:picker` chained into the top-level `build`/
   `build:release` scripts, before `build:skills`/`build:skills:release`, so
   the provider sync picks up the freshly built output) and `run` script.
2. **`skill/scripts/<name>/` is gitignored build output.** Nothing under it is
   ever hand-edited or committed directly; it is entirely regenerated by the
   build script above.
3. **The provider sync is already generic.** `scripts/build.js` (invoked by
   `bun run build:skills` / `build:skills:release`) has no component-specific
   code at all: it syncs whatever it finds under `skill/scripts/**` into
   every provider's `skills/impeccable/scripts/` directory, `plugin/`, and the
   `dist/`/`build/_data/dist/` outputs, deleting anything on the destination
   side that no longer exists in source. A component that lands correctly at
   `skill/scripts/<name>/` needs no additional sync wiring anywhere, and
   removing one is symmetric: delete the source, rebuild, and the sync
   deletes every provider's copy for you.

### Steps

1. Create `<component>/` at the repo root: an Astro project (`astro.config.mjs`,
   `pages/`, and whatever `layouts/`, `styles/`, `scripts/`, `data/` it needs).
2. Create `scripts/build-<component>.mjs`:
   ```js
   #!/usr/bin/env node
   import path from 'node:path';
   import { fileURLToPath } from 'node:url';
   import { buildAstroComponent } from './lib/build-astro-component.mjs';

   const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

   const outputDir = await buildAstroComponent({
     root,
     name: '<component>',
     astroConfig: '<component>/astro.config.mjs',
     // assetsDir: path.join(root, '<component>/assets'),   // only if you have one
     // extraFiles: [{ from: ..., to: 'some-file.json' }],  // only if you have any
   });

   console.log(`Built ${path.relative(root, outputDir)}/`);
   ```
3. Add `"build:<component>": "node scripts/build-<component>.mjs"` to
   `package.json`, and chain it into the top-level `build` / `build:release`
   scripts, before `build:skills` / `build:skills:release` (the provider sync
   needs the component already built to pick it up).
4. Run `bun run build:<component>` to check it locally: output lands at
   `skill/scripts/<component>/index.html`. Note `<output>/assets/` can exist
   even without setting `assetsDir`: Vite writes its own compiled, content-
   hashed JS/CSS bundles there regardless, unrelated to the `assetsDir` copy.
5. Run `bun run build:release` to sync it everywhere. No component-specific
   sync code to write, per the mechanism above.
6. If the page needs a live backend (an agent submitting answers, a live-edit
   session after that, anything beyond a static read), follow the picker's
   naming convention: `<component>-server.mjs` for static serving plus
   whatever submit/boot endpoints the page needs, `<component>-doc-session.mjs`
   for a detached live-editing HTTP session the server forks off when one is
   needed, and `<component>-doc-poll.mjs` for the one-shot CLI an agent polls
   for events from that session. None of these three are required if the
   component is a one-shot static read; the picker needed all three because
   its document stayed live for edits after submit. Whatever store the
   backend needs (the picker's shape is documented above, in "The picker's
   server scripts", and `design-context/store.mjs` and `portability.mjs`
   remain as a working example of a store plus its export/import format) is
   its own design question, not part of this mechanism.
7. Mention the component in the relevant `skill/reference/*.md` so the
   skill's routing knows it exists. The Astro build only produces the static
   page and, if wired per step 6, its backend; nothing here writes the
   command routing that gets an agent to invoke it.
8. Run `node cli/bin/cli.js detect skill/scripts/<component>/` afterward, the
   built directory (per CLAUDE.md's "Picker anti-pattern gate" section on why
   the built directory, not `index.html` alone or the unminified source, is
   the one to scan). If a helper function decides at runtime whether an
   `<img>` gets a `src` at all, prefer having it return the whole `<img>` tag
   (or an empty string) over interpolating just the attributes into a literal
   `<img ...>` in the template: a literal `<img ${` in source is exactly the
   pattern that trips the `broken-image` rule as a false positive, and
   emitting the whole tag from the helper keeps that pattern out of source
   entirely rather than needing an `.impeccable/config.json` waiver for it.

### `assetsDir` vs `extraFiles`

- **`assetsDir`**: a directory copied wholesale into `<output>/assets/`, for
  files referenced by a literal `/assets/...` URL in markup that Vite should
  never see or process (a texture, a photo). Preserves whatever subdirectory
  structure it has.
- **`extraFiles`**: individual files copied to the output root, for a
  standalone data file a page fetches at runtime rather than imports through
  Vite (the picker's `icon-packs.json`, or a favicon fetched by the browser
  directly). A texture referenced by URL from CSS or markup belongs in
  `assetsDir` instead.
