import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { createHash } from 'node:crypto';

export function retrievalConfig(cwd = process.cwd()) {
  const path = resolve(cwd, '.impeccable/config.local.json');
  let config;
  try { config = JSON.parse(readFileSync(path, 'utf8')).retrieval; }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error(`Invalid local config: ${error.message}`); }
  if (config === undefined) return null;
  if (!config || !Array.isArray(config.command) || !config.command.length || config.command.some(s => typeof s !== 'string' || !s)
    || (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1))) throw new Error('retrieval.command must be an executable-and-arguments array');
  return config;
}
export async function callRetrieval(request, { cwd = process.cwd(), config = retrievalConfig(cwd) } = {}) {
  if (!config) throw new Error('Configure retrieval.command in .impeccable/config.local.json');
  return new Promise((resolveResult, reject) => {
    const child = spawn(config.command[0], config.command.slice(1), { cwd, stdio: ['pipe','pipe','pipe'], shell: false, detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} reject(error); }
      else resolveResult(value);
    };
    const timer = setTimeout(() => finish(new Error('Local retrieval timed out; retry the saved session or check catalog doctor --live')), config.timeoutMs ?? 180000);
    child.on('error', error => finish(new Error(`Local retrieval could not start: ${error.message}`)));
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => { stdout += chunk; if (Buffer.byteLength(stdout) > 16 * 1024 * 1024) finish(new Error('Retrieval response exceeds 16 MB')); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
    child.on('close', code => {
      if (code !== 0) return finish(new Error(`Local retrieval failed: ${stderr || `exit ${code}`}`));
      try {
        const response = JSON.parse(stdout);
        if (response.protocol !== 1) throw new Error('unsupported response protocol');
        if (request.op === 'choose') {
          if (response.recorded !== true) throw new Error('choice was not recorded');
        } else {
          if (!response.session || !response.settings || !response.record || !Array.isArray(response.record.challengers) || !response.record.challengers.length
            || !Array.isArray(response.record.compositions) || !response.record.compositions.length) throw new Error('missing candidates or session');
          if (request.session && response.session !== request.session) throw new Error('session mismatch');
          if (response.round !== (request.round ?? 0) || (response.register ?? null) !== (request.register ?? null)) throw new Error('round mismatch');
          for (const [key, value] of Object.entries(request.settings || {})) {
            if (value !== undefined && response.settings[key] !== value) throw new Error(`settings mismatch: ${key}`);
          }
          const { challengers, compositions, staging } = response.record;
          if (new Set(challengers.map(c => c.id)).size !== challengers.length || challengers.some(c => !c.id || !Array.isArray(c.system) || !['graphic','interaction','atmosphere'].includes(c.wellTier))
            || new Set(compositions.map(c => c.id)).size !== compositions.length || compositions.some(c => !c.id || !Array.isArray(c.grammar))
            || !compositions.some(c => JSON.stringify(c) === JSON.stringify(staging))
            || (response.record.stagings && JSON.stringify(response.record.stagings) !== JSON.stringify(compositions))) throw new Error('invalid candidate roles or staging');
        }
        finish(null, response);
      } catch (error) { finish(new Error(`Invalid retrieval response: ${error.message}`)); }
    });
    child.stdin.end(JSON.stringify({ ...request, protocol: 1 }));
  });
}

export function materializeRound(response, cwd = process.cwd()) {
  if (!/^[a-f0-9]{64}$/.test(response.session)) throw new Error('Invalid session ID');
  const directory = resolve(cwd, '.impeccable/retrieval', response.session);
  mkdirSync(directory, { recursive: true });
  const local = structuredClone(response);
  for (const entry of [...local.record.challengers, ...local.record.compositions]) {
    for (const ref of entry.references || []) {
      if (!ref.path || !existsSync(ref.path)) continue;
      const bytes = readFileSync(ref.path);
      const name = createHash('sha256').update(bytes).digest('hex') + extname(ref.path);
      const destination = join(directory, name);
      copyFileSync(ref.path, destination);
      ref.path = destination;
    }
    for (const field of ['cardBoard','cardHero']) {
      if (!entry[field] || /^https?:\/\//.test(entry[field])) continue;
      if (!existsSync(entry[field])) { delete entry[field]; continue; }
      const bytes = readFileSync(entry[field]);
      const destination = join(directory, createHash('sha256').update(bytes).digest('hex') + extname(entry[field]));
      copyFileSync(entry[field], destination);
      entry[field] = destination;
    }
  }
  local.record.stagings = local.record.compositions;
  local.record.staging = local.record.compositions.find(c => c.id === response.record.staging.id);
  writeFileSync(join(directory, `round-${response.round}-${response.register || 'normal'}.json`), JSON.stringify(local, null, 2) + '\n');
  return local;
}
