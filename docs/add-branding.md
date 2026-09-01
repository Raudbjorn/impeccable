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
way <brand-name>'s was, that's the only precedent for it. You'll need to confirm
`scripts/build-picker.mjs`'s `cp(..., { recursive: true })` step still picks
it up, since it already copies whole directories.

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

To give the design-context document a real fallback brand again:

1. Drop your image files under `picker/assets/`, following the existing
   per-category flat layout unless you specifically want nesting (see above).
2. In `picker/scripts/dcx/dcx-document.js`, reintroduce a placeholder array
   shaped like `BRAND_PLACEHOLDER_ASSETS` above and use it as the fallback in
   `composeBrandAssetsArticle` when `renderedBrandAssets(article)` returns
   empty.
3. If you want the "Cards" showcase to have a bundled fallback photo again
   instead of collapsing to text-only, give `componentCardImageTag` a second,
   fallback branch the way `componentCardImage` used to have one, and add the
   asset's directory to `runtimeAssetDirs` in `scripts/build-picker.mjs`.
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
