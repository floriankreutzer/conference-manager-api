import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProtectedTenantRuntimeError,requireProtectedTenantMode,requireProtectedTenantRuntime,
} from '../src/tenancy/protected-tenant-runtime.js';

const TENANT='c1000000-0000-4000-8000-000000000001',EPOCH='c1000000-0000-4000-8000-000000000002';
const GENERATION='c1000000-0000-4000-8000-000000000003',OPERATOR='c1000000-0000-4000-8000-000000000004';
const context={ environment: 'int',tenantId: TENANT,securityEpoch: EPOCH };
const real={ ...context,securityEpoch: EPOCH,mode: 'real',generationId: null,generationState: null,operatorId: null,slot: null };
const synthetic={ ...real,mode: 'synthetic',generationId: GENERATION,generationState: 'active',operatorId: OPERATOR,slot: 'northwind' };

test('protected runtime accepts only exact registry scope and keeps real/synthetic provider modes disjoint',()=>{
  for (const mode of ['real','synthetic']) {
    const value=mode==='real' ? real : synthetic,result=requireProtectedTenantMode(context,value,mode);
    assert.equal(result.mode,mode);assert.equal(Object.isFrozen(result),true);assert.notEqual(result,value);
    assert.throws(()=>requireProtectedTenantMode(context,value,mode==='real' ? 'synthetic' : 'real'),ProtectedTenantRuntimeError);
  }
  for (const slot of ['northwind','contoso','fabrikam']) {
    assert.equal(requireProtectedTenantRuntime(context,{ ...synthetic,slot }).slot,slot);
  }
});

test('unclassified, foreign, ambiguous, malformed and archived contexts fail closed without provider fallback',()=>{
  for (const value of [null,undefined,{},[],{ ...real,mode: 'demo' },{ ...real,mode: null },{ ...real,environment: 'dev' },
    { ...real,tenantId: OPERATOR },{ ...real,securityEpoch: 'legacy' },{ ...real,securityEpoch: OPERATOR },
    { ...real,roles: ['tenant_admin'] },
    { ...real,generationId: GENERATION },{ ...real,slot: 'northwind' },{ ...real,operatorId: OPERATOR },
    { ...synthetic,generationState: 'archived' },{ ...synthetic,generationState: 'pending' },{ ...synthetic,generationId: null },
    { ...synthetic,operatorId: null },{ ...synthetic,slot: 'customer-supplied' }]) {
    assert.throws(()=>requireProtectedTenantRuntime(context,value),ProtectedTenantRuntimeError);
  }
  for (const expected of [null,undefined,'demo','REAL',{}]) {
    assert.throws(()=>requireProtectedTenantMode(context,real,expected),ProtectedTenantRuntimeError);
  }
});

test('deployment labels are exact server scope and production refuses every synthetic slot',()=>{
  for (const environment of ['dev','int','prod']) {
    const scope={ ...context,environment };
    assert.equal(requireProtectedTenantRuntime(scope,{ ...real,environment }).mode,'real');
    for (const slot of ['northwind','contoso','fabrikam']) {
      const value={ ...synthetic,environment,slot };
      if (environment==='prod') assert.throws(()=>requireProtectedTenantRuntime(scope,value),ProtectedTenantRuntimeError);
      else assert.equal(requireProtectedTenantRuntime(scope,value).mode,'synthetic');
    }
  }
  for (const environment of ['demo','production','test',undefined,null]) {
    assert.throws(()=>requireProtectedTenantRuntime({ ...context,environment },real),ProtectedTenantRuntimeError);
  }
});
