// Optional package/PDF worker. It never publishes outputs; Rust owns publication.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, extname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const load = async path => import(pathToFileURL(path).href);

export async function handle(request) {
  const { format, document, config = {} } = request;
  if (format === 'identity') {
    const field = request.for === 'specimen' ? 'rendererModule' : request.for === 'world-theme' ? 'themeModule' : 'vernacularModule';
    let module = config[field];
    if (!module && request.for === 'specimen') {
      try { module = fileURLToPath(import.meta.resolve('pretext-pdf')); } catch { /* The render step reports the missing dependency. */ }
    }
    const identity = { node: process.version, platform: process.platform, arch: process.arch, module: module ?? null };
    if (module) {
      let root = dirname(module);
      while (!existsSync(join(root, 'package.json')) && dirname(root) !== root) root = dirname(root);
      if (!existsSync(join(root, 'package.json'))) root = dirname(module);
      const base = existsSync(join(root, 'dist')) ? join(root, 'dist') : dirname(module);
      const files = {};
      function visit(directory) {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
          if (['node_modules', '.git'].includes(entry.name) || entry.isSymbolicLink()) continue;
          const path = join(directory, entry.name);
          if (entry.isDirectory()) visit(path);
          else if (['.js', '.mjs', '.json', '.wasm', '.node'].includes(extname(path))) files[relative(base, path)] = hash(readFileSync(path));
        }
      }
      visit(base);
      identity.moduleTreeHash = hash(JSON.stringify(files));
      if (existsSync(join(root, 'package.json'))) identity.packageHash = hash(readFileSync(join(root, 'package.json')));
    }
    return identity;
  }
  if (format === 'world-theme' || format === 'vernacular') {
    const field = format === 'world-theme' ? 'themeModule' : 'vernacularModule';
    if (!config[field]) throw new Error(`Configure ${field} with compose setup; unvalidated output remains a draft`);
    const module = await load(config[field]);
    const parser = format === 'world-theme' ? module.parseWorldTheme : module.parseVernacular;
    const parsed = parser(JSON.stringify(document), { onContrastFailure: 'reject', unknownTokens: 'reject' });
    const issues = parsed.ok ? parsed.value?.issues ?? [] : parsed.error;
    if (!parsed.ok || issues.length) throw new Error(`Package validation failed: ${JSON.stringify(issues)}`);
    return { valid: true, document, validatorHash: hash(readFileSync(config[field])), validator: config[field] };
  }
  if (format !== 'specimen') throw new Error('Unknown export worker format');
  const renderer = config.rendererModule ? await load(config.rendererModule) : await import('pretext-pdf');
  const validation = renderer.validateDocument(document, { strict: true });
  if (!validation.valid) throw new Error(`Invalid specimen document: ${JSON.stringify(validation.errors)}`);
  const warnings = [];
  const bytes = await renderer.render({ ...document, onImageLoadError: () => 'throw', onFormFieldError: () => 'throw' }, {
    strict: true, logger: { warn: (...args) => warnings.push(args.map(String)) },
  });
  if (warnings.length) throw new Error(`Specimen warnings: ${JSON.stringify(warnings)}`);
  writeFileSync(request.output, bytes, { flag: 'wx' });
  return { valid: true, pdfHash: hash(bytes), node: process.version, renderer: config.rendererModule ?? 'pretext-pdf@2.2.6',
    rendererHash: config.rendererModule ? hash(readFileSync(config.rendererModule)) : null,
    factualReview: 'required', visualReview: 'required', status: 'draft' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await handle(JSON.parse(readFileSync(0, 'utf8'))))); }
  catch (error) { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; }
}
