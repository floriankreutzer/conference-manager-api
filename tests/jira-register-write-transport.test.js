import assert from 'node:assert/strict';
import test from 'node:test';
import { startJiraRegisterWrite, observeJiraRegisterWrite } from '../scripts/jira-register-write-transport.mjs';
import { JIRA_REGISTER_PROPERTY } from '../scripts/jira-register-reader.mjs';

const config = { cloudId: '11111111-1111-1111-1111-111111111111', email: 'test@example.invalid',
  token: 'test-only-jira-token', issueKey: 'CO-296', issueId: '123' };
const scope = version => ({ schemaVersion: 1, issueKey: 'CO-296', version, closed: true,
  entries: Array.from({ length: version }, (_, index) => ({ repository: 'floriankreutzer/conference-manager-api',
    number: index + 1, kind: 'delivery' })) });
const issue = { id: '123', key: 'CO-296', fields: { project: { key: 'CO' },
  status: { name: 'in Review' }, updated: '2026-11-07T10:00:00.000+0000' } };
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const failure = /^Error: JIRA_REGISTER_WRITE_UNVERIFIED$/;

function provider({ previous = null, location = 'https://tenant.atlassian.net/rest/api/3/task/1', status = 303,
  taskStatus = 'COMPLETE', taskIdentity = '1', resultScope = scope(1), issueValue = issue, afterPut } = {}) {
  const calls = [];
  let taskRead = false;
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    assert.equal(new URL(url).origin, 'https://api.atlassian.com');
    assert.ok(url.startsWith(`https://api.atlassian.com/ex/jira/${config.cloudId}/rest/api/3/`));
    assert.ok(options.signal instanceof AbortSignal);
    if (options.method === 'PUT') {
      if (afterPut) return afterPut();
      return new Response(null, { status, headers: { location } });
    }
    if (url.includes('/task/')) {
      taskRead = true;
      return json({ id: taskIdentity, status: taskStatus });
    }
    if (url.includes('/properties/')) {
      const value = taskRead ? resultScope : previous;
      return value === null ? new Response(null, { status: 404 }) : json({ key: JIRA_REGISTER_PROPERTY, value });
    }
    return json(issueValue);
  } };
}

test('enrollment binds exactly one issue and the absent-property condition; never follows the task redirect', async () => {
  const mock = provider();
  const result = await startJiraRegisterWrite({ ...config, nextScope: scope(1), fetchImpl: mock.fetchImpl });
  assert.equal(result.taskId, '1');
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.equal(result.readinessAuthorized, undefined);
  const writes = mock.calls.filter(call => call.options.method === 'PUT');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].url.endsWith(`/issue/properties/${JIRA_REGISTER_PROPERTY}`), true);
  assert.equal(writes[0].options.redirect, 'manual');
  assert.deepEqual(JSON.parse(writes[0].options.body), { filter: { entityIds: [123], hasProperty: false }, value: scope(1) });
  assert.equal(mock.calls.some(call => call.url.includes('/task/')), false);
});

test('update requires the exact previous property in the provider-side filter', async () => {
  const mock = provider({ previous: scope(1) });
  await startJiraRegisterWrite({ ...config, expectedScope: scope(1), nextScope: scope(2), fetchImpl: mock.fetchImpl });
  const request = JSON.parse(mock.calls.find(call => call.options.method === 'PUT').options.body);
  assert.deepEqual(request.filter, { entityIds: [123], hasProperty: true, currentValue: scope(1) });
});

for (const [name, options] of [
  ['stale previous property', { previous: scope(2) }],
  ['foreign issue identity', { issueValue: { ...issue, id: '456' } }],
  ['Done issue', { issueValue: { ...issue, fields: { ...issue.fields, status: { name: 'Done' } } } }],
]) {
  test(`refuses ${name} before mutation`, async () => {
    const mock = provider(options);
    await assert.rejects(startJiraRegisterWrite({ ...config, expectedScope: scope(1), nextScope: scope(2),
      fetchImpl: mock.fetchImpl }), failure);
    assert.equal(mock.calls.some(call => call.options.method === 'PUT'), false);
  });
}

for (const [name, change] of [
  ['unsafe numeric identity', { issueId: '9007199254740992' }],
  ['skipped version', { nextScope: scope(3) }],
  ['foreign scope', { nextScope: { ...scope(1), issueKey: 'CO-297' } }],
  ['invalid credential', { token: 'bad\ncredential' }],
]) {
  test(`rejects ${name} before network I/O`, async () => {
    await assert.rejects(startJiraRegisterWrite({ ...config, nextScope: scope(1), ...change,
      fetchImpl: () => assert.fail('unexpected transport') }), failure);
  });
}

for (const status of [200, 201, 301, 400, 401, 403, 409, 429, 500]) {
  test(`HTTP ${status} is not asynchronous acceptance and never triggers a write retry`, async () => {
    const mock = provider({ status });
    await assert.rejects(startJiraRegisterWrite({ ...config, nextScope: scope(1), fetchImpl: mock.fetchImpl }), failure);
    assert.equal(mock.calls.filter(call => call.options.method === 'PUT').length, 1);
  });
}

for (const location of ['http://tenant.atlassian.net/rest/api/3/task/1', 'https://user:pass@host/rest/api/3/task/1',
  '/rest/api/3/task/1?token=private', '/rest/api/3/task/1#fragment', '/rest/api/3/issue/123', '/rest/api/3/task/../1']) {
  test(`invalid task location is rejected: ${location}`, async () => {
    const mock = provider({ location });
    await assert.rejects(startJiraRegisterWrite({ ...config, nextScope: scope(1), fetchImpl: mock.fetchImpl }), failure);
    assert.equal(mock.calls.length, 3);
  });
}

test('an unknown write outcome exposes neither payload nor a false no-mutation claim', async () => {
  const mock = provider({ afterPut: () => { throw new Error('secret provider payload'); } });
  await assert.rejects(startJiraRegisterWrite({ ...config, nextScope: scope(1), fetchImpl: mock.fetchImpl }), failure);
  assert.equal(mock.calls.filter(call => call.options.method === 'PUT').length, 1);
});

test('completion requires a fresh property read after the task completed', async () => {
  const mock = provider({ previous: null });
  const result = await observeJiraRegisterWrite({ ...config, taskId: '1', expectedScope: scope(1), fetchImpl: mock.fetchImpl });
  assert.equal(result.completed, true);
  assert.deepEqual(result.scope, scope(1));
  const taskIndex = mock.calls.findIndex(call => call.url.includes('/task/'));
  assert.equal(mock.calls.slice(taskIndex + 1).filter(call => call.url.includes('/properties/')).length, 1);
  assert.equal(mock.calls.every(call => call.options.method === 'GET'), true);
});

for (const taskStatus of ['ENQUEUED', 'RUNNING']) {
  test(`${taskStatus} stays incomplete without polling or mutation`, async () => {
    const mock = provider({ taskStatus });
    assert.deepEqual(await observeJiraRegisterWrite({ ...config, taskId: '1', expectedScope: scope(1),
      fetchImpl: mock.fetchImpl }), { completed: false });
    assert.equal(mock.calls.length, 3);
  });
}

for (const options of [{ taskStatus: 'FAILED' }, { taskStatus: 'CANCELLED' }, { taskStatus: 'UNKNOWN' },
  { taskIdentity: '2' }, { resultScope: null }, { resultScope: scope(2) }]) {
  test(`task or property mismatch fails closed: ${JSON.stringify(options)}`, async () => {
    const mock = provider(options);
    await assert.rejects(observeJiraRegisterWrite({ ...config, taskId: '1', expectedScope: scope(1),
      fetchImpl: mock.fetchImpl }), failure);
    assert.equal(mock.calls.every(call => call.options.method === 'GET'), true);
  });
}

test('task input cannot select an arbitrary URL', async () => {
  await assert.rejects(observeJiraRegisterWrite({ ...config, taskId: '../issue/1', expectedScope: scope(1),
    fetchImpl: () => assert.fail('unexpected transport') }), failure);
});
