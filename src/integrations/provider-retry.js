const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 100;
const MAX_DELAY_MS = 2_000;

function delayForAttempt(attempt, baseDelayMs, retryAfterMs) {
  if (Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, MAX_DELAY_MS);
  }
  return Math.min(baseDelayMs * (2 ** (attempt - 1)), MAX_DELAY_MS);
}

export async function executeSafeProviderOperation(operation, {
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  classifyError,
} = {}) {
  if (typeof operation !== 'function') throw new TypeError('PROVIDER_RETRY_OPERATION_REQUIRED');
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new TypeError('PROVIDER_RETRY_ATTEMPTS_INVALID');
  }
  if (!Number.isSafeInteger(baseDelayMs) || baseDelayMs < 1 || baseDelayMs > 1_000) {
    throw new TypeError('PROVIDER_RETRY_DELAY_INVALID');
  }
  if (typeof sleep !== 'function') throw new TypeError('PROVIDER_RETRY_SLEEP_INVALID');
  if (typeof classifyError !== 'function') throw new TypeError('PROVIDER_RETRY_CLASSIFIER_REQUIRED');

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const classification = classifyError(error);
      if (!classification?.retryable || attempt >= maxAttempts) throw error;
      await sleep(delayForAttempt(attempt, baseDelayMs, classification.retryAfterMs));
    }
  }
  throw new Error('PROVIDER_RETRY_UNREACHABLE');
}
