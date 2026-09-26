import { ApiError } from '../api-error.js';
import { isRequestVersion } from '../domain/request.js';

const STRONG_REQUEST_VERSION_ETAG = /^"([1-9][0-9]{0,15})"$/;

export function readRequestTransitionExpectedVersion(headers) {
  const value = headers?.['if-match'];
  if (value === undefined) {
    throw new ApiError(428, 'REQUEST_VERSION_PRECONDITION_REQUIRED');
  }
  if (Array.isArray(value) || typeof value !== 'string') {
    throw new ApiError(400, 'REQUEST_VERSION_PRECONDITION_INVALID');
  }
  const match = value.match(STRONG_REQUEST_VERSION_ETAG);
  const expectedVersion = match ? Number(match[1]) : Number.NaN;
  if (!isRequestVersion(expectedVersion)) {
    throw new ApiError(400, 'REQUEST_VERSION_PRECONDITION_INVALID');
  }
  return expectedVersion;
}
