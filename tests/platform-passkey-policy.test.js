import assert from 'node:assert/strict';
import test from 'node:test';
import { requirePlatformPasskeyMinimum } from '../src/platform/identity/passkey-policy.js';

test('passkey policy defaults to two everywhere and accepts a reduced minimum exclusively for INT',()=>{
  for (const environment of ['dev','int','prod']) {
    assert.equal(requirePlatformPasskeyMinimum(environment),2);
    assert.equal(requirePlatformPasskeyMinimum(environment,2),2);
    if (environment==='int') assert.equal(requirePlatformPasskeyMinimum(environment,1),1);
    else assert.throws(()=>requirePlatformPasskeyMinimum(environment,1),/MINIMUM_INVALID/);
  }
  for (const count of [null,'1','2',true,0,3,NaN,1.5]) {
    assert.throws(()=>requirePlatformPasskeyMinimum('int',count),/MINIMUM_INVALID/);
  }
  for (const environment of [undefined,null,'INT','production','demo']) {
    assert.throws(()=>requirePlatformPasskeyMinimum(environment,1),/MINIMUM_INVALID/);
  }
});
