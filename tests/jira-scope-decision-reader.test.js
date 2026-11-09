import assert from 'node:assert/strict';
import test from 'node:test';
import { readJiraScopeDecision, readJiraScopeWriter } from '../scripts/jira-scope-decision-reader.mjs';
import { actorId, scopeRevisionProvider } from './support/jira-scope-revision-fixture.mjs';

const rejected = /^Error: JIRA_SCOPE_DECISION_READ_UNVERIFIED$/;

test('reader binds the exact unedited JSON comment to the actual configured writer token', async () => {
  const fixture = scopeRevisionProvider();
  const result = await readJiraScopeDecision(fixture.options);
  assert.deepEqual(result, fixture.proof);
  assert.deepEqual(Object.keys(result).sort(), ['actorId', 'commentId', 'createdAt', 'decisionDigest', 'decisionText']);
  assert.equal(await readJiraScopeWriter(fixture.options), actorId);
  assert.equal(fixture.state.puts.length, 0);
});

for (const [name, modify] of [
  ['different token account', state => { state.tokenActor = 'other-writer'; }],
  ['unconfigured author', state => { state.comment.author.accountId = 'other-author'; }],
  ['different update author', state => { state.comment.updateAuthor.accountId = 'other-editor'; }],
  ['inactive author', state => { state.comment.author.active = false; }],
  ['edited comment', state => { state.comment.updated = '2026-11-09T12:01:00.000Z'; }],
  ['changed comment identity', state => { state.comment.id = '10002'; }],
  ['deleted comment', state => { state.deletedComment = true; }],
  ['unsigned additional content', state => { state.comment.body.content.push({ type: 'paragraph', content: [] }); }],
  ['formatted or linked JSON', state => {
    state.comment.body.content[0].content[0].marks = [{ type: 'link', attrs: { href: 'https://evil.test' } }];
  }],
  ['different digest bytes', state => { state.comment.body.content[0].content[0].text += '\n'; }],
]) {
  test(`reader rejects ${name} without a write or fallback`, async () => {
    const fixture = scopeRevisionProvider(); modify(fixture.state);
    await assert.rejects(readJiraScopeDecision(fixture.options), rejected);
    assert.equal(fixture.state.puts.length, 0);
  });
}

test('malformed references and absent actor configuration fail before I/O', async () => {
  const fixture = scopeRevisionProvider();
  for (const changed of [{ commentId: '../other' }, { actorId: '' }, { actorId: undefined },
    { cloudId: 'https://evil.test' }, { issueKey: 'CO-296/other' }, { expectedDecisionDigest: 'approved' },
    { token: 'private token with spaces' }]) {
    await assert.rejects(readJiraScopeDecision({ ...fixture.options, ...changed,
      fetchImpl: () => assert.fail('invalid input must not select any endpoint') }), rejected);
  }
});

test('provider denial, redirect, oversized bytes and raw failures remain closed and redacted', async () => {
  const fixture = scopeRevisionProvider();
  for (const response of [new Response('private denial', { status: 403 }),
    new Response(null, { status: 302, headers: { location: 'https://evil.test/private' } }),
    new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } }),
    new Response('{}', { headers: { 'content-type': 'text/html' } })]) {
    await assert.rejects(readJiraScopeDecision({ ...fixture.options, fetchImpl: async () => response }), rejected);
  }
  await assert.rejects(readJiraScopeDecision({ ...fixture.options,
    fetchImpl: () => { throw new Error('private provider token'); } }), rejected);
});

test('read-only token binding alone is never accepted as a scope decision', async () => {
  const fixture = scopeRevisionProvider(); fixture.state.deletedComment = true;
  assert.equal(await readJiraScopeWriter(fixture.options), actorId);
  await assert.rejects(readJiraScopeDecision(fixture.options), rejected);
});
