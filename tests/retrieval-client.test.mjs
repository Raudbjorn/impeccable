import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callRetrieval, retrievalConfig, materializeRound } from '../skill/scripts/lib/retrieval-client.mjs';
const seeder = fileURLToPath(new URL('../skill/scripts/concept-seed.mjs', import.meta.url));
const session = 'a'.repeat(64);
function response() {
  const composition = { id: 'composition', form: 'a structured page', grammar: ['Stage the section'], spark: 'A clear view', webLeverage: 'SVG', surface: 'read' };
  return { protocol: 1, session, round: 0, register: null, settings: { scope: 'direction', mode: 'read', key: 'deadbeef', candidateCount: 7 }, source: 'retrieval', poolRevision: 'fixture', reusedIds: [],
    record: { challengers: [{ id: 'challenger', form: 'a strong visual system', spark: 'A grid', system: ['Use a disciplined grid'], wellTier: 'graphic', webLeverage: 'SVG', evidence: [{ source: 'manual', page_no: 12, role: 'cite' }] }], compositions: [composition], staging: composition } };
}
function fixture(body) {
  const cwd = mkdtempSync(join(tmpdir(), 'retrieval-client-'));
  mkdirSync(join(cwd, '.impeccable'));
  writeFileSync(join(cwd, 'PRODUCT.md'), '# Product\nEngineering reference');
  writeFileSync(join(cwd, 'DESIGN.md'), '# Design\nExisting identity');
  writeFileSync(join(cwd, 'brief.md'), 'Engineering reference with construction grids');
  const command = ['node', join(cwd, 'backend.mjs')];
  writeFileSync(command[1], body);
  writeFileSync(join(cwd, '.impeccable/config.local.json'), JSON.stringify({ retrieval: { command } }));
  return { cwd, command, clean: () => rmSync(cwd, { recursive: true, force: true }) };
}

test('CLI retrieves and records locally, stages references, and never invents card URLs', async () => {
  const data = response();
  const f = fixture(`import fs from 'node:fs'; const r=JSON.parse(fs.readFileSync(0,'utf8')); fs.appendFileSync('requests.jsonl',JSON.stringify(r)+'\\n'); console.log(JSON.stringify(r.op==='choose'?{protocol:1,recorded:true}:${JSON.stringify(data)}));`);
  try {
    const run = (...args) => spawnSync('node', [seeder, ...args], { cwd: f.cwd, encoding: 'utf8' });
    const first = run('--scope','direction','--from','deadbeef','--brief-file','brief.md');
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /RETRIEVAL SESSION/);
    assert.match(first.stdout, /EVIDENCE \(cite\): manual, page 12/);
    assert.doesNotMatch(first.stdout, /impeccable\.style\/worlds\/cards/);
    assert.match(first.stdout, /build-phase\.mjs start .*--session/);
    assert.equal(existsSync(join(f.cwd, '.impeccable/build/pending.json')), true);
    const choice = run('--session',session,'--kind','challenger','--chosen','challenger');
    assert.equal(choice.status,0,choice.stderr);
    assert.match(choice.stdout,/choice recorded/);
    const requests = readFileSync(join(f.cwd,'requests.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(requests.map(r=>r.op), ['start','choose','replay']);
    assert.equal(requests[0].brief, 'Engineering reference with construction grids');
    await assert.rejects(callRetrieval({ op: 'replay', session: 'b'.repeat(64) }, { cwd: f.cwd }), /session mismatch/);
    await assert.rejects(callRetrieval({ op: 'replay', session, round: 2 }, { cwd: f.cwd }), /round mismatch/);
    const source = join(f.cwd, 'source.png'); writeFileSync(source, 'fixture image');
    data.record.challengers[0].references = [{ path: source, label: 'Source page', kind: 'source-page' }];
    const local = materializeRound(data, f.cwd);
    assert.notEqual(local.record.challengers[0].references[0].path, source);
    assert.equal(readFileSync(local.record.challengers[0].references[0].path,'utf8'),'fixture image');
  } finally { f.clean(); }
});

test('configured failures, malformed responses and timeouts fail without pending markers', async () => {
  const f = fixture("console.error('provider unavailable'); process.exit(1);");
  try {
    const result = spawnSync('node',[seeder,'--scope','direction','--brief-file','brief.md'],{cwd:f.cwd,encoding:'utf8'});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/provider unavailable/);
    assert.equal(existsSync(join(f.cwd,'.impeccable/build/pending.json')),false);
    writeFileSync(f.command[1],"console.log('{}');");
    await assert.rejects(callRetrieval({op:'start'},{cwd:f.cwd}), /Invalid retrieval response/);
    const invalid = response(); invalid.record.challengers.push(invalid.record.challengers[0]);
    writeFileSync(f.command[1],`console.log(${JSON.stringify(JSON.stringify(invalid))});`);
    await assert.rejects(callRetrieval({op:'start'},{cwd:f.cwd}), /candidate roles/);
    writeFileSync(f.command[1], 'setInterval(()=>{},1000);');
    await assert.rejects(callRetrieval({op:'start'},{cwd:f.cwd,config:{command:f.command,timeoutMs:40}}),/timed out/);
    writeFileSync(join(f.cwd,'.impeccable/config.local.json'),JSON.stringify({retrieval:{command:'node evil'}}));
    assert.throws(()=>retrievalConfig(f.cwd),/arguments array/);
  } finally { f.clean(); }
});
