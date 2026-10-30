import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { loadDatabaseConfig } from '../src/config.js';
import { createPostgresPool } from '../src/persistence/postgres/pool.js';
import { createPostgresPlatformAuditRepository } from '../src/persistence/postgres/platform-audit-repository.js';
import { createPostgresPlatformOwnerBootstrapRepository } from '../src/persistence/postgres/platform-owner-bootstrap-repository.js';
import { createPostgresPlatformSessionRepository } from '../src/persistence/postgres/platform-session-repository.js';
import { createPostgresProtectedRuntimeExecutionScopes } from '../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { createPostgresPlatformMicrosoftOperationRepository }
  from '../src/persistence/postgres/platform-microsoft-operation-repository.js';
import { createPlatformSessionService } from '../src/platform/identity/session-service.js';
import { createPlatformMicrosoftOperationService } from '../src/platform/identity/microsoft-operation-service.js';
import { createPlatformEntraOperationClient } from '../src/platform/identity/entra-client.js';
import { createPlatformClaimPolicy } from '../src/platform/identity/claim-policy.js';
import { permissionsForPlatformRoles } from '../src/platform/identity/policy.js';
import { withPostgresTransaction } from '../src/persistence/postgres/transaction.js';
import { microsoftCodeSdkFixture } from '../tests/support/microsoft-code-sdk-fixture.js';
import { migrateUp,rollbackLatest } from '../scripts/db-migrations.mjs';

const NORMAL='cm:ms:mfa:v1',FRESH='cm:ms:fresh:v1',provider='microsoft_entra_platform';
const origin='https://operations.example.test',hash='a'.repeat(64),otherHash='b'.repeat(64);
const cookieValue=value=>value.slice(value.indexOf('=')+1).split(';')[0];
const request=value=>({ headers: { cookie: value.setCookie.split(';')[0] } });

test('native Microsoft exact proof retains callback separation, one-use atomic custody and current-source fences',async t=>{
  const configuration={ mode: 'test',...loadDatabaseConfig(process.env,'test'),databasePoolMax: 1 };
  const pool=createPostgresPool(configuration),leasePool=createPostgresPool(configuration);
  t.after(async()=>{ await leasePool.end();await pool.end(); });await migrateUp(pool);
  assert.equal(await rollbackLatest(pool),true); // Empty service identity075 before unchanged074/older guards.
  assert.equal(await rollbackLatest(pool),true); // Function-only074 before unchanged073/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty073 before unchanged072/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty072 before retained071/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty071 is reversible.
  assert.equal(await rollbackLatest(pool),true);await migrateUp(pool); // Empty070 is reversible.
  const epoch=randomUUID(),directory=randomUUID(),subject=randomUUID(),clientId=randomUUID();
  await pool.query('INSERT INTO protected_runtime_deployments(environment,security_epoch) VALUES($1,$2)',['int',epoch]);
  const audit=createPostgresPlatformAuditRepository(pool,{ hmacSecret: 'q'.repeat(48) });
  const ownerRole=(await pool.query('SELECT current_user AS role')).rows[0].role;
  const boot=await createPostgresPlatformOwnerBootstrapRepository(pool,{ expected: {
    environment: 'int',deploymentEpoch: epoch,directoryId: directory,subjectId: subject,
  },expectedOfflineRole: ownerRole,auditRepository: audit }).initialize({ environment: 'int',deploymentEpoch: epoch,
    directoryId: directory,subjectId: subject,approvalReference: 'NATIVE-MICROSOFT-OPERATION',correlationId: randomUUID() });
  const roles=['platform_security_admin','platform_tenant_operator'];
  const sessionService=createPlatformSessionService({ repository: createPostgresPlatformSessionRepository(pool,{ auditRepository: audit }),
    publicOrigin: origin,csrfSecret: 'c'.repeat(48),securityEpoch: 7 });
  const issue=()=>sessionService.issue({ operatorId: boot.operatorId,securityVersion: 1,roles,
    permissions: permissionsForPlatformRoles(roles),targetScope: { mode: 'all',securityVersion: 1 },
    providerIdentity: { provider,tenantReference: directory,subjectReference: subject },
    assurance: { level: 'mfa',authenticationContext: NORMAL,authenticatedAt: new Date().toISOString() } });
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool,leasePool,environment: 'int',securityEpoch: epoch });
  const authority=`https://login.microsoftonline.com/${directory}`;
  const sdk=microsoftCodeSdkFixture({ clientId,authority,tenantId: directory,userId: subject,clock: ()=>Date.now() });
  sdk.state.amr=['pwd','mfa'];
  const client=createPlatformEntraOperationClient({ clientId,clientSecret: 's'.repeat(48),tenantReference: directory,
    authority,redirectUri: `${origin}/api/v1/platform/auth/microsoft/operation/callback`,publicOrigin: origin,
    mfaAuthenticationContext: NORMAL,stepUpAuthenticationContext: FRESH,application: sdk.application() });
  const policy=createPlatformClaimPolicy({ provider,issuer: `${authority}/v2.0`,audience: clientId,tenantReference: directory,
    mfaAuthenticationContext: NORMAL,stepUpAuthenticationContext: FRESH });
  const repository=(executionScope='shared',auditRepository=audit)=>createPostgresPlatformMicrosoftOperationRepository(pool,
    { environment: 'int',protectedSecurityEpoch: epoch,securityEpoch: 7,executionScope,scopes,auditRepository });
  const service=(executionScope='shared',auditRepository=audit)=>createPlatformMicrosoftOperationService({
    repository: repository(executionScope,auditRepository),entraClient: client,claimPolicy: policy,sessionService,
    environment: 'int',protectedSecurityEpoch: epoch,securityEpoch: 7,transactionSecret: 'x'.repeat(48) });
  const state=async()=>(await pool.query('SELECT status FROM platform_microsoft_operation_proofs ORDER BY created_at DESC')).rows;
  const sessionCount=async()=>Number((await pool.query('SELECT count(*) AS count FROM platform_sessions')).rows[0].count);
  async function prepare(executionScope='shared') {
    const source=await issue(),active=service(executionScope),started=await active.startStepUp(source.principal,{ operationHash: hash });
    const url=new URL(started.authorizationUrl);sdk.state.sentNonce=url.searchParams.get('nonce');
    const cookie=cookieValue(started.setCookies[0]),input={ state: started.state,cookie,operationHash: hash,request: request(source) };
    return { source,active,started,cookie,input };
  }
  const first=await prepare(),before=await sessionCount();
  assert.deepEqual(await first.active.pendingStatus(first.input),{ status: 'pending' });
  const callback=await first.active.complete({ state: first.started.state,cookie: first.cookie,code: 'synthetic-code' });
  assert.equal(callback.status,'operation_verified');assert.equal(callback.principal,undefined);
  assert.equal(callback.csrfToken,undefined);assert.equal(await sessionCount(),before);
  assert.deepEqual(await first.active.pendingStatus(first.input),{ status: 'verified' });
  await assert.rejects(first.active.executeStepUp({ ...first.input,operationHash: otherHash },()=>assert.fail('swapped operation')));
  assert.equal((await state())[0].status,'verified');
  await assert.rejects(first.active.executeStepUp(first.input,async context=>{
    first.active.verifiedOperationPrincipal(context,hash);
    await withPostgresTransaction(pool,client=>client.query(
      "UPDATE platform_operators SET updated_at=clock_timestamp() WHERE id=$1",[boot.operatorId]));
    throw new Error('synthetic-business-failure');
  }),/synthetic-business-failure/);
  assert.equal((await state())[0].status,'verified');assert.equal(await sessionCount(),before);
  assert.ok(await sessionService.resolvePrincipal(request(first.source)));
  let writes=0,escaped;
  const completed=await first.active.executeStepUp(first.input,async context=>{
    escaped=context;const principal=first.active.verifiedOperationPrincipal(context,hash);
    assert.equal(principal.assurance.authenticationContext,FRESH);writes++;
    return { updated: true };
  });
  assert.deepEqual(completed.result,{ updated: true });assert.equal(writes,1);
  assert.equal(completed.principal.assurance.authenticationContext,NORMAL);
  assert.equal(await sessionService.resolvePrincipal(request(first.source)),null);
  await assert.rejects(first.active.executeStepUp(first.input,()=>assert.fail('replay')));
  assert.throws(()=>first.active.verifiedOperationPrincipal(escaped,hash));
  assert.equal((await state())[0].status,'consumed');
  const second=await prepare('synthetic');
  await second.active.complete({ state: second.started.state,cookie: second.cookie,code: 'synthetic-second' });
  await assert.rejects(service().executeStepUp(second.input,()=>assert.fail('execution class swap')));
  const synthetic=await second.active.executeStepUpWithContinuation(second.input,async context=>{
    const { principal,continuationPrincipal }=second.active.verifiedOperationWithContinuation(context,hash);
    assert.equal(principal.operatorId,boot.operatorId);assert.equal(continuationPrincipal.assurance.authenticationContext,NORMAL);
    return { synthetic: true };
  });
  assert.deepEqual(synthetic.result,{ synthetic: true });
  const failed=await prepare();sdk.state.amr=['pwd'];
  await assert.rejects(failed.active.complete({ state: failed.started.state,cookie: failed.cookie,code: 'password-only' }));
  assert.equal((await state())[0].status,'failed');sdk.state.amr=['pwd','mfa'];
  const rollback=await prepare();
  await assert.rejects(service('shared',{ async appendWithClient() { return null; } }).complete({
    state: rollback.started.state,cookie: rollback.cookie,code: 'missing-audit' }));
  assert.equal((await state())[0].status,'pending');
  await sessionService.revoke(rollback.source.principal);
  await assert.rejects(rollback.active.complete({ state: rollback.started.state,cookie: rollback.cookie,code: 'logged-out' }));
  const last=await prepare();
  await assert.rejects(prepare()); // Five live rows include consumed/failed attempts; the bound cannot be bypassed.
  assert.ok((await audit.listVerified({ scope: { mode: 'all',operatorId: boot.operatorId,securityVersion: 1 } }))
    .some(event=>event.targetType==='platform_microsoft_operation' && event.outcome==='success'));
  await pool.query("UPDATE platform_operators SET status='disabled' WHERE id=$1",[boot.operatorId]);
  await assert.rejects(last.active.complete({ state: last.started.state,cookie: last.cookie,code: 'disabled-owner' }));
  for (const sql of ["UPDATE platform_microsoft_operation_proofs SET operation_hash=repeat('f',64)",
    'DELETE FROM platform_microsoft_operation_proofs','TRUNCATE platform_microsoft_operation_proofs']) {
    await assert.rejects(pool.query(sql));
  }
  // Name the new dependent table so the retained-proof guard itself also runs.
  await assert.rejects(pool.query(`TRUNCATE owner_customer_handoffs,platform_owner_customer_users,
    synthetic_customer_handoffs,platform_microsoft_operation_proofs`),{ code: '55000' });
  assert.equal(await rollbackLatest(pool),true); // Empty service identity075 before unchanged074/older guards.
  assert.equal(await rollbackLatest(pool),true); // Function-only074 before unchanged073/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty073 before unchanged072/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty072 before retained071/older rollback assertions.
  assert.equal(await rollbackLatest(pool),true); // Empty071 before retained070 proof history.
  await assert.rejects(rollbackLatest(pool),{ code: '55000' });
  assert.deepEqual(await audit.listVerified({ scope: { mode: 'all',operatorId: boot.operatorId,securityVersion: 1 } }),[]);
  assert.equal(await audit.isReady(),true); // Actual legacy adapter verifies every retained row and terminal hash.
});
