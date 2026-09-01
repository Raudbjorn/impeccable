# Personalizing the design-context document's placeholder brand

How to give the design-context questionnaire's review document (the "Brand
assets" section and the "Cards" component showcase in
`picker/scripts/dcx/dcx-document.js`) example imagery of your own, in place of
the generic empty state it ships with. This is written from the one worked
example that used to live in this repo: a placeholder brand called
**<brand-name>**, an atelier-style flower shop, pruned from the tree because it
was demo content rather than something the product needed to ship. The code
paths it used are still here; only its five image files and the strings that
named it are gone.

## The personalization surface

Two spots in the design-context document show imagery that isn't guaranteed
to exist:

- **Brand assets** (`composeBrandAssetsArticle`, category `brand`). It reads
  whatever the run's own questionnaire submission rendered into the article
  (`renderedBrandAssets()`, walking `.dcx-mark` and `.dcx-board` elements for
  marks and moodboard/reference images the user actually uploaded). When that
  list is empty, the section is skipped entirely: there is no shipped
  fallback imagery.
- **Cards** (`composeComponentsArticle`, category `components`). Three demo
  cards show "cards with media" component patterns. Their image comes from
  `componentCardImageTag(cueAlt)`, which emits a real `<img>` only when
  `window.dcxCueImageSrc` names the run's chosen visual cue; otherwise it
  emits nothing and the card renders text-only.

Neither path currently falls back to bundled example photography. <brand-name>
was that fallback, for both spots at once.

## What <brand-name> added

Five image files, all under `picker/assets/` (vendored into
`skill/scripts/picker/assets/` at build time by `scripts/build-picker.mjs`,
and from there synced into every provider's `skills/impeccable/scripts/picker/assets/`
directory by `bun run build:release`):

```
picker/assets/brand/placeholders/<brand-name>-primary-mark.png         768x768   logo
picker/assets/brand/placeholders/<brand-name>-atelier-seal.png         768x768   logo
picker/assets/brand/placeholders/<brand-name>-seasonal-moodboard.webp  960x720   moodboard
picker/assets/brand/placeholders/<brand-name>-material-reference.webp  960x720   reference
picker/assets/components/<brand-name>-ikebana-card.jpg                 800x1200  card photo
```

`brand/placeholders/` was the only path in the whole `picker/assets/` tree
nested two directories deep; every other category (`audience/`, `product/`,
`color/`, `typography/`, `material/`) is a flat `<category>/<file>.png`. If
you add your own placeholder set and want it grouped in a subdirectory the
way <brand-name>'s was, that's the only precedent for it. Nesting isn't a
problem either way: the `assetsDir` copy the final chapter below documents is
a single recursive directory copy, so it preserves whatever subdirectory
structure you give it.

Two wiring points in `picker/scripts/dcx/dcx-document.js` pulled those files
in:

1. A `BRAND_PLACEHOLDER_ASSETS` array, one object per file, each carrying the
   fields `composeBrandAssetsArticle` needed to render a `<figure>`: `src`
   (the `/assets/...` path above), `kind` (`"logo"` / `"moodboard"` /
   `"reference"`, which chose the caption's label), `title`, `alt`, and the
   image's own `width`/`height`. `composeBrandAssetsArticle` fell back to this
   array whenever the run's own upload list (`renderedBrandAssets()`) was
   empty: `const assets = uploaded.length ? uploaded : BRAND_PLACEHOLDER_ASSETS;`.
2. A `FALLBACK_CARD_IMAGE` constant naming the ikebana photo, read by
   `componentCardImage(fallbackAlt, cueAlt)` (the function `componentCardImageTag`
   replaced). Rather than rendering nothing when there was no cue, that
   version always emitted a real `src`, either the run's cue or the
   vendored photo, with `data-dcx-swap-src` wired to the delegated error
   listener in `picker/scripts/design-context.js` so a cue that failed to load
   swapped to the same fallback photo instead of showing a broken image.
3. `scripts/build-picker.mjs`'s `runtimeAssetDirs` list carried an entry just
   for this: `'components'` existed in that array **solely** to ship
   `<brand-name>-ikebana-card.jpg`; no other file ever lived in
   `picker/assets/components/`. That's the non-obvious one: if you reintroduce
   a fallback card photo, you need to add `'components'` (or wherever you put
   the file) back to `runtimeAssetDirs`, or the build script won't copy it and
   `bun run build:picker` will still succeed while quietly shipping nothing.

The theme carried through to test fixture identity too, in
`tests/picker-server.test.mjs`: a font-manifest fixture styled as a florist
(nav `Bouquets`/`Workshops`/`Seasonal`, copy like "Flowers shaped by hand",
gallery items `Market bunch`/`Table vase`/`Ceremony`, `footerMark: '© <brand-name>'`),
and a separate context fixture using `{ product: { name: '<brand-name>' } }`. Both
were arbitrary sample data (nothing asserted on the literal strings), so if
you're personalizing your own fork's test fixtures the same way, know that the
theme was purely cosmetic and free to change without touching any assertion.

## Doing your own

`picker/assets/` itself is gone too now (see "The picker's own section icons"
and the final chapter below): the directory held nothing else once its last
three files were pruned, so it was removed along with them. To give the
design-context document a real fallback brand again:

1. Create `picker/assets/` and drop your image files under it, following the
   old per-category flat layout unless you specifically want nesting (see
   above). Then wire it up as `assetsDir` in the `buildAstroComponent()` call
   in `scripts/build-picker.mjs` (the mechanism the final chapter below
   documents), so it gets copied into the build output.
2. In `picker/scripts/dcx/dcx-document.js`, reintroduce a placeholder array
   shaped like `BRAND_PLACEHOLDER_ASSETS` above and use it as the fallback in
   `composeBrandAssetsArticle` when `renderedBrandAssets(article)` returns
   empty.
3. If you want the "Cards" showcase to have a bundled fallback photo again
   instead of collapsing to text-only, give `componentCardImageTag` a second,
   fallback branch the way `componentCardImage` used to have one.
4. Run `bun run build:release`. This rebuilds `skill/scripts/picker/` from
   source and resyncs every provider's committed copy
   (`.claude/`, `.gemini/`, `.codex/`, `.agents/`, `.github/`, `.kiro/`,
   `.opencode/`, `.pi/`, `.vibe/`, `.agent/`, `.omp/`, `plugin/`) from it, so
   the new assets and code both land everywhere the generated output is
   tracked, not just in source.
5. Run `node cli/bin/cli.js detect skill/scripts/picker/` afterward. A synthetic
   `<img ${...}>` src built entirely from a JS helper is exactly the pattern
   that trips the `broken-image` rule as a false positive if the helper can
   ever legitimately return no image. Prefer having the helper return the
   whole `<img>` tag (or an empty string) over interpolating just the
   attributes into a literal `<img ...>` in the template: it keeps the
   literal `<img ${` pattern out of source entirely, which avoided the false
   positive here without needing an `.impeccable/config.json` waiver.

## The picker's own section icons

Separate from end-user branding above: this branch also added a set of
per-section icons for the design-context document's own UI chrome, not tied
to any particular brand. All 26 were pruned in the same cleanup pass. They
are recorded here for the same reason the placeholder brand is: so
reintroducing them (or something like them) starts from a known shape
instead of guesswork.

### What they were

Small square PNGs, one per detail-article subsection, grouped by category
under `picker/assets/`:

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

Two more, also under `audience/` but a different mechanism entirely:
`kinpaku-gold-leaf.png` and `verdigris-patina.png` were texture photos, not
per-section icons. They named the site's own two brand accents (`--ks-kinpaku`
and `--ks-patina` in `picker/styles/vendor/kinpaku-tokens.css`), not a
placeholder brand.

### How they were wired

1. **`dcx-audience.js`**: `SECTION_META`, an array of five entries (one per
   audience subsection), each carrying an optional `icon: "<filename>.png"`
   field resolved against `/assets/audience/`. `enhanceAudienceArticle` built
   an `<figure><img></figure>` and appended it to the section header only
   `if (meta.icon)`, adding a `dcx-audience-section-head--with-icon` modifier
   class in that case. `picker/styles/dcx/dcx-audience.css`'s
   `.dcx-audience-section-head` had to be changed from an unconditional
   two-column grid (which would otherwise leave a permanent empty gap where
   the icon used to sit) to a one-column default, with the modifier class
   restoring the second, icon-sized column only when an icon is present.
2. **`dcx-detail.js`**: `DETAIL_META[category][label]` held a
   `[ledeText, iconPath?]` tuple; `enhanceSection` destructured
   `const [ledeText, icon] = DETAIL_META[category]?.[label] || [...]` and
   built the icon `<figure>` only `if (icon)`. Unlike the audience CSS, the
   base `.dcx-detail-section-head` grid in `dcx-detail.css` already reserved
   its second column unconditionally by design, filling it with a decorative
   `::after` accent rule (`:not(.dcx-detail-section-head--with-icon)::after`)
   when no icon was present. That no-icon state was already a first-class,
   already-designed fallback, so nothing in `dcx-detail.css` needed to change.
3. **`dcx-rail.js`**: two SVG `<pattern>` fills (`patinaPattern`,
   `goldPattern`) used as the `stroke` for the "material rail" progress
   indicator, one for the inactive track and one for the active/completed
   segment. Each layered a texture `<image>` (`verdigris-patina.png` /
   `kinpaku-gold-leaf.png`) at partial opacity over a solid base `<rect>`
   (`fill: var(--ks-patina)` / `var(--ks-kinpaku)`, in
   `picker/styles/dcx/dcx-rail.css`). Dropping the two `<image>` elements left
   the solid-color base rects as the pattern fill: a clean flat-color result
   using the same site tokens, not a visual regression, so no fallback logic
   was needed here at all, just deleting the `<image>` elements and the two
   now-dead `.dcx-material-rail__patina-image` / `-gold-image` opacity/filter
   rules in `dcx-rail.css`.

### Reintroducing them

The `if (meta.icon)` / `if (icon)` guards and the `--with-icon` CSS modifiers
were deliberately left in place rather than stripped out, even though nothing
in the static metadata can ever set them again on their own. To bring section
icons back:

1. Re-create `picker/assets/<category>/` and drop icon files under it (the
   whole `picker/assets/` directory is gone now too, per "Doing your own"
   above).
2. Add an `icon:` field to the relevant `SECTION_META` entry in
   `dcx-audience.js`, or an icon path as the second array element in the
   relevant `DETAIL_META[category][label]` entry in `dcx-detail.js`. Both
   already render correctly once the field is present, no other code change
   needed.
3. For the rail's two texture fills, re-add the `<image>` elements to
   `patinaPattern`/`goldPattern` in `dcx-rail.js` and restore the opacity and
   filter rules in `dcx-rail.css` (removed alongside the images since nothing
   else used them).
4. Wire `picker/assets/` back up as `assetsDir` in the `buildAstroComponent()`
   call in `scripts/build-picker.mjs`, the same one `hero-dark.jpg` and
   `kinpaku-gold-leaf.jpg` used before they too were pruned (see the final
   chapter below for how that call is shaped).
5. Run `bun run build:release` and `node cli/bin/cli.js detect skill/scripts/picker/`
   the same way as step 4 and 5 above.

## The picker's own page chrome

The last three files under `picker/assets/`, and the directory itself once
they were gone: `favicon.svg`, `hero-dark.jpg`, and `kinpaku-gold-leaf.jpg`.
Same bucket as the section icons above (the picker's own tool chrome, not
end-user branding), but a different mechanism each, in `picker/layouts/Picker.astro`,
`picker/pages/index.astro`, and `picker/styles/picker.css`.

### What they were and how they were wired

- **`favicon.svg`**: the browser-tab icon. One line in `Picker.astro`'s
  `<head>`: `<link rel="icon" type="image/svg+xml" href="./favicon.svg" />`.
  Just deleted; a page with no favicon link is a normal, unremarkable state.
- **`hero-dark.jpg`**: a decorative, `aria-hidden` background image behind the
  questionnaire's start screen. `index.astro` rendered it as
  `<div class="picker-hero-art" style="background-image: url('assets/hero-dark.jpg')" aria-hidden="true">`,
  positioned `absolute; inset: 0; z-index: 0` behind `#picker-form` (`z-index: 1`)
  in `picker.css`, so removing the `<div>` outright left no gap: nothing else
  in `.picker-shell` was laid out relative to it. Three CSS pieces went with
  it: the base `.picker-hero-art` rule, a `:has(#picker-form[data-current="..."])`
  selector list that faded it out on every screen except the start and finish
  (an opinion about screens judged "against a plain ground", not something a
  no-art state needs), and its entry in a shared `prefers-reduced-motion`
  selector list (just that one selector removed, the rest of the list stayed).
- **`kinpaku-gold-leaf.jpg`**: a texture overlay on the picker's own primary
  button, named after the site's own `--ks-kinpaku` gold accent. Set as a CSS
  custom property on `<body>` in `Picker.astro`
  (`style="--pk-foil: url('/assets/kinpaku-gold-leaf.jpg')"`, the only style
  on that element, so the whole attribute came out with it), consumed by a
  `.picker-page .ks-button.ks-button-primary::before` pseudo-element at 0.38
  opacity (0.26 on hover, 0 when disabled) layered over the button's solid
  `background: var(--ks-kinpaku)` fill. Removing just the `::before` rule (and
  its hover/disabled variants, and the now-pointless `position: relative;
  isolation: isolate;` that existed only to anchor it) left the solid gold
  fill as the button's whole look: a flat color, not a broken one, the same
  graceful-degrade shape as the material rail's two textures above.

### Reintroducing them

`favicon.svg` and `kinpaku-gold-leaf.jpg` are self-contained: adding either
back is a one-line change at its single call site, no other code depends on
their absence. `hero-dark.jpg` needs a little more: the `<div>` back in
`index.astro`, plus its three CSS pieces (a plain background-image rule needs
none of the show/hide-per-screen behavior to look correct, but that behavior
is what made the original feel deliberate rather than a stray image sitting
behind the form). In every case, wire the file into `assetsDir` or
`extraFiles` on the `buildAstroComponent()` call in `scripts/build-picker.mjs`,
per the next chapter: a favicon fetched by the browser directly (like
`icon-packs.json` today) is an `extraFiles` entry copied to the output root; a
texture referenced by URL from CSS or markup (like the two rail textures)
belongs in `assetsDir`.

## Adding a new component with its own `assets/` and `index.html`

Everything above lives inside the picker, the one component under
`skill/scripts/` today that ships a real page. This chapter is the general
mechanism behind that, for adding a second one: how a `<component>/` Astro
project at the repo root ends up as `skill/scripts/<component>/index.html`
(with an optional `assets/`), synced into every provider directory the same
way the picker is.

### The mechanism

Three pieces, each already generic:

1. **The build script.** `scripts/lib/build-astro-component.mjs` exports
   `buildAstroComponent({ root, name, astroConfig, assetsDir, extraFiles })`.
   It runs `bun x astro build --config <astroConfig>`, copies the result to
   `skill/scripts/<name>/`, then (both optional) copies `assetsDir` wholesale
   into `<output>/assets/` and copies each `{ from, to }` pair in `extraFiles`
   to the output root. `scripts/build-picker.mjs` is a thin wrapper around it:
   ```js
   const outputDir = await buildAstroComponent({
     root,
     name: 'picker',
     astroConfig: 'picker/astro.config.mjs',
     extraFiles: [
       { from: path.join(root, 'picker/data/icon-packs.json'), to: 'icon-packs.json' },
     ],
   });
   ```
   (Plus, ahead of that call, whatever picker-specific data generation the
   component needs done fresh every build; picker's is the `hook-rules.json`
   write, unrelated to the build-astro-component mechanism itself and not
   something a new component needs to copy.)
2. **`skill/scripts/<name>/` is gitignored build output**, the same as
   `skill/scripts/picker/`. Nothing under it is ever hand-edited or committed
   directly; it is entirely regenerated by the build script above.
3. **The provider sync is already generic.** `scripts/build.js` (invoked by
   `bun run build:skills` / `build:skills:release`, which `build` /
   `build:release` chain after the component builds) has no picker-specific
   code at all: it syncs whatever it finds under `skill/scripts/**` into
   every provider's `skills/impeccable/scripts/` directory, `plugin/`, and the
   `dist/`/`build/_data/dist/` outputs. A new component that lands correctly
   at `skill/scripts/<name>/` needs no additional sync wiring anywhere.

### Steps

1. Create `<component>/` at the repo root: an Astro project (`astro.config.mjs`,
   `pages/`, and whatever `layouts/`, `styles/`, `scripts/`, `data/` it needs).
   `picker/` is the template to copy from for shape, not content.
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
   scripts alongside `build:picker`, before `build:skills` /
   `build:skills:release` (the provider sync needs the component already
   built to pick it up).
4. Run `bun run build:<component>` to check it locally: output lands at
   `skill/scripts/<component>/index.html`. Note `<output>/assets/` can exist
   even without setting `assetsDir`: Vite writes its own compiled, content-
   hashed JS/CSS bundles there regardless, unrelated to the `assetsDir` copy.
5. Run `bun run build:release` to sync it everywhere. No component-specific
   sync code to write, per the mechanism above.
6. Wire something up to actually invoke the page (a server script the skill's
   commands launch, the way `picker-server.mjs` and `picker-doc-session.mjs`
   serve the picker) and mention the component in the relevant
   `skill/reference/*.md` so the skill's routing knows it exists. The Astro
   build only produces the static page; nothing here serves it.
7. Run `node cli/bin/cli.js detect skill/scripts/<component>/` the same way
   as the picker's own gate (CLAUDE.md's "Picker anti-pattern gate" section
   has the scanning caveats: name the directory, not `index.html` alone, and
   why a served URL or the unminified source are each worse than the built
   directory for this).

### `assetsDir` vs `extraFiles`

- **`assetsDir`**: a directory copied wholesale into `<output>/assets/`, for
  files referenced by a literal `/assets/...` URL in markup that Vite should
  never see or process (a texture, a photo). Preserves whatever subdirectory
  structure it has.
- **`extraFiles`**: individual files copied to the output root, for a
  standalone data file a page fetches at runtime rather than imports through
  Vite. `icon-packs.json` (above) is the one live example today; picker used
  to copy `favicon.svg` to the output root by a similar, then-separate step
  before that file, too, was pruned along with the rest of its own page
  chrome (see "The picker's own section icons").
