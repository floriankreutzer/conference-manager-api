import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, stat, unlink } from 'node:fs/promises';
import test from 'node:test';
import { createTargetLoadJournal } from '../scripts/support/target-load-journal.mjs';
import { targetScopeValues } from '../scripts/support/target-load-runtime-config.mjs';
import { targetLoadSetupEnvironment, NOW } from './support/target-load-environment.js';

const record = { ordinal: 1, surface: 'customer', kind: 'session_read', method: 'GET',
  responseByteReservation: 8192, requestPayloadBytes: 0 };
function setup(t) {
  const runId = randomBytes(8).toString('hex'); const values = targetScopeValues(targetLoadSetupEnvironment(runId));
  const path = `/tmp/cm-saas38-load-${runId}-campaign.ndjson`;
  t.after(() => unlink(path).catch(() => {})); return { values, path };
}

test('journal reserves exclusive private custody and retains consumed attempts across controller restart', async t => {
  const { values, path } = setup(t); const journal = await createTargetLoadJournal(values, { clock: () => NOW });
  await Promise.all([journal.recordAttempt(record), journal.recordAttempt({ ...record, ordinal: 2 })]);
  await journal.close();
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const rows = (await readFile(path, 'utf8')).trim().split('\n').map(row => JSON.parse(row));
  assert.equal(rows[0].runId, values.runId); assert.deepEqual(rows.slice(1), [record, { ...record, ordinal: 2 }]);
  await assert.rejects(createTargetLoadJournal(values, { clock: () => NOW }), /^Error: LOAD_TARGET_JOURNAL_FAILED$/);
  await assert.rejects(journal.recordAttempt({ ...record, ordinal: 3 }));
});

test('journal rejects private fields, duplicate ordinals, wrong methods and unbounded reservations irreversibly', async t => {
  for (const patch of [{ cookie: 'private-cookie' }, { ordinal: 2 }, { surface: 'setup' }, { method: 'POST' },
    { kind: 'private-kind' }, { responseByteReservation: 8193 }, { requestPayloadBytes: -1 }]) {
    const { values, path } = setup(t); const journal = await createTargetLoadJournal(values, { clock: () => NOW });
    await assert.rejects(journal.recordAttempt({ ...record, ...patch }), /^Error: LOAD_TARGET_JOURNAL_FAILED$/);
    await assert.rejects(journal.recordAttempt(record)); await assert.rejects(journal.close());
    assert.equal((await readFile(path, 'utf8')).trim().split('\n').length, 1);
  }
});

test('journal copies queued inputs before asynchronous writes and rejects expired work before append', async t => {
  const { values, path } = setup(t); let now = NOW;
  const journal = await createTargetLoadJournal(values, { clock: () => now });
  const row = { ...record }; const pending = journal.recordAttempt(row); row.cookie = 'private'; row.ordinal = 42;
  await pending; now += 540_000;
  await assert.rejects(journal.recordAttempt({ ...record, ordinal: 2 })); await assert.rejects(journal.close());
  const content = await readFile(path, 'utf8'); assert.equal(content.includes('private'), false);
  assert.deepEqual(JSON.parse(content.trim().split('\n')[1]), record);
});
