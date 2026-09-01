#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANTIPATTERNS } from '../cli/engine/registry/antipatterns.mjs';
import { composeHookRules } from './lib/hook-rule-presentation.js';
import { buildAstroComponent } from './lib/build-astro-component.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The Hooks page's rule list, composed from the canonical detector registry so
// the document never drifts from what the hook actually enforces. Committed and
// regenerated every build; tests/hook-rule-presentation.test.js guards the sync.
await writeFile(
  path.join(root, 'picker/data/hook-rules.json'),
  `${JSON.stringify(composeHookRules(ANTIPATTERNS), null, 2)}\n`,
);

const outputDir = await buildAstroComponent({
  root,
  name: 'picker',
  astroConfig: 'picker/astro.config.mjs',
  extraFiles: [
    // The icon specimen is fetched at runtime rather than inlined, so it ships
    // beside the page instead of going through Vite. Regenerate it with
    // `node scripts/vendor-icons.mjs`.
    { from: path.join(root, 'picker/data/icon-packs.json'), to: 'icon-packs.json' },
  ],
});

console.log(`Built ${path.relative(root, outputDir)}/`);
