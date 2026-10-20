import assert from 'node:assert/strict';
import test from 'node:test';
import { pruneCustomerAnonymousEmailState } from '../src/persistence/postgres/customer-email-anonymous-retention.js';
import { architectureConsolidationBoundaryViolations,moduleBoundaryViolations } from '../scripts/check-module-boundaries.mjs';

test('anonymous retention has a fixed scope and bounded counts, joins one transaction and releases its lock',async () => {
  const queries=[];let connections=0;
  const pool={ async connect() { connections++;return { async query(value) {
    queries.push(value);
    return value?.name==='customer-email-retention-try-lock' ? { rows: [{ acquired: true }] }
      : { rows: [],rowCount: value?.name==='customer-email-retention-anonymous' ? 20 : 4 };
  },release() {} }; } };
  assert.deepEqual(await pruneCustomerAnonymousEmailState(pool,{ environment: 'int' }),{ anonymousChallenges: 20,staleBudgets: 4 });
  assert.equal(connections,1);assert.equal(queries.at(-1),'COMMIT');
  const commands=queries.filter(value=>typeof value==='object');assert.equal(commands.length,3);
  assert.ok(commands.every(value=>JSON.stringify(value.values)==='["int"]'));
  for (const value of commands.slice(1)) { assert.match(value.text,/LIMIT 20 FOR UPDATE SKIP LOCKED/); }
  assert.match(commands[1].text,/mailbox_id IS NULL/);assert.match(commands[1].text,/interval '1 hour'/);
  assert.match(commands[2].text,/last_issued_at/);assert.match(commands[2].text,/interval '24 hours'/);
  await assert.rejects(pruneCustomerAnonymousEmailState(pool,{ environment: 'demo' }),/CONFIGURATION_INVALID/);
  assert.equal(connections,1);
});

test('an overlapping sweep is a neutral no-op and malformed counts roll back instead of accepting deletion evidence',async () => {
  for (const acquired of [false,true]) {
    const statements=[];
    const pool={ async connect() { return { async query(value) {
      statements.push(typeof value==='string' ? value : value.name);
      return value?.name==='customer-email-retention-try-lock' ? { rows: [{ acquired }] } : { rowCount: 21,rows: [] };
    },release() {} }; } };
    if (acquired) { await assert.rejects(pruneCustomerAnonymousEmailState(pool,{ environment: 'prod' }),/RESULT_INVALID/);
      assert.ok(statements.includes('ROLLBACK')); }
    else {
      assert.deepEqual(await pruneCustomerAnonymousEmailState(pool,{ environment: 'prod' }),{ anonymousChallenges: 0,staleBudgets: 0 });
      assert.equal(statements.includes('customer-email-retention-anonymous'),false);
    }
  }
});

test('neither closed Demo can reach anonymous proof or budget deletion authority',() => {
  for (const surface of ['customer','platform']) for (const bridge of [false,true]) {
    const target='src/persistence/postgres/customer-email-anonymous-retention.js';
    const sources={ [`src/demo/${surface}-main.js`]: bridge ? "import '../retention-bridge.js';"
      : "import '../persistence/postgres/customer-email-anonymous-retention.js';",[target]: 'export const retention = true;',
    ...(bridge ? { 'src/retention-bridge.js': "import './persistence/postgres/customer-email-anonymous-retention.js';" } : {}) };
    const violations=[...architectureConsolidationBoundaryViolations(sources),...moduleBoundaryViolations(sources)];
    assert.ok(violations.some(value=>value.includes('Production identity/provider implementation')));
  }
});
