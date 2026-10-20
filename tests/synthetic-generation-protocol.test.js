import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createSyntheticGenerationProtocol } from '../src/platform/application/synthetic-generation-protocol.js';
import { permissionsForPlatformRoles } from '../src/platform/identity/policy.js';

const operatorId=randomUUID(),roles=['platform_tenant_operator'],now=new Date().toISOString();
const principal={ operatorId,roles,permissions: permissionsForPlatformRoles(roles),securityVersion: 3,
  providerIdentity: { provider: 'microsoft_entra_platform',tenantReference: 'directory',subjectReference: 'subject' },
  targetScope: { mode: 'allowlist',securityVersion: 3 },assurance: { level: 'mfa',authenticationContext: 'cm:pk:v1',authenticatedAt: now },
  session: { id: randomUUID(),issuedAt: now,expiresAt: new Date(Date.now()+3_600_000).toISOString(),
    securityVersion: 3,securityEpoch: 7,stepUpExpiresAt: null } };
const intent={ operatorId,expectedGenerationId: null,expectedRevision: 0 },correlationId=randomUUID();

test('generation preparation is current and scoped; mutation starts outside shared and withholds result through full commit',async()=>{
  const calls=[];let shared=false,release,entered,settled=false;
  const pending=new Promise(resolve=>{ release=resolve; }),seen=new Promise(resolve=>{ entered=resolve; }),context=Object.freeze({});
  const protocol=createSyntheticGenerationProtocol({
    withPreparationScope: async work=>{ assert.equal(shared,false);shared=true;calls.push('shared');
      try { return await work(); } finally { shared=false;calls.push('released'); } },
    directory: { async current(value) { assert.equal(shared,true);assert.equal(value.operatorId,operatorId);calls.push('current');
      return { generation: null,retainedGenerations: 0,canReplace: true,replaceAfter: null }; } },
    generationService: { operationHash(value) { assert.deepEqual(value,intent);return 'a'.repeat(64); },
      async replace(input) { assert.equal(input.proofContext,context);assert.deepEqual(input.intent,intent);
        assert.equal(input.correlationId,correlationId);return { generationId: 'private-uncommitted' }; } },
    passkeyService: { async startStepUp(actor,request) { assert.equal(shared,true);assert.equal(actor.operatorId,operatorId);
      assert.equal(request.operationHash,'a'.repeat(64));calls.push('challenge');return { status: 'passkey_required' }; },
      async executeStepUp(input,mutation) { assert.equal(shared,false);assert.equal(input.operationHash,'a'.repeat(64));
        calls.push('exclusive');const result=await mutation(context);entered();await pending;calls.push('commit');return result; } },
  });
  await protocol.current({ principal });await protocol.options({ principal,intent,correlationId });
  assert.deepEqual(calls,['shared','current','released','shared','current','challenge','released']);
  const completion=protocol.replace({ principal,intent,correlationId,request: { headers: {} } })
    .then(result=>{ settled=true;return result; });
  await seen;assert.equal(settled,false);release();assert.deepEqual(await completion,{ generationId: 'private-uncommitted' });
  assert.deepEqual(calls.slice(-2),['exclusive','commit']);
});

test('stale, cooldown, retained-capacity and foreign-owner intents cannot mint a challenge; missing scopes cannot fall back',async()=>{
  let challenges=0;const view={ generation: null,retainedGenerations: 0,canReplace: true,replaceAfter: null };
  const dependencies={ withPreparationScope: work=>work(),directory: { async current() { return view; } },
    generationService: { operationHash: ()=>assert.fail('NO_HASH'),replace: ()=>assert.fail('NO_MUTATION') },
    passkeyService: { async startStepUp() { challenges++; },async executeStepUp() { assert.fail('NO_PROOF'); } } };
  const protocol=createSyntheticGenerationProtocol(dependencies);
  await assert.rejects(protocol.options({ principal,
    intent: { ...intent,expectedGenerationId: randomUUID(),expectedRevision: 2 },correlationId }),
    /SYNTHETIC_GENERATION_STALE/);
  view.canReplace=false;view.replaceAfter=new Date(Date.now()+10_000).toISOString();
  await assert.rejects(protocol.options({ principal,intent,correlationId }),/SYNTHETIC_GENERATION_COOLDOWN/);
  view.retainedGenerations=32;view.replaceAfter=null;
  await assert.rejects(protocol.options({ principal,intent,correlationId }),/SYNTHETIC_GENERATION_RETENTION_LIMIT/);
  assert.throws(()=>protocol.options({ principal,intent: { ...intent,operatorId: randomUUID() },correlationId }),/INPUT_INVALID/);
  assert.throws(()=>createSyntheticGenerationProtocol({ ...dependencies,withPreparationScope: undefined }),/CONFIGURATION_INVALID/);
  assert.equal(challenges,0);
});
