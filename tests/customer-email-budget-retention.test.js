import assert from 'node:assert/strict';
import test from 'node:test';
import { withCustomerEmailBudget } from '../src/persistence/postgres/customer-email-budget.js';

test('invalid anonymous budget input allocates nothing and retention failure cannot allocate new windows or challenges',async () => {
  const queries=[];let connections=0,work=0;
  const pool={ async connect() { connections++;return { async query(value) {
    const name=typeof value==='string' ? value : value.name;queries.push(name);
    if (name==='customer-email-retention-try-lock') throw new Error('SYNTHETIC_RETENTION_FAILED');
    return { rows: [],rowCount: 0 };
  },release() {} }; } };
  const config={ environment: 'int',sourceKey: 'a'.repeat(64),recipientKey: 'b'.repeat(64),operation: 'issue' };
  await assert.rejects(withCustomerEmailBudget(pool,{ ...config,environment: 'demo' },()=>{ work++; }),/BUDGET_INVALID/);
  assert.equal(connections,0);
  await assert.rejects(withCustomerEmailBudget(pool,config,()=>{ work++; }),/SYNTHETIC_RETENTION_FAILED/);
  assert.equal(connections,1);assert.equal(work,0);assert.ok(queries.includes('ROLLBACK'));
  assert.equal(queries.some(value=>value.includes('budget-insert') || value.includes('challenge')),false);
});
