import { ApiError } from '../api-error.js';
import { readSessionToken,serializeSessionCookie } from '../identity/session-cookie.js';

const invalid=()=>{ throw new ApiError(500,'AUTHENTICATION_RESULT_INVALID'); };
// Shared transport contracts for explicit email/Microsoft authentication. These
// validate/minimize output only; they grant no proof, session or membership.
export function checkedCustomerSessionCookie(value) {
  if (typeof value!=='string' || value.length>256) invalid();
  const token=readSessionToken({ cookie: value.split(';')[0] }),age=value.match(/; Max-Age=([1-9]\d{0,4})$/);
  if (!token || !age || Number(age[1])>86400
    || value!==serializeSessionCookie(token,{ secure: true,maxAgeSeconds: Number(age[1]) })) invalid();return value;
}
export function sendCustomerAuthenticationJson(response,status,value,maxBytes) {
  const body=JSON.stringify(value);
  if (Buffer.byteLength(body)>maxBytes) invalid();
  response.statusCode=status;response.setHeader('Content-Type','application/json; charset=utf-8');
  response.setHeader('Content-Length',Buffer.byteLength(body));response.end(body);return status;
}
export async function assertEmptyAuthenticationBody(request) {
  if (request.headers['transfer-encoding']!==undefined
    || request.headers['content-length']!==undefined && request.headers['content-length']!=='0') {
    throw new ApiError(400,'REQUEST_BODY_NOT_ALLOWED');
  }
  for await (const chunk of request) if (chunk.length) throw new ApiError(400,'REQUEST_BODY_NOT_ALLOWED');
}
export function readCustomerFlowCsrf(request) {
  const token=request.headers['x-csrf-token'];
  if (typeof token!=='string' || !/^[a-f0-9]{64}$/.test(token)) throw new ApiError(403,'CSRF_INVALID');return token;
}
