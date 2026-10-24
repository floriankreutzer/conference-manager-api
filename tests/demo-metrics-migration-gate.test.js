import assert from 'node:assert/strict';
import test from 'node:test';
import { withDemoMetricsMigrationGate } from '../src/persistence/postgres/demo-metrics-migration-gate.js';
import { DEMO_DATABASE_SENTINEL_KEY } from '../src/demo/runtime-contract.js';

const expected={ database: 'conference_manager_demo_synthetic',customer: 'cm_customer',platform: 'cm_platform',
  reset: 'cm_reset',migration: 'cm_migration' };
const sequence=length=>Array.from({ length },(_,index)=>index+1);
function fixture(canonical=59,overlay=25) {
  const row={ sentinel_key: DEMO_DATABASE_SENTINEL_KEY,runtime_schema_version: 1,database_name: expected.database,
    actual_database: expected.database,actual_role: expected.migration,canonical_owner: expected.migration,demo_owner: expected.migration,
    customer_role: expected.customer,platform_role: expected.platform,reset_role: expected.reset,
    canonical_versions: sequence(canonical),demo_versions: sequence(overlay),tenants: '3',requests: '23',
    tenant_audit: '15',request_revisions: '23',platform_audit: '9' };
  const queries=[];let released=false,upgrades=0;
  const pool={ async connect() { return { async query(value) {
    queries.push(value);return { rowCount: 1,rows: typeof value==='object' ? [{ ...row }] : [] };
  },release() { released=true; } }; } };
  return { pool,row,queries,released: ()=>released,upgrades: ()=>upgrades,
    async upgrade() { upgrades++;row.canonical_versions=sequence(71);row.demo_versions=sequence(31); } };
}

test('reviewed Demo upgrade accepts retained historical ledgers and current70/31 without resetting retained data',async()=>{
  for (const [canonical,overlay] of [[44,9],[58,24],[59,25],[60,26],[61,26],[61,27],[62,27],
    [63,28],[64,28],[65,28],[66,28],[66,29],[67,29],[68,29],[69,29],[69,30],[70,29],[70,30],[70,31],[71,31]]) {
    const f=fixture(canonical,overlay);
    assert.deepEqual(await withDemoMetricsMigrationGate(f.pool,expected,f.upgrade),
      { canonicalVersion: 71,demoVersion: 31,resetPerformed: false,retainedCountsMatch: true });
    assert.equal(f.upgrades(),1);assert.equal(f.released(),true);
    assert.ok(f.queries.some(query=>typeof query==='string' && query.startsWith('SELECT pg_advisory_unlock')));
  }
});

test('future, incomplete and incompatible older schema/overlay ledgers fail before upgrade, preserving the exclusive gate',async()=>{
  for (const [canonical,overlay] of [[59,26],[58,25],[57,24],[56,23],[55,22],[54,21],[53,20],
    [60,27],[72,31],[70,32],[69,31],[68,30],[66,30],[65,29],[61,28],[62,28],[63,29]]) {
    const f=fixture(canonical,overlay);
    await assert.rejects(withDemoMetricsMigrationGate(f.pool,expected,f.upgrade),/PRECONDITIONS_FAILED/);
    assert.equal(f.upgrades(),0);assert.equal(f.released(),true);
  }
  const hole=fixture(60,26);hole.row.canonical_versions.splice(58,1);
  await assert.rejects(withDemoMetricsMigrationGate(hole.pool,expected,hole.upgrade),/PRECONDITIONS_FAILED/);
  assert.equal(hole.upgrades(),0);
});

test('upgrade readback rejects stale versions or changed retained counts and releases its lease without a reset fallback',async()=>{
  for (const mutate of [row=>{ row.canonical_versions=sequence(59);row.demo_versions=sequence(25); },
    row=>{ row.demo_versions=sequence(25); },
    row=>{ row.requests='22'; }]) {
    const f=fixture();let calls=0;
    await assert.rejects(withDemoMetricsMigrationGate(f.pool,expected,async()=>{
      calls++;await f.upgrade();mutate(f.row);
    }),/READBACK_FAILED/);
    assert.equal(calls,1);assert.equal(f.released(),true);
  }
});
