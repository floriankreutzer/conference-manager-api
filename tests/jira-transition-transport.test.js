import assert from 'node:assert/strict';
import test from 'node:test';
import { readJiraReadyTransition, submitJiraReadyTransition, observeJiraReadyTransition,
  JIRA_TRANSITION_HISTORY_TYPE } from '../scripts/jira-transition-transport.mjs';
import { fixture, transport, response } from './support/jira-readiness-fixture.mjs';

const failure = { message: 'JIRA_TRANSITION_TRANSPORT_UNVERIFIED' };
const attempt = () => ({ state: 'pending', attemptId: '11111111-1111-1111-1111-111111111111',
  decisionKey: 'a'.repeat(64), registerDigest: 'b'.repeat(64), actorId: 'synthetic-writer',
  transitionId: '2', sourceStatusId: '10004', targetStatusId: '10009', createdAt: new Date().toISOString() });
const provider = (f, mutate) => ({ ...f.options, issueId: f.issue.id, ...transport(f, mutate) });

test('transition resolution binds target status and source identity despite a misleading transition name', async () => {
  const f = fixture();
  const result = await readJiraReadyTransition(provider(f));
  assert.equal(result.transitionId, '2');
  assert.equal(result.sourceStatusId, '10004');
  assert.equal(result.targetStatusId, '10009');
  assert.equal(f.posts, 0);
});
for (const [name, value] of Object.entries({
  global: { isGlobal: true }, unknownGlobal: { isGlobal: undefined }, unavailable: { isAvailable: false },
  initial: { isInitial: true }, screen: { hasScreen: true },
  mandatoryField: { fields: { resolution: { required: true } } },
  unknownField: { fields: { resolution: {} } }, unknownFields: { fields: undefined },
  badId: { id: '../Done' }, done: { to: { id: '10009', name: 'Done', statusCategory: { key: 'done' } } },
})) {
  test(`unsupported ${name} fails before any mutation`, async () => {
    const f = fixture(); f.transitionOverride = value;
    await assert.rejects(readJiraReadyTransition(provider(f)), failure);
    assert.equal(f.posts, 0);
  });
}
test('wrong issue, source drift, malformed provider response and auth failures fail closed', async () => {
  for (const mutate of [
    f => { f.issue.id = '999'; }, f => { f.issue.fields.status.name = 'Done'; },
    (_f, url) => url.includes('/transitions') ? response({ transitions: [] }) : undefined,
    () => new Response('private token', { status: 403 }),
    () => new Response('{}', { headers: { 'content-type': 'text/html' } }),
    () => response({ padding: 'x'.repeat(256 * 1024) }),
  ]) {
    const f = fixture(); const options = provider(f, mutate);
    await assert.rejects(readJiraReadyTransition(options), failure);
    assert.equal(f.posts, 0);
  }
});
test('one-shot POST carries the committed attempt identity and a restart only observes its history', async () => {
  const f = fixture(); const pending = attempt(); const options = provider(f);
  await submitJiraReadyTransition({ ...options, attempt: pending });
  assert.equal(f.posts, 1);
  assert.deepEqual(f.histories[0].historyMetadata, { type: JIRA_TRANSITION_HISTORY_TYPE,
    extraData: { attemptId: pending.attemptId, decisionKey: pending.decisionKey, registerDigest: pending.registerDigest } });
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await observeJiraReadyTransition({ ...provider(f), attempt: pending }),
      { completed: true, historyId: '1', atTarget: true });
    assert.equal(f.posts, 1);
  }
  f.issue.fields.status.name = 'Done';
  assert.equal((await observeJiraReadyTransition({ ...provider(f), attempt: pending })).atTarget, false);
});
test('an unknown accepted POST remains recoverable and is never replayed by observation', async () => {
  const f = fixture(); f.unknownPost = true; const pending = attempt();
  await assert.rejects(submitJiraReadyTransition({ ...provider(f), attempt: pending }), failure);
  assert.equal((await observeJiraReadyTransition({ ...provider(f), attempt: pending })).completed, true);
  assert.equal(f.posts, 1);
});
test('status alone, a rejected POST and an unrelated nonce cannot establish a receipt', async () => {
  const f = fixture(); const pending = attempt();
  f.rejectPost = true;
  await assert.rejects(submitJiraReadyTransition({ ...provider(f), attempt: pending }), failure);
  f.issue.fields.status.name = 'Ready for Deployment';
  assert.deepEqual(await observeJiraReadyTransition({ ...provider(f), attempt: pending }), { completed: false });
  assert.equal(f.posts, 1);
});
for (const [name, corrupt] of Object.entries({
  actor: row => { row.author.accountId = 'other-writer'; },
  decision: row => { row.historyMetadata.extraData.decisionKey = 'c'.repeat(64); },
  digest: row => { row.historyMetadata.extraData.registerDigest = 'c'.repeat(64); },
  type: row => { row.historyMetadata.type = 'unrelated'; },
  source: row => { row.items[0].from = '999'; }, target: row => { row.items[0].to = '999'; },
  oldTime: row => { row.created = '2020-01-01T00:00:00.000Z'; },
  duplicateStatus: row => { row.items.push({ ...row.items[0] }); },
})) {
  test(`a matching nonce with wrong ${name} cannot confirm a transition`, async () => {
    const f = fixture(); const pending = attempt();
    await submitJiraReadyTransition({ ...provider(f), attempt: pending });
    corrupt(f.histories[0]);
    await assert.rejects(observeJiraReadyTransition({ ...provider(f), attempt: pending }), failure);
    assert.equal(f.posts, 1);
  });
}
test('recovery traverses complete history pages and rejects duplicate or truncated histories', async () => {
  const f = fixture(); const pending = attempt();
  f.histories = Array.from({ length: 100 }, (_, i) => ({ id: String(i + 1) }));
  await submitJiraReadyTransition({ ...provider(f), attempt: pending });
  assert.deepEqual(await observeJiraReadyTransition({ ...provider(f), attempt: pending }),
    { completed: true, historyId: '101', atTarget: true });
  f.histories.push({ ...f.histories[100], id: '102' });
  await assert.rejects(observeJiraReadyTransition({ ...provider(f), attempt: pending }), failure);
  f.histories.pop();
  await assert.rejects(observeJiraReadyTransition({ ...provider(f, (_f, url) => url.includes('startAt=100')
    ? response({ startAt: 100, total: 101, isLast: true, values: [] }) : undefined), attempt: pending }), failure);
});
test('foreign destinations and malformed attempts are rejected without outbound traffic', async () => {
  for (const change of [{ cloudId: 'https://evil.test' }, { issueKey: 'CO-296/../Done' },
    { issueId: '001' }, { attempt: { ...attempt(), state: 'confirmed' } }]) {
    await assert.rejects(submitJiraReadyTransition({ ...fixture().options, issueId: '10001', attempt: attempt(),
      ...change, fetchImpl: () => assert.fail('must not fetch') }), failure);
  }
});
