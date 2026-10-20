import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { migrateUp } from '../scripts/db-migrations.mjs';
import { createCustomerAccessCipher } from '../src/persistence/customer-access-cipher.js';
import { pruneCustomerAnonymousEmailState } from '../src/persistence/postgres/customer-email-anonymous-retention.js';

test('PostgreSQL retention deletes bounded expired anonymous state without weakening live abuse or real custody',async t => {
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database });t.after(()=>pool.end());await migrateUp(pool);
  const cipher=createCustomerAccessCipher({ environment: 'int',activeKeyId: 'initial',
    keys: new Map([['initial',Buffer.alloc(32,3)]]),lookupSecret: 'l'.repeat(48) });t.after(()=>cipher.destroy());
  const mailboxId=randomUUID(),plaintext=Buffer.from('Retained@example.com');
  const envelope=cipher.seal(plaintext,{ environment: 'int',mailboxId,recordId: mailboxId,purpose: 'mailbox_recipient',tenantId: null });
  plaintext.fill(0);
  await pool.query(`INSERT INTO customer_access_mailboxes(environment,id,lookup_hash,recipient_envelope)
    VALUES('int',$1,$2,$3::jsonb)`,[mailboxId,cipher.recipientLookup('Retained@example.com'),JSON.stringify(envelope)]);
  async function challenge({ environment='int',age=120,known=false } = {}) {
    const id=randomUUID(),snapshot=known ? [{ membershipId: randomUUID(),tenantId: randomUUID(),userId: null,
      userSecurityVersion: null,invitationId: randomUUID(),invitationRevision: 1 }] : [];
    await pool.query(`INSERT INTO customer_email_challenges(environment,id,mailbox_id,recipient_lookup_hash,
      flow_browser_verifier,code_verifier,browser_verifier,admission_snapshot,created_at,expires_at)
      SELECT $1,$2,$3,$4,$4,$4,$4,$5::jsonb,now,now+interval '10 minutes'
      FROM (SELECT clock_timestamp()-($6::integer*interval '1 minute') AS now) initial`,
    [environment,id,known ? mailboxId : null,'a'.repeat(64),JSON.stringify(snapshot),age]);return id;
  }
  async function budget(n,{ environment='int',age=26,recent=false } = {}) {
    const key=n.toString(16).padStart(64,'0');
    await pool.query(`INSERT INTO customer_access_abuse_budgets(environment,kind,key_hash,window_started_at,
      issue_count,failure_count,last_issued_at) SELECT $1,'recipient',$2,now,3,10,
      CASE WHEN $4::boolean THEN clock_timestamp() ELSE now END
      FROM (SELECT clock_timestamp()-($3::integer*interval '1 hour') AS now) initial`,[environment,key,age,recent]);return key;
  }
  for (let index=0;index<25;index++) { await challenge();await budget(index+1); }
  const active=await challenge({ age: 0 }),notYetRetained=await challenge({ age: 30 });
  const known=await challenge({ known: true }),foreign=await challenge({ environment: 'prod' });
  const liveBudget=await budget(100,{ age: 0 }),recentBudget=await budget(101,{ recent: true });
  await budget(102,{ environment: 'prod' });
  for (const id of [active,notYetRetained,known]) await assert.rejects(
    pool.query('DELETE FROM customer_email_challenges WHERE environment=$1 AND id=$2',['int',id]),
    error=>error.code==='55000');
  for (const key of [liveBudget,recentBudget]) await assert.rejects(
    pool.query('DELETE FROM customer_access_abuse_budgets WHERE environment=$1 AND key_hash=$2',['int',key]),
    error=>error.code==='55000');
  const first=await pruneCustomerAnonymousEmailState(pool,{ environment: 'int' });
  assert.deepEqual(first,{ anonymousChallenges: 20,staleBudgets: 20 });
  const next=await Promise.all([pruneCustomerAnonymousEmailState(pool,{ environment: 'int' }),
    pruneCustomerAnonymousEmailState(pool,{ environment: 'int' })]);
  assert.equal(next.reduce((sum,result)=>sum+result.anonymousChallenges,0),5);
  assert.equal(next.reduce((sum,result)=>sum+result.staleBudgets,0),5);
  assert.deepEqual(await pruneCustomerAnonymousEmailState(pool,{ environment: 'int' }),{ anonymousChallenges: 0,staleBudgets: 0 });
  const remaining=await pool.query('SELECT id FROM customer_email_challenges ORDER BY id');
  assert.deepEqual(remaining.rows.map(row=>row.id).sort(),[active,notYetRetained,known,foreign].sort());
  const counters=await pool.query(`SELECT issue_count,failure_count FROM customer_access_abuse_budgets WHERE environment='int'`);
  assert.equal(counters.rowCount,2);assert.ok(counters.rows.every(row=>row.issue_count===3 && row.failure_count===10));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM customer_access_mailboxes')).rows[0].n,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n,0);
});
