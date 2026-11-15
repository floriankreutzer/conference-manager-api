import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalJiraRegister } from '../scripts/jira-register-journal.mjs';
import { deriveJiraScopeRevision, normalizeJiraScopeDecision, normalizeJiraScopeExecution,
  parseJiraScopeDecision, assertJiraScopeRevisionHeads } from '../scripts/jira-register-scope-revision.mjs';
import { checkpoint, execution, initialScope, makeDecision, reference, repositories } from './support/jira-scope-revision-fixture.mjs';

const rejected = /^Error: JIRA_SCOPE_REVISION_UNVERIFIED$/;

test('exact supersession retains all original obligations and adds only its direct replacement', () => {
  const original = initialScope();
  original.entries.push({ repository: 'other/support', number: 10, kind: 'supporting', reason: 'Existing authorized supporting scope' });
  const current = checkpoint(original);
  const before = structuredClone(current);
  const proof = makeDecision(current);
  const next = canonicalJiraRegister(deriveJiraScopeRevision(current, proof));
  assert.equal(next.scope.version, 2);
  assert.equal(next.scope.entries.length, 4);
  assert.deepEqual(next.scope.entries.find(entry => entry.repository === repositories[1]), reference(2, repositories[1]));
  assert.deepEqual(next.scope.entries.find(entry => entry.repository === 'other/support'), original.entries[2]);
  const old = next.scope.entries.find(entry => entry.number === 1);
  assert.equal(old.kind, 'superseded');
  assert.deepEqual(old.replacedBy, { repository: repositories[0], number: 3 });
  assert.equal(next.scope.entries.find(entry => entry.number === 3).kind, 'delivery');
  assert.deepEqual(current, before, 'neither caller data nor historic checkpoint can be overwritten');
  assert.equal(normalizeJiraScopeDecision(proof).decisionDigest, proof.decisionDigest);
});

test('an already registered delivery replacement is retained without duplication', () => {
  const original = initialScope(); original.entries.push(reference(3));
  const current = checkpoint(original);
  const next = deriveJiraScopeRevision(current, makeDecision(current));
  assert.equal(next.entries.length, 3);
  assert.equal(next.entries.filter(entry => entry.number === 3).length, 1);
});

for (const [name, modify] of [
  ['wrong operation', value => { value.operation = 'supporting'; }],
  ['caller authority', value => { value.authorized = true; }],
  ['empty changes', value => { value.supersessions = []; }],
  ['too many changes', value => { value.supersessions = Array.from({ length: 21 }, () => value.supersessions[0]); }],
  ['duplicate source', value => { value.supersessions.push(structuredClone(value.supersessions[0])); }],
  ['foreign repository', value => { value.supersessions[0].repository = 'other/repo'; }],
  ['cross-repository substitution', value => { value.supersessions[0].replacedBy.repository = repositories[1]; }],
  ['self replacement', value => { value.supersessions[0].replacedBy.number = 1; }],
  ['missing reason', value => { value.supersessions[0].reason = ''; }],
  ['multiline reason', value => { value.supersessions[0].reason = 'Hidden\nmeaning'; }],
  ['unbound replacement head', value => { delete value.supersessions[0].replacedBy.headSha; }],
  ['invalid version', value => { value.expectedRegisterVersion = 2147483647; }],
]) {
  test(`decision rejects ${name}`, () => {
    const value = JSON.parse(makeDecision().decisionText); modify(value);
    assert.throws(() => parseJiraScopeDecision(JSON.stringify(value)), rejected);
  });
}

test('decision bytes reject duplicate JSON keys, alternate escapes and an oversized document', () => {
  const text = makeDecision().decisionText;
  for (const changed of [text.replace('"schemaVersion": 1', '"schemaVersion": 2, "schemaVersion": 1'),
    text.replace('supersede', 'supersed\\u0065'), `${' '.repeat(16384)}${text}`]) {
    assert.throws(() => parseJiraScopeDecision(changed), rejected);
  }
});

for (const [name, modify] of [
  ['pending checkpoint', current => { current.state = 'pending'; }],
  ['wrong checkpoint digest', current => { current.digest = 'f'.repeat(64); }],
  ['later checkpoint', current => { current.scope.version = 2; }],
  ['different issue', current => { current.scope.issueKey = 'CO-300'; }],
  ['unregistered source', current => { current.scope.entries = [reference(2, repositories[1])]; }],
  ['supporting source', current => { current.scope.entries[0] = { ...reference(1), kind: 'supporting', reason: 'Already classified' }; }],
  ['supporting target', current => { current.scope.entries.push({ ...reference(3), kind: 'supporting', reason: 'Not delivery' }); }],
]) {
  test(`revision rejects ${name}`, () => {
    const current = checkpoint(initialScope());
    const proof = makeDecision(current); modify(current);
    assert.throws(() => deriveJiraScopeRevision(current, proof), rejected);
  });
}

test('an existing supersession cannot be turned into a replacement chain', () => {
  const scope = initialScope();
  scope.entries.push({ ...reference(4), kind: 'superseded', reason: 'Original prior decision',
    replacedBy: { repository: repositories[0], number: 1 } });
  const current = checkpoint(scope);
  assert.throws(() => deriveJiraScopeRevision(current, makeDecision(current)), rejected);
});

test('both source heads, missing records and duplicate records are enforced', () => {
  const proof = makeDecision();
  const source = { repository: repositories[0], number: 1, headSha: 'a'.repeat(40) };
  const target = { repository: repositories[0], number: 3, headSha: 'c'.repeat(40) };
  assert.doesNotThrow(() => assertJiraScopeRevisionHeads(proof, { pullRequests: [source, target] }));
  for (const pullRequests of [[target], [source], [source, target, target],
    [{ ...source, headSha: 'f'.repeat(40) }, target], [source, { ...target, headSha: 'f'.repeat(40) }]]) {
    assert.throws(() => assertJiraScopeRevisionHeads(proof, { pullRequests }), rejected);
  }
});

test('immutable provenance rejects changed decision bytes and invented execution authority', () => {
  const proof = makeDecision();
  assert.throws(() => normalizeJiraScopeDecision({ ...proof, decisionText: `${proof.decisionText}\n` }), rejected);
  assert.throws(() => normalizeJiraScopeDecision({ ...proof, authorized: true }), rejected);
  assert.throws(() => normalizeJiraScopeDecision({ ...proof, createdAt: '2026-02-30T00:00:00.000Z' }), rejected);
  assert.deepEqual(normalizeJiraScopeExecution(execution), execution);
  for (const change of [{ runAttempt: 2 }, { runId: 'unknown' }, { sourceSha: 'main' }, { githubActorId: '' }, { approved: true }]) {
    assert.throws(() => normalizeJiraScopeExecution({ ...execution, ...change }), rejected);
  }
  const text = `${proof.decisionText}\n`;
  assert.equal(normalizeJiraScopeDecision({ ...proof, decisionText: text,
    decisionDigest: createHash('sha256').update(text).digest('hex') }).decisionText, text);
});
