import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PLATFORM_MICROSOFT_OPERATION_CALLBACK,readPlatformMicrosoftOperationBrowserCookie,readPlatformMicrosoftOperationCookie,
  serializePlatformMicrosoftOperationBrowserCookie,serializePlatformMicrosoftOperationCookie,
  clearPlatformMicrosoftOperationBrowserCookie,clearPlatformMicrosoftOperationCookie,
} from '../src/platform/identity/microsoft-operation-cookie.js';

const value=[Buffer.alloc(32,1),Buffer.alloc(32,2)].map(bytes=>bytes.toString('base64url')).join('.');
test('Microsoft operation callback and same-origin completion have separate bounded HttpOnly cookie custody',()=>{
  const browser=serializePlatformMicrosoftOperationBrowserCookie(value);
  const operation=serializePlatformMicrosoftOperationCookie(value,37);
  assert.equal(browser,`cm_platform_ms_operation_tx=${value}; Path=${PLATFORM_MICROSOFT_OPERATION_CALLBACK}; `
    +'HttpOnly; Secure; SameSite=Lax; Max-Age=120');
  assert.equal(operation,`cm_platform_ms_operation=${value}; Path=/api/v1/platform; HttpOnly; Secure; SameSite=Strict; Max-Age=37`);
  const browserHeader=browser.split(';')[0],operationHeader=operation.split(';')[0];
  assert.equal(readPlatformMicrosoftOperationBrowserCookie({ cookie: browserHeader }),value);
  assert.equal(readPlatformMicrosoftOperationCookie({ cookie: operationHeader }),value);
  assert.equal(readPlatformMicrosoftOperationCookie({ cookie: browserHeader }),null);
  assert.equal(readPlatformMicrosoftOperationBrowserCookie({ cookie: operationHeader }),null);
  const header=`cm_platform_session=unrelated; ${browserHeader}; ${operationHeader}`;
  assert.equal(readPlatformMicrosoftOperationBrowserCookie({ cookie: header }),value);
  assert.equal(readPlatformMicrosoftOperationCookie({ cookie: header }),value);
  assert.equal(clearPlatformMicrosoftOperationBrowserCookie(),
    `cm_platform_ms_operation_tx=; Path=${PLATFORM_MICROSOFT_OPERATION_CALLBACK}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  assert.equal(clearPlatformMicrosoftOperationCookie(),
    'cm_platform_ms_operation=; Path=/api/v1/platform; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
});
test('Microsoft operation cookie parsing rejects duplicates, malformed/noncanonical values and excess input',()=>{
  for (const [name,read] of [['cm_platform_ms_operation_tx',readPlatformMicrosoftOperationBrowserCookie],
    ['cm_platform_ms_operation',readPlatformMicrosoftOperationCookie]]) {
    for (const raw of [null,[],`${name}=${value}; ${name}=${value}`,`${name}=; ${name}=${value}`,
      `${name}=undefined`,`${name}=${'A'.repeat(43)}.${'S'.repeat(43)}`,`${name}=${value}.extra`,
      `${name}=${value}; unrelated=${'A'.repeat(8192)}`]) assert.equal(read({ cookie: raw }),null);
    assert.equal(read(undefined),null);
  }
});
test('Microsoft operation serialization cannot extend pending proof lifetime or select cookie policy',()=>{
  for (const seconds of [undefined,null,0,-1,121,1.5,'120',Number.NaN]) {
    assert.throws(()=>serializePlatformMicrosoftOperationCookie(value,seconds),/COOKIE_INVALID/);
  }
  for (const seconds of [0,121,1.5,'120']) {
    assert.throws(()=>serializePlatformMicrosoftOperationBrowserCookie(value,seconds),/COOKIE_INVALID/);
  }
  for (const malformed of [null,'',value+'; Domain=example.test',value.replace('.','\n')]) {
    assert.throws(()=>serializePlatformMicrosoftOperationBrowserCookie(malformed),/COOKIE_INVALID/);
    assert.throws(()=>serializePlatformMicrosoftOperationCookie(malformed,10),/COOKIE_INVALID/);
  }
});
