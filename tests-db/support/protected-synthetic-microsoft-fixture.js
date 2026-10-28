import { randomUUID } from 'node:crypto';
import { permissionsForPlatformRoles } from '../../src/platform/identity/policy.js';
import { createProtectedPlatformSessions } from '../../src/platform/identity/protected-platform-sessions.js';
import { createPlatformMicrosoftOperationService } from '../../src/platform/identity/microsoft-operation-service.js';
import { createPlatformEntraOperationClient } from '../../src/platform/identity/entra-client.js';
import { createPlatformClaimPolicy } from '../../src/platform/identity/claim-policy.js';
import { createPostgresPlatformSessionRepository } from '../../src/persistence/postgres/platform-session-repository.js';
import { createPostgresPlatformMicrosoftOperationRepository }
  from '../../src/persistence/postgres/platform-microsoft-operation-repository.js';
import { createPostgresPlatformAuditRepository } from '../../src/persistence/postgres/platform-audit-repository.js';
import { createPostgresProtectedRuntimeExecutionScopes } from '../../src/persistence/postgres/protected-runtime-execution-scopes.js';
import { microsoftCodeSdkFixture } from '../../tests/support/microsoft-code-sdk-fixture.js';

// Isolated MSAL fixture only, not real Microsoft/device acceptance. The actual
// claim policy, one-use proof, sessions, audit and scoped PostgreSQL custody
// run with zero application credentials and no verifier/minimum exemptions.
export async function createProtectedSyntheticMicrosoftFixture(pool,leasePool,
  { epoch,scopeMode='allowlist',executionScope='synthetic',runtimePool=pool,runtimeLeasePool=leasePool }={}) {
  if (!['all','allowlist'].includes(scopeMode) || !['shared','synthetic'].includes(executionScope)) {
    throw new TypeError('SYNTHETIC_OPERATOR_FIXTURE_SCOPE_INVALID');
  }
  const operatorId=randomUUID(),directory=randomUUID(),subject=randomUUID(),clientId=randomUUID();
  const roles=['platform_tenant_operator'],origin='https://ops-int.example.com';
  await pool.query(`INSERT INTO platform_operators(id,provider,provider_tenant_reference,provider_subject_reference,scope_mode,roles)
    VALUES($1,'microsoft_entra_platform',$2,$3,$4,$5)`,[operatorId,directory,subject,scopeMode,roles]);
  const auditRepository=createPostgresPlatformAuditRepository(runtimePool,{ hmacSecret: 'a'.repeat(48) });
  const sessions=createProtectedPlatformSessions({ repository: createPostgresPlatformSessionRepository(runtimePool,{ auditRepository }),
    environment: 'int',protectedSecurityEpoch: epoch,publicOrigin: origin,csrfSecret: 'c'.repeat(48),securityEpoch: 7 });
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool: runtimePool,leasePool: runtimeLeasePool,
    environment: 'int',securityEpoch: epoch });
  const authority=`https://login.microsoftonline.com/${directory}`;
  const sdk=microsoftCodeSdkFixture({ clientId,authority,tenantId: directory,userId: subject,clock: ()=>Date.now() });
  sdk.state.amr=['pwd','mfa'];
  const auth=createPlatformMicrosoftOperationService({ environment: 'int',protectedSecurityEpoch: epoch,securityEpoch: 7,
    transactionSecret: 'p'.repeat(48),sessionService: sessions,
    entraClient: createPlatformEntraOperationClient({ clientId,clientSecret: 's'.repeat(48),tenantReference: directory,authority,
      publicOrigin: origin,redirectUri: origin+'/api/v1/platform/auth/microsoft/operation/callback',
      mfaAuthenticationContext: 'cm:ms:mfa:v1',stepUpAuthenticationContext: 'cm:ms:fresh:v1',application: sdk.application() }),
    claimPolicy: createPlatformClaimPolicy({ provider: 'microsoft_entra_platform',issuer: authority+'/v2.0',audience: clientId,
      tenantReference: directory,mfaAuthenticationContext: 'cm:ms:mfa:v1',stepUpAuthenticationContext: 'cm:ms:fresh:v1' }),
    repository: createPostgresPlatformMicrosoftOperationRepository(runtimePool,{ environment: 'int',protectedSecurityEpoch: epoch,
      securityEpoch: 7,executionScope,scopes,auditRepository }) });
  let current;
  async function freshSession() {
    const securityVersion=Number((await runtimePool.query('SELECT security_version FROM platform_operators WHERE id=$1',[operatorId]))
      .rows[0].security_version);
    current=await sessions.issue({ operatorId,roles,permissions: permissionsForPlatformRoles(roles),securityVersion,
      targetScope: { mode: scopeMode,securityVersion },providerIdentity: { provider: 'microsoft_entra_platform',
        tenantReference: directory,subjectReference: subject },assurance: { level: 'mfa',authenticationContext: 'cm:ms:mfa:v1',
        authenticatedAt: new Date().toISOString() } });
  }
  await freshSession();
  async function execute(operationHash,mutation,continuation) {
    const started=await auth.startStepUp(current.principal,{ operationHash });
    sdk.state.sentNonce=new URL(started.authorizationUrl).searchParams.get('nonce');
    const cookie=started.setCookies[0].split(';')[0].slice('cm_platform_ms_operation_tx='.length);
    await auth.complete({ state: started.state,cookie,code: 'synthetic-microsoft-operation' });
    const result=await auth[continuation ? 'executeStepUpWithContinuation' : 'executeStepUp']({ operationHash,
      state: started.state,cookie,request: { headers: { cookie: current.setCookie.split(';')[0] } } },mutation);
    current={ principal: result.principal,setCookie: result.setCookies[0],csrfToken: result.csrfToken };return result.result;
  }
  return { operatorId,auth,sessions,scopes,auditRepository,freshSession,current: ()=>current,
    execute: (hash,mutation)=>execute(hash,mutation,false),
    executeWithContinuation: (hash,mutation)=>execute(hash,mutation,true) };
}
