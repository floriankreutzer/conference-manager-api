import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { BrowserNavigationFormError,isBrowserNavigationForm,readBrowserNavigationForm }
  from '../src/transport/browser-navigation-form.js';

function request(body,headers={}) {
  const value=Readable.from([Buffer.from(body)]);
  value.headers={ 'content-type': 'application/x-www-form-urlencoded',...headers };return value;
}
test('navigation parser accepts only bounded canonical exact native form fields and no implicit authority',async()=>{
  const values={ payload: JSON.stringify({ role: 'employee',response: { id: 'opaque' } }),csrfToken: 'a'.repeat(43) };
  const body=new URLSearchParams(values).toString(),parsed=await readBrowserNavigationForm(request(body),
    { keys: ['payload','csrfToken'],maxBytes: 1024 });
  assert.deepEqual(parsed,values);assert.equal(Object.isFrozen(parsed),true);
  assert.deepEqual(await readBrowserNavigationForm(request(''),{ keys: [],maxBytes: 1024 }),{});
  assert.equal(isBrowserNavigationForm({ 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }),true);
  assert.equal(isBrowserNavigationForm({ 'content-type': ['application/x-www-form-urlencoded'] }),false);
});
test('navigation parser rejects duplicate, malformed, extra and noncanonical fields, encoding and overflow',async()=>{
  for (const [body,headers,status] of [['csrfToken=x&csrfToken=y',{},400],['foreign=x',{},400],['csrfToken=%zz',{},400],
    ['csrfToken=%61',{},400],['csrfToken=a%20b',{},400],['csrfToken=\ufffd',{},400],['csrfToken='+ 'x'.repeat(1024),{},413],
    ['csrfToken=x',{ 'content-encoding': 'gzip' },415],['csrfToken=x',{ 'content-length': '1025' },413],
    ['csrfToken=x',{ 'content-length': 'invalid' },400],['csrfToken=x',{ 'content-type': 'text/plain' },415]]) {
    await assert.rejects(readBrowserNavigationForm(request(body,headers),{ keys: ['csrfToken'],maxBytes: 1024 }),
      error=>error instanceof BrowserNavigationFormError && error.statusCode===status);
  }
  await assert.rejects(readBrowserNavigationForm(request(''),{ keys: ['tenantId'],maxBytes: 1024 }),/CONFIGURATION_INVALID/);
});
