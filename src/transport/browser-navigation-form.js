const CONTENT_TYPE=/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i;
const CODES=new Set(['UNSUPPORTED_MEDIA_TYPE','CONTENT_ENCODING_NOT_ALLOWED',
  'CONTENT_LENGTH_INVALID','BODY_TOO_LARGE','VALIDATION_FAILED']);

export class BrowserNavigationFormError extends Error {
  constructor(statusCode,code) {
    if (![400,413,415].includes(statusCode) || !CODES.has(code)) throw new TypeError('NAVIGATION_FORM_ERROR_INVALID');
    super(code);this.name='BrowserNavigationFormError';this.statusCode=statusCode;this.code=code;
  }
}
export function isBrowserNavigationForm(headers) {
  return typeof headers?.['content-type']==='string' && CONTENT_TYPE.test(headers['content-type'].trim());
}
function invalid() { throw new BrowserNavigationFormError(400,'VALIDATION_FAILED'); }

// Fixed same-origin native forms make303 a real top-level navigation. Browser
// fetch manual redirects are opaque and cannot implement a cross-site handoff.
// This is bounded transport parsing only, never identity/CSRF authority itself.
export async function readBrowserNavigationForm(request,{ keys,maxBytes }={}) {
  if (!Array.isArray(keys) || keys.length>2 || new Set(keys).size!==keys.length
    || keys.some(key=>!['csrfToken','payload'].includes(key))
    || !Number.isSafeInteger(maxBytes) || maxBytes<1 || maxBytes>32768) throw new TypeError('NAVIGATION_FORM_CONFIGURATION_INVALID');
  if (!isBrowserNavigationForm(request.headers)) throw new BrowserNavigationFormError(415,'UNSUPPORTED_MEDIA_TYPE');
  const encoding=request.headers['content-encoding'];
  if (encoding!==undefined && encoding!=='identity') throw new BrowserNavigationFormError(415,'CONTENT_ENCODING_NOT_ALLOWED');
  const length=request.headers['content-length'];
  if (length!==undefined) {
    if (typeof length!=='string' || !/^\d{1,8}$/.test(length)) throw new BrowserNavigationFormError(400,'CONTENT_LENGTH_INVALID');
    if (Number(length)>maxBytes) throw new BrowserNavigationFormError(413,'BODY_TOO_LARGE');
  }
  const chunks=[];let bytes=0;
  for await (const chunk of request) {
    bytes+=chunk.length;if (bytes>maxBytes) throw new BrowserNavigationFormError(413,'BODY_TOO_LARGE');chunks.push(chunk);
  }
  const text=Buffer.concat(chunks).toString('utf8');if (/[^\x20-\x7e]/.test(text)) invalid();
  const form=new URLSearchParams(text),entries=[...form.entries()];
  if (entries.length!==keys.length || form.toString()!==text
    || entries.some(([key])=>!keys.includes(key) || form.getAll(key).length!==1)) invalid();
  return Object.freeze(Object.fromEntries(entries));
}
