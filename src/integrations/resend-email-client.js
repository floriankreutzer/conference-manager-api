import { createHash } from 'node:crypto';
import { APPROVED_OUTBOUND_ORIGINS } from '../config.js';
import { isInternalUuid } from '../domain/identifiers.js';
import { normalizeInvitationRecipient } from '../domain/invitation-recipient.js';

const SEND_ENDPOINT = `${APPROVED_OUTBOUND_ORIGINS.transactionalEmail}/emails`;
const MAX_RESPONSE_BYTES = 4096;
const MAX_TEXT_BYTES = 16_384;

export class TransactionalEmailError extends Error {
  constructor(code, { retryable = false, retryAfterMs = null } = {}) {
    super(code);
    this.name = 'TransactionalEmailError';
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

function requireMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || Object.keys(message).length !== 4
    || Object.keys(message).some((key) => !['recipient', 'subject', 'text', 'deliveryId'].includes(key))) {
    throw new TransactionalEmailError('EMAIL_MESSAGE_INVALID');
  }
  let recipient;
  try {
    recipient = normalizeInvitationRecipient(message.recipient);
  } catch {
    throw new TransactionalEmailError('EMAIL_MESSAGE_INVALID');
  }
  if (!isInternalUuid(message.deliveryId)
    || typeof message.subject !== 'string' || message.subject.trim().length < 1
    || message.subject.length > 200 || /[\u0000-\u001f\u007f]/.test(message.subject)
    || typeof message.text !== 'string' || message.text.trim().length < 1
    || Buffer.byteLength(message.text, 'utf8') > MAX_TEXT_BYTES
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(message.text)) {
    throw new TransactionalEmailError('EMAIL_MESSAGE_INVALID');
  }
  return { recipient, subject: message.subject, text: message.text, deliveryId: message.deliveryId.toLowerCase() };
}

async function cancelBody(body) {
  try {
    await body?.cancel();
  } catch {
    // Resource cleanup must not replace the fixed public failure classification.
  }
}

async function readReceipt(response) {
  const length = response.headers?.get?.('content-length');
  const type = response.headers?.get?.('content-type');
  if (!/^application\/json(?:\s*;[^\r\n]*)?$/i.test(type || '')
    || (length !== null && length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES))) {
    await cancelBody(response.body);
    throw new TransactionalEmailError('EMAIL_RESPONSE_INVALID');
  }
  const reader = response.body?.getReader?.();
  if (!reader) throw new TransactionalEmailError('EMAIL_RESPONSE_INVALID');
  const chunks = [];
  let bytes = 0;
  try {
    for (let count = 0; count < 64; count += 1) {
      const result = await reader.read();
      if (!result || typeof result.done !== 'boolean') throw new Error();
      if (result.done) {
        const value = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).length !== 1 || !isInternalUuid(value.id)) throw new Error();
        return Object.freeze({ status: 'accepted', messageId: value.id.toLowerCase() });
      }
      if (!(result.value instanceof Uint8Array)) throw new Error();
      bytes += result.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error();
      chunks.push(Buffer.from(result.value));
    }
    throw new Error();
  } catch {
    await cancelBody(reader);
    throw new TransactionalEmailError('EMAIL_RESPONSE_INVALID');
  } finally {
    reader.releaseLock?.();
  }
}

function statusFailure(response) {
  const status = response.status;
  if (status === 429) {
    const value = response.headers?.get?.('retry-after');
    const seconds = /^\d{1,2}$/.test(value || '') ? Math.min(60, Number(value)) : null;
    return new TransactionalEmailError('EMAIL_RATE_LIMITED', {
      retryable: true, retryAfterMs: seconds === null ? null : seconds * 1000,
    });
  }
  if (status >= 500 && status <= 599) return new TransactionalEmailError('EMAIL_PROVIDER_UNAVAILABLE', { retryable: true });
  if (status === 401 || status === 403) return new TransactionalEmailError('EMAIL_PROVIDER_NOT_AUTHORIZED');
  if (status === 409) return new TransactionalEmailError('EMAIL_DELIVERY_CONFLICT');
  return new TransactionalEmailError('EMAIL_PROVIDER_REJECTED');
}

// Not composed into any runtime yet. Only an authorized application use case may call this port.
export function createResendEmailClient({ apiKey, sender, environment, timeoutMs = 10_000, fetchImpl = globalThis.fetch } = {}) {
  if (typeof apiKey !== 'string' || !/^re_[A-Za-z0-9_-]{16,252}$/.test(apiKey)
    || !['dev', 'int', 'prod'].includes(environment)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30_000
    || typeof fetchImpl !== 'function') throw new TypeError('EMAIL_CONFIGURATION_INVALID');
  let from;
  try {
    from = normalizeInvitationRecipient(sender);
  } catch {
    throw new TypeError('EMAIL_CONFIGURATION_INVALID');
  }
  return Object.freeze({
    async send(message) {
      const input = requireMessage(message);
      const key = createHash('sha256').update(`transactional-email:${environment}:${input.deliveryId}`, 'ascii').digest('hex');
      let response;
      try {
        response = await fetchImpl(SEND_ENDPOINT, {
          method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': key,
          },
          body: JSON.stringify({ from, to: [input.recipient], subject: input.subject, text: input.text }),
        });
      } catch {
        // Never retain raw provider/network errors: they may contain credentials or message content.
        throw new TransactionalEmailError('EMAIL_PROVIDER_UNAVAILABLE', { retryable: true });
      }
      if (!response || response.redirected === true || (response.url && response.url !== SEND_ENDPOINT)
        || !Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599) {
        await cancelBody(response?.body);
        throw new TransactionalEmailError('EMAIL_RESPONSE_INVALID');
      }
      if (response.status !== 200) {
        await cancelBody(response.body);
        throw statusFailure(response);
      }
      return readReceipt(response);
    },
  });
}
