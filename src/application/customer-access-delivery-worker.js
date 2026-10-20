import { isInternalUuid } from '../domain/identifiers.js';

const FAILURE_CODES=new Set(['EMAIL_RATE_LIMITED','EMAIL_PROVIDER_UNAVAILABLE','EMAIL_PROVIDER_NOT_AUTHORIZED',
  'EMAIL_DELIVERY_CONFLICT','EMAIL_PROVIDER_REJECTED','EMAIL_RESPONSE_INVALID','EMAIL_MESSAGE_INVALID']);
const invalid=() => { throw new Error('CUSTOMER_ACCESS_DELIVERY_CONTRACT_INVALID'); };
function exact(value,keys) {
  if (!value || typeof value!=='object' || Array.isArray(value)
    || Object.getPrototypeOf(value)!==Object.prototype && Object.getPrototypeOf(value)!==null) invalid();
  const own=Reflect.ownKeys(value);
  if (own.length!==keys.length || own.some(key => {
    const field=Object.getOwnPropertyDescriptor(value,key);
    return !keys.includes(key) || !field.enumerable || !Object.hasOwn(field,'value');
  })) invalid();
}
function claim(value) {
  exact(value,['deliveryId','leaseId','attemptCount','message']);
  if (!isInternalUuid(value.deliveryId) || !isInternalUuid(value.leaseId)
    || !Number.isSafeInteger(value.attemptCount) || value.attemptCount<1 || value.attemptCount>5) invalid();
  exact(value.message,['recipient','subject','text','deliveryId']);
  if (value.message.deliveryId!==value.deliveryId) invalid();
  // The provider port owns the message schema and fixed destination. Copy only
  // its closed command; a repository cannot inject arbitrary provider options.
  return Object.freeze({ deliveryId: value.deliveryId,leaseId: value.leaseId,attemptCount: value.attemptCount,
    message: Object.freeze({ recipient: value.message.recipient,subject: value.message.subject,
      text: value.message.text,deliveryId: value.deliveryId }) });
}
function failure(value) {
  const known=value?.name==='TransactionalEmailError' && FAILURE_CODES.has(value.code);
  const retryable=known && value.retryable===true && ['EMAIL_RATE_LIMITED','EMAIL_PROVIDER_UNAVAILABLE'].includes(value.code);
  const retryAfterMs=retryable && Number.isSafeInteger(value.retryAfterMs)
    && value.retryAfterMs>=0 && value.retryAfterMs<=60000 ? value.retryAfterMs : 0;
  return { retryable,retryAfterMs };
}

// Explicit bounded dispatch only: no polling timer, configuration loading,
// email receipt, session issuance or default runtime installation happens here.
export function createCustomerAccessDeliveryWorker({ repository,provider,random=Math.random } = {}) {
  if (!repository || ['claim','settle'].some(key => typeof repository[key]!=='function')
    || typeof provider?.send!=='function' || typeof random!=='function') {
    throw new TypeError('CUSTOMER_ACCESS_DELIVERY_CONFIGURATION_INVALID');
  }
  let running=false;
  return Object.freeze({
    async runOnce() {
      if (running) return Object.freeze({ status: 'busy' });
      running=true;
      try {
        const pending=await repository.claim();
        if (pending===null) return Object.freeze({ status: 'idle' });
        const value=claim(pending);let outcome;
        try {
          const receipt=await provider.send(value.message);
          exact(receipt,['status','messageId']);
          if (receipt.status!=='accepted' || !isInternalUuid(receipt.messageId)) invalid();
          outcome={ status: 'accepted',providerMessageId: receipt.messageId.toLowerCase(),retryDelayMs: null };
        } catch (error) {
          if (error?.message==='CUSTOMER_ACCESS_DELIVERY_CONTRACT_INVALID') throw error;
          const classified=failure(error);
          if (classified.retryable && value.attemptCount<5) {
            const jitter=random();if (typeof jitter!=='number' || !Number.isFinite(jitter) || jitter<0 || jitter>=1) invalid();
            const delay=Math.min(60000,1000*2**(value.attemptCount-1));
            outcome={ status: 'queued',providerMessageId: null,
              retryDelayMs: Math.max(classified.retryAfterMs,delay+Math.floor(jitter*delay)) };
          } else outcome={ status: 'failed',providerMessageId: null,retryDelayMs: null };
        }
        // A failed settlement is visible and never triggers another provider
        // request. A later lease recovery must retain the same durable payload ID.
        const stored=await repository.settle({ deliveryId: value.deliveryId,leaseId: value.leaseId,...outcome });
        if (stored!==null && (stored!==outcome.status && !(outcome.status==='queued' && stored==='failed'))) invalid();
        return Object.freeze({ status: stored ?? 'lease_lost' });
      } finally { running=false; }
    },
  });
}
