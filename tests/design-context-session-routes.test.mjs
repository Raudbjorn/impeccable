import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createSaveRoutes } from '../skill/scripts/design-context/session-routes.mjs';
import { paths, readAnswers, replayJournal } from '../skill/scripts/design-context/store.mjs';

function makeCwd() {
  return mkdtempSync(path.join(tmpdir(), 'design-context-session-routes-'));
}

const change = (to = '#112233') => ({ changes: [{ bindingId: 'palette.primary', from: '', to }] });

describe('createSaveRoutes: concurrent saves', () => {
  it('reserves synchronously so a second save while the first is mid-flight is rejected, not raced', async () => {
    const cwd = makeCwd();
    // save() runs synchronously (the guard check, validate(), and the
    // reservation assignment) up to its first await, exactly like any async
    // function call does before it returns a pending promise. Calling save()
    // twice back to back with no await between them means the second call's
    // guard check runs only after the first call's reservation is already
    // in place -- no artificial delay needed to exercise the race the fix
    // closes.
    const routes = createSaveRoutes({ cwd });
    const first = routes.save(change('#111111'));
    const second = routes.save(change('#222222'));

    const results = await Promise.allSettled([first, second]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one concurrent save must land');
    assert.equal(rejected.length, 1, 'the other must be rejected, never silently lost');
    assert.equal(rejected[0].reason.statusCode, 409);

    // The value on disk must be the one save that actually won the
    // reservation, not a torn mix of both concurrent writers.
    const answers = await readAnswers(cwd);
    assert.ok(['#111111', '#222222'].includes(answers['palette-primary']), 'store holds exactly one full value, not a partial write');
  });

  it('clears the reservation on failure so the next save is not permanently blocked', async () => {
    const cwd = makeCwd();
    const fs = await import('node:fs');
    // writeJsonAtomic writes a .tmp file then renames it onto answers.json;
    // renaming onto an existing directory throws, which is a reliable way
    // to force commitToStore to fail without touching module internals.
    const answersPath = paths(cwd).answersJson;
    fs.mkdirSync(path.dirname(answersPath), { recursive: true });
    fs.mkdirSync(answersPath);

    const routes = createSaveRoutes({ cwd });
    await assert.rejects(() => routes.save(change()));
    assert.equal(routes.hasPending(), false, 'a failed save must not leave pending stuck');

    // Clear the trap and confirm the same routes instance saves cleanly
    // next time, which a stuck reservation would have permanently blocked.
    fs.rmdirSync(answersPath);
    const result = await routes.save(change('#334455'));
    assert.ok(result.id);
  });

  it('a save rejected after the batch was journaled as pending leaves no phantom pending batch for replay', async () => {
    const cwd = makeCwd();
    const routes = createSaveRoutes({ cwd });
    // A batch stays pending (by design) until reply() acknowledges it, so
    // establish and acknowledge a first save to leave pending clear before
    // exercising the failure this test is actually about.
    const first = await routes.save(change('#111111'));
    await routes.reply({ id: first.id, status: 'done' });
    assert.equal(routes.hasPending(), false);

    // Force the second save's store write to fail after loadAndDiff (a real
    // read) but the failure must still land after the batch is journaled as
    // pending: point cwd's answers.json path at a directory so writeAnswers
    // (called from commitToStore, after the journal write) throws.
    const trapDir = path.join(cwd, '.impeccable', 'design-context', 'answers.json');
    const fs = await import('node:fs');
    fs.rmSync(trapDir, { force: true });
    fs.mkdirSync(trapDir); // answers.json is now a directory: writeFile onto it throws

    await assert.rejects(() => routes.save(change('#222222')));
    assert.equal(routes.hasPending(), false);

    const replay = replayJournal(cwd);
    assert.equal(replay.pendingBatch, null, 'replay must not resurrect a batch the store never actually took');
  });
});

describe('createSaveRoutes: journal durability ordering', () => {
  it('journals the batch as pending before the store write, so replay can recover it even if commit never ran', async () => {
    const cwd = makeCwd();
    // Simulate a crash between the journal write and the store write by
    // reading the routes' own journal file right after a save that we know
    // completed, then checking the ordering contract a different way: the
    // batch's journal entry must exist and be replay-visible independent of
    // whether the store write that follows it has landed. We assert this by
    // checking that even a save() that fails inside commitToStore (see the
    // sibling test above) still leaves a well-formed 'batch' journal entry
    // on disk (not just an in-memory record), proving the journal write is
    // not contingent on the store write succeeding.
    const routes = createSaveRoutes({ cwd });
    const trapDir = path.join(cwd, '.impeccable', 'design-context', 'answers.json');
    const fs = await import('node:fs');
    fs.mkdirSync(path.dirname(trapDir), { recursive: true });
    fs.mkdirSync(trapDir);
    await assert.rejects(() => routes.save(change('#333333')));

    const journalPath = paths(cwd).journalJsonl;
    const lines = readFileSync(journalPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const batchEntries = lines.filter((l) => l.type === 'batch');
    assert.equal(batchEntries.length, 2, 'a pending entry, then the error entry that closes it');
    assert.equal(batchEntries[0].status, 'pending');
    assert.equal(batchEntries[1].status, 'error');
    assert.equal(batchEntries[0].id, batchEntries[1].id);
  });
});
