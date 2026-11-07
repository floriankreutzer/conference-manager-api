import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJiraRegister, createPostgresJiraRegisterJournal } from '../scripts/jira-register-journal.mjs';

const entry = number => ({ repository: 'floriankreutzer/conference-manager-api', number, kind: 'delivery' });
const scope = () => ({ schemaVersion: 1, issueKey: 'CO-296', version: 1, closed: true, entries: [entry(2), entry(1)] });

test('canonical register binds content and version independently of object/entry ordering', () => {
  const original = scope();
  const reversed = { entries: [...original.entries].reverse().map(({ kind, number, repository }) => ({ kind, number, repository })),
    closed: true, version: 1, issueKey: 'CO-296', schemaVersion: 1 };
  const first = canonicalJiraRegister(original);
  assert.deepEqual(first, canonicalJiraRegister(reversed));
  assert.notEqual(first.digest, canonicalJiraRegister({ ...original, version: 2 }).digest);
  assert.equal(original.entries[0].number, 2, 'caller data is not mutated');
  first.scope.entries[0].number = 99;
  assert.equal(original.entries[1].number, 1, 'returned snapshot does not alias caller entries');
});

for (const [name, modify] of [
  ['unknown scope field', value => { value.provenanceVerified = true; }],
  ['unknown entry field', value => { value.entries[0].approved = true; }],
  ['empty set', value => { value.entries = []; }],
  ['duplicate reference', value => { value.entries.push(value.entries[0]); }],
  ['open scope', value => { value.closed = false; }],
  ['unknown kind', value => { value.entries[0].kind = 'merged'; }],
  ['foreign delivery repository', value => { value.entries[0].repository = 'other/repo'; }],
  ['coerced key', value => { value.issueKey = { toString: () => 'CO-296' }; }],
  ['fractional version', value => { value.version = 1.5; }],
  ['sparse entries', value => { delete value.entries[0]; }],
  ['replacement extra field', value => { value.entries[0] = { ...entry(2), kind: 'superseded', reason: 'Explicit decision',
    replacedBy: { repository: entry(1).repository, number: 1, approved: true } }; }],
  ['property over byte budget', value => { value.entries = [entry(1), ...Array.from({ length: 40 }, (_, index) => ({
    repository: 'other/support', number: index + 1, kind: 'supporting', reason: 'ä'.repeat(900) }))]; }],
]) {
  test(`canonical register rejects ${name}`, () => {
    const value = scope(); modify(value);
    assert.throws(() => canonicalJiraRegister(value), /^Error: JIRA_REGISTER_JOURNAL_UNVERIFIED$/);
  });
}

test('explicit scope exceptions retain their reason and replacement in the digest', () => {
  const value = scope();
  value.entries[0] = { ...entry(2), kind: 'superseded', reason: 'Authorized replacement',
    replacedBy: { repository: entry(1).repository, number: 1 } };
  const first = canonicalJiraRegister(value);
  value.entries[0].reason = 'Different decision';
  assert.notEqual(first.digest, canonicalJiraRegister(value).digest);
});

test('invalid binding fails before opening a database connection', async () => {
  const journal = createPostgresJiraRegisterJournal({ connect() { assert.fail('unexpected connection'); } });
  await assert.rejects(journal.read({ cloudId: 'foreign', issueKey: 'CO-296', issueId: '1' }),
    /^Error: JIRA_REGISTER_JOURNAL_UNVERIFIED$/);
});

test('database credentials and driver errors cannot escape the journal', async () => {
  const journal = createPostgresJiraRegisterJournal({ connect() { throw new Error('private provider payload'); } });
  await assert.rejects(journal.read({ cloudId: '11111111-1111-1111-1111-111111111111', issueKey: 'CO-296', issueId: '1' }),
    /^Error: JIRA_REGISTER_JOURNAL_UNVERIFIED$/);
});
