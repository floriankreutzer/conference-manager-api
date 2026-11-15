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
  for (const withMetadata of [false, true]) {
    const suffix = withMetadata ? ' with ADF uniqueId' : '';
    test(`reader rejects ${name}${suffix} without a write or fallback`, async () => {
      const fixture = scopeRevisionProvider();
      if (withMetadata) fixture.state.comment.body.content[0].attrs.uniqueId = 'synthetic-node-id';
      modify(fixture.state);
      await assert.rejects(readJiraScopeDecision(fixture.options), rejected);
      assert.equal(fixture.state.puts.length, 0);
    });
  }
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

for (const [name, uniqueId] of [
  ['one character', 'a'],
  ['synthetic twelve-character identifier', '012345abcdef'],
  ['letters, digits, underscores and hyphens', 'Node_42-test'],
  ['UUID-shaped identifier', '11111111-2222-3333-4444-555555555555'],
  ['128 characters', 'a'.repeat(128)],
]) {
  test(`reader preserves the exact proof with optional ADF uniqueId: ${name}`, async () => {
    const fixture = scopeRevisionProvider();
    const original = await readJiraScopeDecision(fixture.options);
    fixture.state.comment.body.content[0].attrs.uniqueId = uniqueId;
    const result = await readJiraScopeDecision(fixture.options);
    assert.deepEqual(result, original);
    assert.deepEqual(result, fixture.proof);
    assert.equal(fixture.state.puts.length, 0);
  });
}

for (const parts of [2, 16]) {
  test(`ADF uniqueId preserves the approved bytes across ${parts} plain text nodes`, async () => {
    const fixture = scopeRevisionProvider();
    const block = fixture.state.comment.body.content[0];
    const text = fixture.proof.decisionText;
    block.attrs.uniqueId = 'synthetic-node-id';
    block.content = Array.from({ length: parts }, (_, index) => ({
      type: 'text',
      text: text.slice(Math.floor(text.length * index / parts), Math.floor(text.length * (index + 1) / parts)),
    }));
    assert.deepEqual(await readJiraScopeDecision(fixture.options), fixture.proof);
    assert.equal(fixture.state.puts.length, 0);
  });
}

for (const [name, uniqueId] of [
  ['null', null],
  ['boolean', false],
  ['number', 12],
  ['array', ['node']],
  ['object', { id: 'node' }],
  ['empty string', ''],
  ['129 characters', 'a'.repeat(129)],
  ['space', 'node id'],
  ['trailing newline', 'node\n'],
  ['trailing carriage return', 'node\r'],
  ['tab', 'node\tid'],
  ['NUL', 'node\u0000id'],
  ['line separator', 'node\u2028'],
  ['non-ASCII character', 'node-\u00e9'],
  ['HTML-shaped value', '<node>'],
  ['path-shaped value', 'node/id'],
]) {
  test(`reader rejects malformed ADF uniqueId: ${name}`, async () => {
    const fixture = scopeRevisionProvider();
    fixture.state.comment.body.content[0].attrs.uniqueId = uniqueId;
    await assert.rejects(readJiraScopeDecision(fixture.options), rejected);
    assert.equal(fixture.state.puts.length, 0);
  });
}

for (const [name, modify] of [
  ['unknown attribute', body => { body.content[0].attrs.unknown = true; }],
  ['localId attribute', body => { body.content[0].attrs.localId = 'other-node'; }],
  ['wrap attribute', body => { body.content[0].attrs.wrap = false; }],
  ['hideLineNumbers attribute', body => { body.content[0].attrs.hideLineNumbers = false; }],
  ['different language', body => { body.content[0].attrs.language = 'JSON'; }],
  ['missing language', body => { delete body.content[0].attrs.language; }],
  ['document-level uniqueId', body => { body.uniqueId = 'other-node'; }],
  ['block-level uniqueId', body => { body.content[0].uniqueId = 'other-node'; }],
  ['text-level uniqueId', body => { body.content[0].content[0].uniqueId = 'other-node'; }],
  ['absent text nodes', body => { body.content[0].content = []; }],
  ['17 text nodes', body => {
    body.content[0].content.push(...Array.from({ length: 16 }, () => ({ type: 'text', text: '' })));
  }],
]) {
  test(`optional ADF uniqueId does not admit ${name}`, async () => {
    const fixture = scopeRevisionProvider();
    fixture.state.comment.body.content[0].attrs.uniqueId = 'synthetic-node-id';
    modify(fixture.state.comment.body);
    await assert.rejects(readJiraScopeDecision(fixture.options), rejected);
    assert.equal(fixture.state.puts.length, 0);
  });
}
