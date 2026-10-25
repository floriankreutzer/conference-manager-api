import assert from 'node:assert/strict';
import test from 'node:test';
import { syntheticOperationAssurance } from '../src/domain/synthetic-operation-assurance.js';

test('synthetic proof profiles have fixed distinct Microsoft contexts and preserve the historical default',()=>{
  const legacy=syntheticOperationAssurance(),microsoft=syntheticOperationAssurance('microsoft_mfa');
  assert.deepEqual(legacy,{ mode: 'application_passkey',normalContext: 'cm:pk:v1',freshContext: 'cm:pk:v1' });
  assert.deepEqual(microsoft,{ mode: 'microsoft_mfa',normalContext: 'cm:ms:mfa:v1',freshContext: 'cm:ms:fresh:v1' });
  assert.ok(Object.isFrozen(legacy));assert.ok(Object.isFrozen(microsoft));
  for (const value of [null,{},'conditional_access','mfa','cm:ms:mfa:v1','__proto__','constructor','microsoft_mfa ']) {
    assert.throws(()=>syntheticOperationAssurance(value),{ message: 'SYNTHETIC_OPERATION_ASSURANCE_MODE_INVALID' });
  }
});
