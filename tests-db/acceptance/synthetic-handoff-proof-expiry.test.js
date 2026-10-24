import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { loadDatabaseConfig } from '../../src/config.js';
import { createPostgresPool } from '../../src/persistence/postgres/pool.js';
import { createPostgresAuditRepository } from '../../src/persistence/postgres/audit-repository.js';
import { createPostgresSyntheticGenerationRepository } from '../../src/persistence/postgres/platform-synthetic-generation-repository.js';
import { createPostgresSyntheticHandoffRepository } from '../../src/persistence/postgres/platform-synthetic-handoff-repository.js';
import { createProtectedSyntheticCustomerAccess } from '../../src/protected-synthetic-customer-access-composition.js';
import { createSyntheticHandoffBrowserBinding } from '../../src/identity/synthetic-handoff-browser-binding.js';
import { createSyntheticGenerationService } from '../../src/platform/application/synthetic-generation-service.js';
import { createSyntheticHandoffService } from '../../src/platform/application/synthetic-handoff-service.js';
import { createPlatformAuthorizationPolicy } from '../../src/platform/identity/policy.js';
import { migrateUp } from '../../scripts/db-migrations.mjs';
import { createProtectedSyntheticOperatorFixture } from '../support/protected-synthetic-operator-fixture.js';
import { createProtectedSyntheticMicrosoftFixture } from '../support/protected-synthetic-microsoft-fixture.js';

// This purpose-specific acceptance is invoked explicitly after the unchanged
// ordinary120s-per-file integration suite. It observes actual database time;
// no clock, expiry, retained proof row or production cap is altered.
test('actual elapsed proof/code expiry preserves consumed session and retained proof while denying an unused code',
{ timeout: 175_000 },async t=>{
  const database=loadDatabaseConfig(process.env,'test');
  if (!database.databaseUrl) throw new Error('DATABASE_URL_REQUIRED_FOR_INTEGRATION_TEST');
  const pool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  const leasePool=createPostgresPool({ mode: 'test',...database,databasePoolMax: 1 });
  t.after(async()=>{ await Promise.all([pool.end(),leasePool.end()]); });await migrateUp(pool);
  const epoch=randomUUID(),scope={ environment: 'int',securityEpoch: epoch,platformSecurityEpoch: 7,
    customerOrigin: 'https://127.0.0.1',platformOrigin: 'https://ops-int.example.com' };
  await pool.query("INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES('int',$1)",[epoch]);
  const auditRepository=createPostgresAuditRepository(pool,{ hmacSecret: 'a'.repeat(48) });
  const customer=createProtectedSyntheticCustomerAccess({ pool,leasePool,scope,browserSecret: 'h'.repeat(48),sourceSecret: 'b'.repeat(48),
    auditHmacSecret: 'a'.repeat(48),csrfSecret: 's'.repeat(48) });
  async function approved(address,assuranceMode) {
    const fixture=assuranceMode==='microsoft_mfa' ? createProtectedSyntheticMicrosoftFixture : createProtectedSyntheticOperatorFixture;
    const owner=await fixture(pool,leasePool,{ epoch });
    const generations=createSyntheticGenerationService({ environment: 'int',securityEpoch: epoch,passkeyService: owner.auth,assuranceMode,
      authorizationPolicy: createPlatformAuthorizationPolicy(),repository: createPostgresSyntheticGenerationRepository(pool,
        { environment: 'int',securityEpoch: epoch,assuranceMode,tenantAuditRepository: auditRepository,
          platformAuditRepository: owner.auditRepository }) });
    const intent={ operatorId: owner.operatorId,expectedGenerationId: null,expectedRevision: 0 };
    const generation=await owner.execute(generations.operationHash(intent),proofContext=>generations.replace({
      proofContext,intent,correlationId: randomUUID() }));
    const browserBinding=createSyntheticHandoffBrowserBinding({ scope,secret: 'h'.repeat(48) });t.after(()=>browserBinding.destroy());
    const handoff=createSyntheticHandoffService({ scope,browserBinding,passkeyService: owner.auth,assuranceMode,
      authorizationPolicy: createPlatformAuthorizationPolicy(),repository: createPostgresSyntheticHandoffRepository(pool,
        { scope,browserBinding,assuranceMode,platformAuditRepository: owner.auditRepository }) });
    const start=await customer.start(address),selection={ flowId: start.flowId,state: start.state,operatorId: owner.operatorId,
      generationId: generation.generationId,slot: 'northwind',role: 'employee' };
    const hash=await owner.scopes.withShared(()=>handoff.operationHash({ principal: owner.current().principal,intent: selection }));
    const result=await owner.executeWithContinuation(hash,proofContext=>handoff.approve({
      proofContext,intent: selection,correlationId: randomUUID() }));
    const location=new URL(result.location);
    const callback={ flowId: start.flowId,browserToken: start.browserToken,state: start.state,code: location.searchParams.get('code') };
    return { owner,start,callback,handoff,generation };
  }
  const cases=[];
  for (const [index,assuranceMode] of ['application_passkey','microsoft_mfa'].entries()) {
    const consumed=await approved(`127.0.0.${index*2+1}`,assuranceMode),unused=await approved(`127.0.0.${index*2+2}`,assuranceMode);
    const confirmation=await customer.callback(consumed.callback);
    const view=await customer.confirmation({ ...consumed.callback,completion: confirmation.completion });
    const issued=await customer.complete({ ...consumed.callback,completion: confirmation.completion,csrfToken: view.csrfToken,
      request: { headers: {} },correlationId: randomUUID() });
    const request={ headers: { cookie: issued.setCookie.split(';')[0] } };
    assert.ok(await customer.sessionService.resolvePrincipal(request));
    // These table/column names come only from the fixed test profile, never input.
    const table=assuranceMode==='microsoft_mfa' ? 'platform_microsoft_operation_proofs' : 'platform_passkey_auth_transactions';
    const column=assuranceMode==='microsoft_mfa' ? 'approval_microsoft_proof_id' : 'approval_proof_id';
    const custody=async flowId=>(await pool.query(`SELECT handoff.status,handoff.customer_session_id,handoff.${column} AS proof_id,
        handoff.expires_at AS start_expires_at,handoff.code_expires_at,proof.expires_at AS proof_expires_at,
        source.expires_at AS source_expires_at,clock_timestamp() AS now
      FROM synthetic_customer_handoffs handoff JOIN ${table} proof ON proof.id=handoff.${column}
      JOIN platform_sessions source ON source.id=handoff.source_platform_session_id WHERE handoff.id=$1`,[flowId])).rows[0];
    const before=await custody(consumed.start.flowId),other=await custody(unused.start.flowId);
    const unreferenced=(await pool.query(`SELECT id FROM ${table} WHERE operator_id=$1 AND id<>$2`,
      [consumed.owner.operatorId,before.proof_id])).rows;
    assert.equal(unreferenced.length,1);assert.equal(other.status,'approved');assert.equal(other.customer_session_id,null);
    cases.push({ assuranceMode,consumed,unused,request,table,custody,before,other,unreferenced });
  }
  const expiresAt=Math.max(...cases.flatMap(value=>[value.before.proof_expires_at.getTime(),value.other.proof_expires_at.getTime()]))+1000;
  const deadline=performance.now()+150_000;
  for (;;) {
    const now=(await pool.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
    if (now>=expiresAt) break;
    assert.ok(performance.now()<deadline,'bounded actual proof-expiry observation');
    await delay(Math.min(30_000,expiresAt-now));
  }
  for (const { assuranceMode,consumed,unused,request,table,custody,before,unreferenced } of cases) {
    for (const row of [await custody(consumed.start.flowId),await custody(unused.start.flowId)]) {
      assert.ok(row.now>row.proof_expires_at);assert.ok(row.now>row.code_expires_at);
      assert.ok(row.now<row.start_expires_at);assert.ok(row.now<row.source_expires_at);
    }
    assert.ok(await customer.sessionService.resolvePrincipal(request));
    await assert.rejects(customer.callback(unused.callback),/SYNTHETIC_HANDOFF_DENIED/);
    const next=await customer.start('127.0.0.5'),intent={ flowId: next.flowId,state: next.state,
      operatorId: consumed.owner.operatorId,generationId: consumed.generation.generationId,slot: 'northwind',role: 'employee' };
    await consumed.owner.scopes.withShared(async()=>{
      const operationHash=await consumed.handoff.operationHash({ principal: consumed.owner.current().principal,intent });
      assert.equal((await consumed.owner.auth.startStepUp(consumed.owner.current().principal,{ operationHash })).status,
        assuranceMode==='microsoft_mfa' ? 'microsoft_required' : 'passkey_required');
    });
    assert.equal((await pool.query(`SELECT id FROM ${table} WHERE id=$1`,[before.proof_id])).rowCount,1);
    // Legacy removes expired unreferenced ceremonies;070 retains consumed proof
    // evidence for24h. Both retain any handoff-referenced proof through cleanup.
    assert.equal((await pool.query(`SELECT id FROM ${table} WHERE id=$1`,[unreferenced[0].id])).rowCount,
      assuranceMode==='microsoft_mfa' ? 1 : 0);
    assert.ok(await customer.sessionService.resolvePrincipal(request));
    assert.equal((await custody(unused.start.flowId)).customer_session_id,null);
    await consumed.owner.sessions.revoke(consumed.owner.current().principal,{ correlationId: randomUUID() });
    assert.equal(await customer.sessionService.resolvePrincipal(request),null);
  }
});
