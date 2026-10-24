import assert from 'node:assert/strict';
import test from 'node:test';
import { createSyntheticHandoffBrowserBinding } from '../src/identity/synthetic-handoff-browser-binding.js';
import { createOwnerCustomerHandoffBrowserBinding } from '../src/identity/owner-customer-handoff-browser-binding.js';

const scope={ environment: 'int',securityEpoch: '11111111-1111-4111-8111-111111111111',platformSecurityEpoch: 7,
  customerOrigin: 'https://app.example.test',platformOrigin: 'https://ops.example.test' };
const flowId='22222222-2222-4222-8222-222222222222',now=new Date('2026-10-24T12:00:00Z'),expiresAt=new Date('2026-10-24T12:00:30Z');
function fixture(create) {
  let counter=0;const protocol=create({ scope,secret: 's'.repeat(48),randomToken: ()=>Buffer.alloc(32,++counter).toString('base64url') });
  const start=protocol.issueStart(flowId),code=protocol.issueCode(flowId);
  const binding={ flowId,browserVerifier: start.browserVerifier,codeVerifier: code.codeVerifier };
  const completion=protocol.issueCompletion({ binding,browserToken: start.browserToken,now,expiresAt });
  return { protocol,start,code,binding,completion };
}

test('browser-binding extraction preserves the exact already-issued synthetic MAC and completion protocol',()=>{
  const f=fixture(createSyntheticHandoffBrowserBinding);
  try {
    // Captured from the pre-extraction adapter with the fixed synthetic inputs.
    assert.equal(f.start.stateHash,'316f9875f0274fe5c6f1ddebb777d8a8e8394da899788a89305a8ad6d6a1955f');
    assert.equal(f.start.browserVerifier,'5380a6eba11ac7185234010450ab62efe048516e7e387f52202a57edc33593dc');
    assert.equal(f.code.codeVerifier,'148a7adecc5f559547cb2f9fbfe84112de05906a692a0d1f5f7703724d75a8e6');
    assert.equal(f.completion.value,flowId+'.1792843230000.'
      +'BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ.vdKAtpy-zDtNiGjgSmgjO5cKm32RnQeLdspPEgm_7pw');
    assert.equal(f.completion.csrfToken,'a3550861faee9a3f18e3a026f346ef9e8648ff237e524fe9ee4d9bde91e98797');
  } finally { f.protocol.destroy(); }
});

test('REAL owner and synthetic browser/code/completion custody cannot cross even with identical fixed inputs and secret',()=>{
  const synthetic=fixture(createSyntheticHandoffBrowserBinding),owner=fixture(createOwnerCustomerHandoffBrowserBinding);
  try {
    assert.equal(owner.start.state,synthetic.start.state);assert.equal(owner.code.code,synthetic.code.code);
    assert.notEqual(owner.start.stateHash,synthetic.start.stateHash);
    assert.notEqual(owner.start.browserVerifier,synthetic.start.browserVerifier);
    assert.notEqual(owner.code.codeVerifier,synthetic.code.codeVerifier);
    for (const [source,target] of [[synthetic,owner],[owner,synthetic]]) {
      assert.equal(target.protocol.matchesBrowser({ flowId,browserToken: source.start.browserToken,
        browserVerifier: source.start.browserVerifier }),false);
      assert.equal(target.protocol.matchesCode({ flowId,code: source.code.code,codeVerifier: source.code.codeVerifier }),false);
      assert.equal(target.protocol.matchesCompletion({ binding: source.binding,browserToken: source.start.browserToken,
        value: source.completion.value,now }),false);
      assert.equal(target.protocol.verifyCompletionCsrf({ binding: source.binding,value: source.completion.value,
        csrfToken: source.completion.csrfToken }),false);
    }
    assert.equal(owner.protocol.matchesCompletion({ binding: owner.binding,browserToken: owner.start.browserToken,
      value: owner.completion.value,now }),true);
    assert.equal(owner.protocol.matchesCompletion({ binding: owner.binding,browserToken: owner.start.browserToken,
      value: owner.completion.value,now: expiresAt }),false);
  } finally { synthetic.protocol.destroy();owner.protocol.destroy(); }
  assert.throws(()=>owner.protocol.stateVerifier(owner.start.state),/OWNER_CUSTOMER_ACCESS_BROWSER_BINDING_UNAVAILABLE/);
  assert.throws(()=>synthetic.protocol.stateVerifier(synthetic.start.state),/SYNTHETIC_HANDOFF_BROWSER_BINDING_UNAVAILABLE/);
});
