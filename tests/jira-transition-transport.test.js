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

test('large description history pages shrink without losing the original transition or replaying it', async () => {
  const f = fixture(); const pending = attempt();
  f.histories = Array.from({ length: 54 }, (_, i) => ({ id: String(i + 1),
    items: [{ field: 'description', fromString: 'x'.repeat(30000), toString: 'y'.repeat(30000) }] }));
  await submitJiraReadyTransition({ ...provider(f), attempt: pending });
  const options = provider(f);
  assert.deepEqual(await observeJiraReadyTransition({ ...options, attempt: pending }),
    { completed: true, historyId: '55', atTarget: true });
  const pages = options.calls.filter(call => call.url.includes('/changelog?'));
  assert.deepEqual(pages.slice(0, 6).map(call => new URL(call.url).searchParams.get('maxResults')),
    ['100', '50', '25', '12', '6', '3']);
  assert.ok(pages.slice(0, 6).every(call => new URL(call.url).searchParams.get('startAt') === '0'));
  assert.equal(new URL(pages.at(-1).url).searchParams.get('startAt'), '54');
  assert.equal(f.posts, 1);
});

test('an oversized single history entry still fails closed after bounded page reduction', async () => {
  const f = fixture(); const pending = attempt();
  await submitJiraReadyTransition({ ...provider(f), attempt: pending });
  f.histories.unshift({ id: '99', items: [{ field: 'description', toString: 'x'.repeat(256 * 1024) }] });
  const options = provider(f);
  await assert.rejects(observeJiraReadyTransition({ ...options, attempt: pending }), failure);
  const pages = options.calls.filter(call => call.url.includes('/changelog?'));
  assert.equal(pages.length, 7);
  assert.ok(pages.every(call => new URL(call.url).searchParams.get('startAt') === '0'));
  assert.equal(new URL(pages.at(-1).url).searchParams.get('maxResults'), '1');
  assert.equal(f.posts, 1);
});

test('auth, malformed JSON, interrupted streams and transport errors never trigger read retries', async () => {
  for (const fail of [
    () => new Response('private credentials', { status: 403 }),
    () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('private stream')); } }),
      { headers: { 'content-type': 'application/json' } }),
    () => { throw new Error('private transport'); },
  ]) {
    const f = fixture(); const options = provider(f, (_f, url) => url.includes('/changelog?') ? fail() : undefined);
    await assert.rejects(observeJiraReadyTransition({ ...options, attempt: attempt() }), failure);
    assert.equal(options.calls.filter(call => call.url.includes('/changelog?')).length, 1);
    assert.equal(f.posts, 0);
  }
});

test('small provider pages cannot exceed the recovery request budget', async () => {
  const f = fixture();
  const options = provider(f, (_f, url) => {
    if (!url.includes('/changelog?')) return undefined;
    const offset = Number(new URL(url).searchParams.get('startAt'));
    return response({ startAt: offset, total: 101, isLast: offset === 100, values: [{ id: String(offset + 1) }] });
  });
  await assert.rejects(observeJiraReadyTransition({ ...options, attempt: attempt() }), failure);
  assert.equal(options.calls.filter(call => call.url.includes('/changelog?')).length, 100);
  assert.equal(f.posts, 0);
});

test('reduced pages still reject a duplicate receipt after the first match and changing totals', async () => {
  for (const drift of [false, true]) {
    const f = fixture(); const pending = attempt();
    await submitJiraReadyTransition({ ...provider(f), attempt: pending });
    f.histories.push(...Array.from({ length: 10 }, (_, i) => ({ id: String(i + 2), padding: 'x'.repeat(60000) })));
    f.histories.push({ ...f.histories[0], id: '12' });
    const options = provider(f, (_f, url) => {
      if (!drift || !url.includes('/changelog?startAt=3&')) return undefined;
      return response({ startAt: 3, total: 13, isLast: false, values: f.histories.slice(3, 6) });
    });
    await assert.rejects(observeJiraReadyTransition({ ...options, attempt: pending }), failure);
    assert.equal(f.posts, 1);
  }
});

test('complete large-history recovery tolerates cumulative latency beyond one request deadline', async t => {
  const f = fixture(); const pending = attempt();
  f.histories = Array.from({ length: 54 }, (_, i) => ({ id: String(i + 1),
    items: [{ field: 'description', fromString: 'x'.repeat(30000), toString: 'y'.repeat(30000) }] }));
  await submitJiraReadyTransition({ ...provider(f), attempt: pending });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const observations = [];
  const options = provider(f, (_f, url) => {
    if (url.includes('/changelog?')) t.mock.timers.tick(2000);
  });
  assert.deepEqual(await observeJiraReadyTransition({ ...options, attempt: pending,
    onHistoryObservation: value => observations.push(value) }),
  { completed: true, historyId: '55', atTarget: true });
  assert.equal(f.posts, 1);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].outcome, 'matched');
  assert.equal(observations[0].entries, 55);
  assert.equal(observations[0].requests, options.calls.filter(call => call.url.includes('/changelog?')).length);
});

test('each history request retains its deadline through stalled headers or response-body consumption', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const phase of ['headers', 'body']) {
    const f = fixture(); const pending = attempt(); const observations = [];
    await submitJiraReadyTransition({ ...provider(f), attempt: pending });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const options = provider(f, (_f, url, calls) => {
      if (!url.includes('/changelog?')) return undefined;
      const signal = calls.at(-1).init.signal;
      if (phase === 'headers') return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('private provider timeout')), { once: true });
        entered();
      });
      return new Response(new ReadableStream({ start(controller) {
        signal.addEventListener('abort', () => controller.error(new Error('private provider body')), { once: true });
        entered();
      } }), { headers: { 'content-type': 'application/json' } });
    });
    const rejected = assert.rejects(observeJiraReadyTransition({ ...options, attempt: pending,
      onHistoryObservation: value => observations.push(value) }), failure);
    await started;
    t.mock.timers.tick(15000);
    await rejected;
    assert.equal(f.posts, 1);
    assert.equal(observations[0].phase, 'history');
    assert.equal(observations[0].outcome, 'unverified');
    assert.equal(observations[0].requests, 1);
    assert.equal(observations[0].entries, 0);
    assert.doesNotMatch(JSON.stringify(observations), /private|token|CO-296|11111111/);
  }
});

test('the overall history deadline stops otherwise responsive pages without replay', async t => {
  const f = fixture(); const pending = attempt();
  f.histories = Array.from({ length: 75 }, (_, i) => ({ id: String(i + 1) }));
  await submitJiraReadyTransition({ ...provider(f), attempt: pending });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const observations = [];
  const options = provider(f, (_f, url) => {
    if (!url.includes('/changelog?')) return undefined;
    const offset = Number(new URL(url).searchParams.get('startAt'));
    t.mock.timers.tick(1000);
    return response({ startAt: offset, total: 76, isLast: offset === 75, values: f.histories.slice(offset, offset + 1) });
  });
  await assert.rejects(observeJiraReadyTransition({ ...options, attempt: pending,
    onHistoryObservation: value => observations.push(value) }), failure);
  assert.equal(observations[0].outcome, 'unverified');
  assert.equal(observations[0].requests, 60);
  assert.equal(observations[0].entries, 59);
  assert.equal(options.calls.filter(call => call.url.includes('/changelog?')).length, 60);
  assert.equal(f.posts, 1);
});

test('transition resolution and an accepted but late POST keep their original total deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const slowRead = provider(f, () => { t.mock.timers.tick(15000); });
  await assert.rejects(readJiraReadyTransition(slowRead), failure);
  assert.equal(f.posts, 0);
  const slowPost = provider(f, (_f, url) => { if (url.endsWith('/transitions')) t.mock.timers.tick(15000); });
  await assert.rejects(submitJiraReadyTransition({ ...slowPost, attempt: attempt() }), failure);
  assert.equal(f.posts, 1);
});

test('invalid history and diagnostic callback failures expose no source content', async () => {
  const f = fixture(); const pending = attempt(); const observations = [];
  await submitJiraReadyTransition({ ...provider(f), attempt: pending });
  f.histories[0].author.accountId = 'private-foreign-actor';
  await assert.rejects(observeJiraReadyTransition({ ...provider(f), attempt: pending,
    onHistoryObservation: value => observations.push(value) }), failure);
  assert.equal(observations[0].phase, 'validation');
  assert.equal(observations[0].outcome, 'unverified');
  assert.deepEqual(Object.keys(observations[0]).sort(), ['elapsedMs', 'entries', 'outcome', 'phase', 'requests']);
  assert.doesNotMatch(JSON.stringify(observations), /private|synthetic|CO-296|11111111/);
  f.histories[0].author.accountId = f.options.actorId;
  await assert.rejects(observeJiraReadyTransition({ ...provider(f), attempt: pending,
    onHistoryObservation: () => { throw new Error('private diagnostic failure'); } }), failure);
  assert.equal(f.posts, 1);
});
