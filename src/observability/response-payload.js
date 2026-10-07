const EMPTY_STATUSES = new Set([204, 205, 304]);

function payloadObservation(response, method) {
  const statusCode = response.statusCode;
  if (method === 'HEAD' || statusCode < 200 || EMPTY_STATUSES.has(statusCode)) {
    return { statusCode, payloadClass: 'empty', bytes: 0 };
  }
  const length = response.getHeader('Content-Length');
  if (typeof length !== 'number' && typeof length !== 'string') return null;
  if (typeof length === 'string' && !/^(?:0|[1-9][0-9]{0,15})$/.test(length)) return null;
  const bytes = Number(length);
  if (!Number.isSafeInteger(bytes) || bytes < 0) return null;
  const contentType = response.getHeader('Content-Type');
  const payloadClass = bytes === 0 ? 'empty'
    : typeof contentType !== 'string' ? 'other'
      : /^application\/json(?:;|$)/i.test(contentType) ? 'json'
        : /^image\/(?:png|jpeg|webp)(?:;|$)/i.test(contentType) ? 'image' : 'other';
  return { statusCode, payloadClass, bytes };
}

// Counts framed body bytes handed to Node's transport, not provider-billed network transfer.
// No response monkey-patching, payload buffering, request input or public metrics endpoint.
export function observeResponsePayloadSafely({ response, metrics, route, method }) {
  if (typeof metrics?.recordResponsePayload !== 'function') return;
  let recorded = false;
  const record = () => {
    if (recorded) return;
    recorded = true;
    try {
      const observation = payloadObservation(response, method);
      if (observation) metrics.recordResponsePayload({
        route,
        method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? method : 'OTHER',
        ...observation,
      });
    } catch {
      // A failed operational observer cannot reject or replace a completed HTTP response.
    }
  };
  try {
    if (response.writableFinished) record();
    else {
      response.once('finish', record);
      response.once('close', () => response.removeListener('finish', record));
    }
  } catch {
    // Minimal injected response ports need not implement Node's finish/close event interface.
  }
}
