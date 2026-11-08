import assert from 'node:assert/strict';
import test from 'node:test';
import { collectJiraReadinessCandidates } from '../scripts/jira-readiness-candidates.mjs';
import { options, response } from './support/jira-readiness-fixture.mjs';

const row = number => ({ id: String(number), key: `CO-${number}`,
  fields: { project: { key: 'CO' }, status: { name: 'in Review' } } });
const failure = { message: 'JIRA_READINESS_DISCOVERY_UNVERIFIED' };
test('authenticated bounded discovery follows provider cursors without granting readiness', async () => {
  const calls = [];
  const keys = await collectJiraReadinessCandidates({ ...options, fetchImpl: async (url, request) => {
    calls.push(url); const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.atlassian.com');
    assert.equal(parsed.pathname, `/ex/jira/${options.cloudId}/rest/api/3/search/jql`);
    assert.equal(parsed.searchParams.get('jql'), 'project = CO AND status = "in Review" ORDER BY key ASC');
    assert.equal(parsed.searchParams.get('fields'), 'key,project,status');
    assert.equal(request.method, 'GET'); assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, `Basic ${Buffer.from(`${options.email}:${options.token}`).toString('base64')}`);
    assert.ok(request.signal instanceof AbortSignal);
    return parsed.searchParams.has('nextPageToken') ? response({ isLast: true, issues: [row(3)] })
      : response({ isLast: false, nextPageToken: 'cursor+/=safe', issues: [row(1), row(2)] });
  } });
  assert.deepEqual(keys, ['CO-1', 'CO-2', 'CO-3']); assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1]).searchParams.get('nextPageToken'), 'cursor+/=safe');
});
test('an empty terminal page is a valid discovery result, never a complete delivery scope', async () => {
  assert.deepEqual(await collectJiraReadinessCandidates({ ...options,
    fetchImpl: async () => response({ isLast: true, issues: [] }) }), []);
});
test('duplicates, foreign issues, status drift, warnings and incomplete pagination fail the entire discovery', async () => {
  for (const page of [
    { isLast: true, issues: [row(1), row(1)] },
    { isLast: true, issues: [{ ...row(1), key: 'OTHER-1' }] },
    { isLast: true, issues: [{ ...row(1), fields: { project: { key: 'CO' }, status: { name: 'Done' } } }] },
    { isLast: true, issues: [row(1)], warningMessages: ['private warning'] },
    { isLast: false, issues: [row(1)] }, { isLast: false, nextPageToken: 'again', issues: [] },
    { isLast: true, issues: Array.from({ length: 51 }, (_, i) => row(i + 1)) },
    { issues: [] },
  ]) {
    await assert.rejects(collectJiraReadinessCandidates({ ...options, fetchImpl: async () => response(page) }), failure);
  }
});
test('repeated cursors and the overall page budget cannot produce partial success', async () => {
  for (const repeated of [true, false]) {
    let page = 0;
    await assert.rejects(collectJiraReadinessCandidates({ ...options, fetchImpl: async () => {
      page++; return response({ isLast: false, nextPageToken: repeated ? 'same' : `page-${page}`, issues: [row(page)] });
    } }), failure);
    assert.equal(page, repeated ? 2 : 20);
  }
});
test('authorization, redirects, content type and excessive bytes remain redacted failures', async () => {
  for (const result of [() => new Response(options.token, { status: 403 }),
    () => new Response('{}', { headers: { 'content-type': 'text/plain' } }),
    () => response({ padding: 'x'.repeat(256 * 1024) }),
    () => { const value = response({ isLast: true, issues: [] }); Object.defineProperty(value, 'redirected', { value: true });
      return value; }]) {
    await assert.rejects(collectJiraReadinessCandidates({ ...options, fetchImpl: async () => result() }), failure);
  }
});
test('invalid provider identity never reaches the network', async () => {
  for (const change of [{ cloudId: 'https://evil.test' }, { email: 'unsafe:user@example.test' }, { token: 'short' }]) {
    await assert.rejects(collectJiraReadinessCandidates({ ...options, ...change,
      fetchImpl: () => assert.fail('must not fetch') }), failure);
  }
});
