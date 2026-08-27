const FRONTEND_SAFE_RESPONSE_BYTES = 950_000;

export function publicResponseByteLimit(configuredBytes) {
  if (!Number.isSafeInteger(configuredBytes) || configuredBytes < 1_024) {
    throw new TypeError('PUBLIC_RESPONSE_BYTES_INVALID');
  }
  return Math.min(configuredBytes, FRONTEND_SAFE_RESPONSE_BYTES);
}

export function fitPublicPage({
  items,
  limit,
  maxResponseBytes,
  cursorFor,
  resultFor,
  envelopeFor,
} = {}) {
  if (
    !Array.isArray(items)
    || !Number.isSafeInteger(limit)
    || limit < 1
    || items.length > limit + 1
    || typeof cursorFor !== 'function'
    || typeof resultFor !== 'function'
    || typeof envelopeFor !== 'function'
  ) throw new TypeError('PUBLIC_PAGE_INPUT_INVALID');
  const byteLimit = publicResponseByteLimit(maxResponseBytes);

  function candidate(count) {
    const selected = Object.freeze(items.slice(0, count));
    const complete = items.length <= count;
    const nextCursor = complete || count === 0 ? null : cursorFor(selected.at(-1));
    const page = Object.freeze({ limit, complete, nextCursor });
    const result = resultFor(selected, page);
    const envelope = envelopeFor(result);
    const serialized = JSON.stringify(envelope);
    if (typeof serialized !== 'string') throw new TypeError('PUBLIC_PAGE_RESULT_INVALID');
    return Object.freeze({
      result,
      bytes: Buffer.byteLength(serialized),
    });
  }

  if (items.length === 0) {
    const empty = candidate(0);
    if (empty.bytes > byteLimit) throw new TypeError('PUBLIC_PAGE_ENVELOPE_TOO_LARGE');
    return empty.result;
  }

  let fitted = null;
  const maximum = Math.min(items.length, limit);
  for (let count = 1; count <= maximum; count += 1) {
    const next = candidate(count);
    if (next.bytes > byteLimit) break;
    fitted = next.result;
  }
  if (!fitted) throw new TypeError('PUBLIC_PAGE_ITEM_TOO_LARGE');
  return fitted;
}
