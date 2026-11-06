import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { readJiraRegister, JIRA_REGISTER_PROPERTY } from '../scripts/jira-register-reader.mjs';
import { runJiraRegisterDiagnostic } from '../scripts/jira-register-diagnostic.mjs';

const config = { cloudId: '00000000-0000-0000-0000-000000000001', email: 'test@example.invalid',
  token: 'test-only-jira-token', issueKey: 'CO-296' };
const issue = { id: '123', key: 'CO-296', fields: { project: { key: 'CO' },
  status: { name: 'in Review' }, updated: '2026-11-06T10:00:00.000+0000' } };
const scope = { schemaVersion: 1, issueKey: 'CO-296', version: 1, closed: true,
  entries: [{ repository: 'floriankreutzer/conference-manager-api', number: 379, kind: 'delivery' }] };
const response = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const mock = (property = { key: JIRA_REGISTER_PROPERTY, value: scope }) => async (url) => (
  url.includes('/properties/') ? response(property) : response(issue));

test('reads only fixed Jira origin and exact CO issue with scoped-token basic auth', async () => {
  const calls = [];
  const result = await readJiraRegister({ ...config, fetchImpl: async (url, options) => {
    calls.push(url);
    assert.equal(new URL(url).origin, 'https://api.atlassian.com');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Basic ${Buffer.from(`${config.email}:${config.token}`).toString('base64')}`);
    assert.ok(options.signal instanceof AbortSignal);
    return mock()(url);
  } });
  assert.equal(calls.length, 2);
  assert.deepEqual(result.scope, scope);
  assert.equal(result.enrollmentRequired, false);
});
test('missing property requires enrollment and confers no readiness', async () => {
  const result = await readJiraRegister({ ...config, fetchImpl: async (url) => (
    url.includes('/properties/') ? new Response(null, { status: 404 }) : response(issue)) });
  assert.equal(result.scope, null);
  assert.equal(result.enrollmentRequired, true);
  assert.equal(result.eligible, undefined);
});
for (const [name, change] of [
  ['foreign project', (x) => { x.fields.project.key = 'OTHER'; }],
  ['wrong issue', (x) => { x.key = 'CO-297'; }],
  ['missing identity', (x) => { delete x.id; }],
  ['invalid updated time', (x) => { x.fields.updated = 'not a timestamp'; }],
  ['nonstandard updated time', (x) => { x.fields.updated = '0'; }],
  ['missing status', (x) => { delete x.fields.status; }],
]) {
  test(`rejects ${name} before property request`, async () => {
    const invalid = structuredClone(issue); change(invalid);
    let calls = 0;
    await assert.rejects(readJiraRegister({ ...config, fetchImpl: async () => {
      calls++; return response(invalid);
    } }), { message: 'JIRA_REGISTER_READ_UNVERIFIED' });
    assert.equal(calls, 1);
  });
}
for (const status of [401, 403, 404, 429, 500]) {
  test(`issue HTTP ${status} fails closed`, async () => {
    await assert.rejects(readJiraRegister({ ...config, fetchImpl: async () => new Response(null, { status }) }),
      { message: 'JIRA_REGISTER_READ_UNVERIFIED' });
  });
}
for (const [name, value] of [['cloudId', '../foreign'], ['email', 'x\r\n@example.invalid'],
  ['token', 'short'], ['issueKey', 'OTHER-1'], ['issueKey', 'CO-1/../../myself']]) {
  test(`invalid ${name} performs no network I/O`, async () => {
    let calls = 0;
    await assert.rejects(readJiraRegister({ ...config, [name]: value, fetchImpl: async () => { calls++; } }),
      { message: 'JIRA_REGISTER_READ_UNVERIFIED' });
    assert.equal(calls, 0);
  });
}
test('invalid and oversized provider bodies fail without payload disclosure', async () => {
  for (const bad of [new Response('private invalid JSON', { headers: { 'content-type': 'application/json' } }),
    response('x'.repeat(256 * 1024 + 1)), new Response('{}', { headers: { 'content-type': 'text/html' } }),
    new Response('{}', { headers: { 'content-type': 'text/application/json' } })]) {
    await assert.rejects(readJiraRegister({ ...config, fetchImpl: async () => bad }),
      { message: 'JIRA_REGISTER_READ_UNVERIFIED' });
  }
});
test('malformed or cross-issue register cannot become trusted scope', async () => {
  for (const property of [{ key: 'other', value: scope }, { key: JIRA_REGISTER_PROPERTY, value: {} },
    { key: JIRA_REGISTER_PROPERTY, value: { ...scope, issueKey: 'CO-297' } }]) {
    await assert.rejects(readJiraRegister({ ...config, fetchImpl: mock(property) }),
      { message: 'JIRA_REGISTER_READ_UNVERIFIED' });
  }
});
test('aborts a stalled provider and redacts the transport failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = readJiraRegister({ ...config, fetchImpl: async (_, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('private timeout detail')), { once: true });
  }) });
  const rejected = assert.rejects(pending, { message: 'JIRA_REGISTER_READ_UNVERIFIED' });
  t.mock.timers.tick(15000);
  await rejected;
});
test('redirected responses and property access denials never become missing registers', async () => {
  const redirected = response(issue);
  Object.defineProperty(redirected, 'redirected', { value: true });
  await assert.rejects(readJiraRegister({ ...config, fetchImpl: async () => redirected }),
    { message: 'JIRA_REGISTER_READ_UNVERIFIED' });
  await assert.rejects(readJiraRegister({ ...config, fetchImpl: async (url) => (
    url.includes('/properties/') ? new Response(null, { status: 403 }) : response(issue)) }),
  { message: 'JIRA_REGISTER_READ_UNVERIFIED' });
});
test('diagnostic emits neither provider data nor credentials on success or failure', async () => {
  for (const fetchImpl of [mock(), async () => { throw new Error(config.token); }]) {
    const lines = [];
    const code = await runJiraRegisterDiagnostic({ ...config, fetchImpl, write: (line) => lines.push(line) });
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).mutationPerformed, false);
    assert.equal(JSON.parse(lines[0]).readinessEvaluated, false);
    for (const privateValue of [config.token, config.email, 'in Review', 'CO-296']) assert.ok(!lines[0].includes(privateValue));
    assert.ok(code === 0 || code === 1);
  }
});
test('diagnostic workflow protects credentials from PR code and shell input interpolation', () => {
  const yaml = readFileSync(new URL('../.github/workflows/jira-register-diagnostic.yml', import.meta.url), 'utf8');
  assert.match(yaml, /github.ref == 'refs\/heads\/main'/);
  assert.match(yaml, /persist-credentials: false/);
  assert.match(yaml, /CM_JIRA_ISSUE_KEY: \$\{\{ inputs.issue_key \}\}/);
  assert.match(yaml, /run: node scripts\/jira-register-diagnostic.mjs/);
  assert.doesNotMatch(yaml, /pull_request_target|schedule:|upload-artifact|: write/);
  for (const action of yaml.matchAll(/uses: (\S+)/g)) assert.match(action[1], /@[a-f0-9]{40}$/);
});
