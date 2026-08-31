import { ConfidentialClientApplication } from '@azure/msal-node';
import { APPROVED_OUTBOUND_ORIGINS } from '../config.js';
import {
  MICROSOFT365_BASE_PERMISSIONS,
  MICROSOFT365_CALENDAR_WRITE_PERMISSION,
  MICROSOFT365_PROVIDER,
  MICROSOFT365_VERIFICATION,
  Microsoft365ProviderError,
} from './microsoft365-contract.js';

export {
  MICROSOFT365_BASE_PERMISSIONS,
  MICROSOFT365_CALENDAR_WRITE_PERMISSION,
  MICROSOFT365_PROVIDER,
  MICROSOFT365_VERIFICATION,
  Microsoft365ProviderError,
} from './microsoft365-contract.js';

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const IDEMPOTENCY_KEY_PATTERN = /^[0-9a-f]{64}$/;
const LOGIN_ORIGIN = APPROVED_OUTBOUND_ORIGINS.microsoftIdentity;
const GRAPH_ORIGIN = APPROVED_OUTBOUND_ORIGINS.microsoftGraph;
const GRAPH_SCOPE = `${GRAPH_ORIGIN}/.default`;
const CONSENT_PATH_SUFFIX = '/v2.0/adminconsent';
const DEFAULT_TIMEOUT_MS = 10_000;
const ACCESS_TOKEN_MAX = 32_768;
const PROVIDER_REQUEST_MAX_BYTES = 65_536;
const PROVIDER_RESPONSE_MAX_BYTES = 65_536;
const PROVIDER_URL_MAX_LENGTH = 4_096;
const PROVIDER_HEADER_COUNT_MAX = 64;
const PROVIDER_HEADER_NAME_MAX = 128;
const PROVIDER_HEADER_VALUE_MAX = 16_384;
const ROOM_PAGE_SIZE = 100;
const ROOM_COLLECTION_LIMIT = 1_000;
const ROOM_COLLECTION_MAX_BYTES = 1_000_000;
const ROOM_PAGE_LIMIT = ROOM_COLLECTION_LIMIT / ROOM_PAGE_SIZE;
const ROOM_STRING_MAX = 512;
const ROOM_RESOURCE_MAX = 320;
const ROOM_SELECT = [
  'id',
  'displayName',
  'emailAddress',
  'capacity',
  'building',
  'floorNumber',
  'floorLabel',
  'label',
  'nickname',
  'phone',
  'audioDeviceName',
  'videoDeviceName',
  'displayDeviceName',
  'bookingType',
].join(',');
const FREE_BUSY_SCHEDULE_LIMIT = 20;
const FREE_BUSY_SCHEDULE_MAX = 320;
const FREE_BUSY_INTERVAL_MINUTES = 5;
const FREE_BUSY_MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const FREE_BUSY_VIEW_MAX = FREE_BUSY_MAX_WINDOW_MS / (FREE_BUSY_INTERVAL_MINUTES * 60 * 1_000);
const EVENT_REFERENCE_MAX = 512;
const CALENDAR_EVENT_SUBJECT = 'Conference Manager room reservation';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function requireGuid(value, code) {
  if (typeof value !== 'string' || !GUID_PATTERN.test(value)) {
    throw new Microsoft365ProviderError(code);
  }
  return value.toLowerCase();
}

function requireState(value) {
  if (typeof value !== 'string' || !STATE_PATTERN.test(value)) {
    throw new Microsoft365ProviderError('MICROSOFT365_CONSENT_STATE_INVALID');
  }
  return value;
}

function validAccessToken(value) {
  return typeof value === 'string'
    && value.length >= 32
    && value.length <= ACCESS_TOKEN_MAX
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function requireMicrosoftIdentityUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Microsoft365ProviderError('MICROSOFT365_IDENTITY_URL_INVALID');
  }
  if (
    url.origin !== LOGIN_ORIGIN
    || url.username
    || url.password
    || url.hash
    || url.href.length > PROVIDER_URL_MAX_LENGTH
  ) {
    throw new Microsoft365ProviderError('MICROSOFT365_IDENTITY_URL_INVALID');
  }
  return url;
}

function boundedRequestHeaders(options) {
  if (options?.headers === undefined) return undefined;
  if (!options.headers || typeof options.headers !== 'object' || Array.isArray(options.headers)) {
    throw new Microsoft365ProviderError('MICROSOFT365_IDENTITY_REQUEST_INVALID');
  }
  const entries = Object.entries(options.headers);
  if (entries.length > PROVIDER_HEADER_COUNT_MAX) {
    throw new Microsoft365ProviderError('MICROSOFT365_IDENTITY_REQUEST_INVALID');
  }
  const headers = {};
  for (const [name, value] of entries) {
    if (
      name.length < 1
      || name.length > PROVIDER_HEADER_NAME_MAX
      || typeof value !== 'string'
      || value.length > PROVIDER_HEADER_VALUE_MAX
      || /[\r\n]/.test(name)
      || /[\r\n]/.test(value)
    ) {
      throw new Microsoft365ProviderError('MICROSOFT365_IDENTITY_REQUEST_INVALID');
    }
    headers[name] = value;
  }
  return headers;
}

function boundedRequestBody(options) {
  const body = options?.body ?? '';
  if (typeof body !== 'string' || Buffer.byteLength(body) > PROVIDER_REQUEST_MAX_BYTES) {
    throw new Microsoft365ProviderError('MICROSOFT365_IDENTITY_REQUEST_INVALID');
  }
  return body;
}

function boundedIdentityTimeout(requestedTimeoutMs, configuredTimeoutMs) {
  if (requestedTimeoutMs === undefined) return configuredTimeoutMs;
  if (!Number.isSafeInteger(requestedTimeoutMs) || requestedTimeoutMs < 1) {
    throw new Microsoft365ProviderError('MICROSOFT365_IDENTITY_TIMEOUT_INVALID');
  }
  return Math.min(requestedTimeoutMs, configuredTimeoutMs);
}

function createMsalApplication({
  clientId,
  clientSecret,
  tenantReference,
  fetchImpl,
  timeoutMs,
  totalDeadlineSignal = null,
  applicationFactory,
}) {
  const authority = `${LOGIN_ORIGIN}/${tenantReference}`;
  const networkClient = createBoundedMicrosoftIdentityNetworkClient({
    fetchImpl,
    timeoutMs,
    totalDeadlineSignal,
  });
  if (applicationFactory) {
    const application = applicationFactory({
      clientId,
      clientSecret,
      authority,
      networkClient,
    });
    if (!application || typeof application.acquireTokenByClientCredential !== 'function') {
      throw new TypeError('MICROSOFT365_MSAL_APPLICATION_INVALID');
    }
    return application;
  }
  return new ConfidentialClientApplication({
    auth: { clientId, clientSecret, authority },
    system: {
      networkClient,
      loggerOptions: {
        piiLoggingEnabled: false,
        loggerCallback: () => {},
      },
    },
  });
}

function classifyGraphStatus(status) {
  if (status === 401) return 'revoked';
  if (status === 403) return 'permission_missing';
  if (status === 429 || status >= 500) return 'transient';
  if (status === 404) return 'not_found';
  if (status === 409 || status === 412) return 'conflict';
  return status >= 200 && status < 300 ? 'ok' : 'invalid';
}

async function cancelReader(reader) {
  try {
    await reader.cancel();
  } catch {
    // Cancellation is best-effort after the response has already failed validation.
  }
}

async function readBoundedText(response, maxBytes) {
  const length = response.headers?.get?.('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) {
    throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_TOO_LARGE');
  }

  const reader = response.body?.getReader?.();
  if (!reader || typeof reader.read !== 'function') {
    throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_INVALID');
  }

  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      let result;
      try {
        result = await reader.read();
      } catch {
        throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_INVALID');
      }
      if (!result || typeof result.done !== 'boolean') {
        throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_INVALID');
      }
      if (result.done) break;
      if (!(result.value instanceof Uint8Array)) {
        throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_INVALID');
      }
      bytes += result.value.byteLength;
      if (bytes > maxBytes) {
        await cancelReader(reader);
        throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_TOO_LARGE');
      }
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

async function readBoundedJson(response, maxBytes = PROVIDER_RESPONSE_MAX_BYTES) {
  let text;
  try {
    text = await readBoundedText(response, maxBytes);
  } catch (error) {
    if (error instanceof Microsoft365ProviderError) throw error;
    throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_INVALID');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_INVALID');
  }
}

function boundedResponseHeaders(response) {
  if (!response.headers || typeof response.headers.forEach !== 'function') {
    throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_INVALID');
  }
  const headers = {};
  let count = 0;
  response.headers.forEach((value, name) => {
    count += 1;
    if (
      count > PROVIDER_HEADER_COUNT_MAX
      || name.length < 1
      || name.length > PROVIDER_HEADER_NAME_MAX
      || value.length > PROVIDER_HEADER_VALUE_MAX
      || /[\r\n]/.test(name)
      || /[\r\n]/.test(value)
    ) {
      throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_INVALID');
    }
    headers[name] = value;
  });
  return headers;
}

async function fetchMicrosoftIdentity({
  fetchImpl,
  value,
  method,
  options,
  timeoutMs,
  totalDeadlineSignal,
}) {
  const url = requireMicrosoftIdentityUrl(value);
  if (method === 'GET' && options?.body !== undefined) {
    throw new Microsoft365ProviderError('MICROSOFT365_IDENTITY_REQUEST_INVALID');
  }
  let response;
  const signal = totalDeadlineSignal ?? AbortSignal.timeout(timeoutMs);
  if (!(signal instanceof AbortSignal) || signal.aborted) {
    throw new Microsoft365ProviderError('MICROSOFT365_IDENTITY_UNAVAILABLE');
  }
  try {
    response = await fetchImpl(url, {
      method,
      redirect: 'error',
      headers: boundedRequestHeaders(options),
      body: method === 'POST' ? boundedRequestBody(options) : undefined,
      signal,
    });
  } catch (error) {
    if (error instanceof Microsoft365ProviderError) throw error;
    throw new Microsoft365ProviderError('MICROSOFT365_IDENTITY_UNAVAILABLE');
  }
  if (!response || !Number.isInteger(response.status)) {
    throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_INVALID');
  }
  return {
    headers: boundedResponseHeaders(response),
    body: await readBoundedJson(response),
    status: response.status,
  };
}

function createBoundedMicrosoftIdentityNetworkClient({
  fetchImpl,
  timeoutMs,
  totalDeadlineSignal = null,
}) {
  return Object.freeze({
    sendGetRequestAsync(value, options, requestedTimeoutMs) {
      return fetchMicrosoftIdentity({
        fetchImpl,
        value,
        method: 'GET',
        options,
        timeoutMs: boundedIdentityTimeout(requestedTimeoutMs, timeoutMs),
        totalDeadlineSignal,
      });
    },
    sendPostRequestAsync(value, options) {
      return fetchMicrosoftIdentity({
        fetchImpl,
        value,
        method: 'POST',
        options,
        timeoutMs,
        totalDeadlineSignal,
      });
    },
  });
}

async function validGraphPayload(response, validate) {
  try {
    return validate(await readBoundedJson(response));
  } catch (error) {
    if (error instanceof Microsoft365ProviderError) return false;
    throw error;
  }
}

function validCollectionPayload(payload) {
  return payload
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && Array.isArray(payload.value)
    && payload.value.length <= 100
    && payload.value.every((item) => item
      && typeof item === 'object'
      && !Array.isArray(item)
      && typeof item.id === 'string'
      && item.id.length >= 1
      && item.id.length <= 512);
}

function validCalendarPayload(payload) {
  return payload
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && typeof payload.id === 'string'
    && payload.id.length >= 1
    && payload.id.length <= EVENT_REFERENCE_MAX;
}

async function fetchGraph(fetchImpl, url, accessToken, timeoutMs, totalDeadlineSignal = null) {
  if (url.origin !== GRAPH_ORIGIN) {
    throw new Microsoft365ProviderError('MICROSOFT365_GRAPH_ORIGIN_INVALID');
  }
  let response;
  const signal = totalDeadlineSignal ?? AbortSignal.timeout(timeoutMs);
  if (!(signal instanceof AbortSignal) || signal.aborted) {
    throw new Microsoft365ProviderError('MICROSOFT365_GRAPH_UNAVAILABLE');
  }
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      signal,
    });
  } catch {
    throw new Microsoft365ProviderError('MICROSOFT365_GRAPH_UNAVAILABLE');
  }
  if (!response || !Number.isInteger(response.status)) {
    throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_INVALID');
  }
  return response;
}

async function graphJsonRequest({ fetchImpl, url, accessToken, timeoutMs, method, payload, preferUtc = false }) {
  if (url.origin !== GRAPH_ORIGIN) {
    throw new Microsoft365ProviderError('MICROSOFT365_GRAPH_ORIGIN_INVALID');
  }
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > PROVIDER_REQUEST_MAX_BYTES) {
    throw new Microsoft365ProviderError('MICROSOFT365_GRAPH_REQUEST_INVALID');
  }
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
  if (preferUtc) headers.Prefer = 'outlook.timezone="UTC"';
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      redirect: 'error',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Microsoft365ProviderError('MICROSOFT365_GRAPH_UNAVAILABLE');
  }
  if (!response || !Number.isInteger(response.status)) {
    throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_INVALID');
  }
  return response;
}

async function graphDeleteRequest({ fetchImpl, url, accessToken, timeoutMs }) {
  if (url.origin !== GRAPH_ORIGIN) {
    throw new Microsoft365ProviderError('MICROSOFT365_GRAPH_ORIGIN_INVALID');
  }
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'DELETE',
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Microsoft365ProviderError('MICROSOFT365_GRAPH_UNAVAILABLE');
  }
  if (!response || !Number.isInteger(response.status)) {
    throw new Microsoft365ProviderError('MICROSOFT365_RESPONSE_INVALID');
  }
  return response;
}

function boundedOptionalString(value) {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== 'string'
    || value.length > ROOM_STRING_MAX
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return null;
  }
  return value;
}

function boundedRequiredString(value, max, min = 1) {
  if (
    typeof value !== 'string'
    || value.length < min
    || value.length > max
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    return null;
  }
  return value;
}

function boundedCapacity(value) {
  if (value === null || value === undefined) return null;
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000
    ? value
    : null;
}

function boundedFloorNumber(value) {
  if (value === null || value === undefined) return null;
  return Number.isSafeInteger(value) && Math.abs(value) <= 10_000
    ? value
    : null;
}

function normalizeRoom(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new Microsoft365ProviderError('MICROSOFT365_ROOM_RESPONSE_INVALID');
  }
  const externalRoomId = boundedRequiredString(item.id, ROOM_STRING_MAX);
  const displayName = boundedRequiredString(item.displayName, ROOM_STRING_MAX);
  const resourceAddress = boundedRequiredString(item.emailAddress, ROOM_RESOURCE_MAX, 3);
  if (!externalRoomId || !displayName || !resourceAddress) {
    throw new Microsoft365ProviderError('MICROSOFT365_ROOM_RESPONSE_INVALID');
  }
  return Object.freeze({
    externalRoomId,
    displayName,
    resourceAddress,
    capacity: boundedCapacity(item.capacity),
    building: boundedOptionalString(item.building),
    floorNumber: boundedFloorNumber(item.floorNumber),
    floorLabel: boundedOptionalString(item.floorLabel),
    label: boundedOptionalString(item.label),
    nickname: boundedOptionalString(item.nickname),
    phone: boundedOptionalString(item.phone),
    audioDeviceName: boundedOptionalString(item.audioDeviceName),
    videoDeviceName: boundedOptionalString(item.videoDeviceName),
    displayDeviceName: boundedOptionalString(item.displayDeviceName),
    bookingType: boundedOptionalString(item.bookingType),
  });
}

function roomDiscoveryUrl() {
  const url = new URL('/v1.0/places/microsoft.graph.room', GRAPH_ORIGIN);
  url.searchParams.set('$top', String(ROOM_PAGE_SIZE));
  url.searchParams.set('$skip', '0');
  url.searchParams.set('$select', ROOM_SELECT);
  return url;
}

function requireRoomNextLink(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > PROVIDER_URL_MAX_LENGTH) {
    throw new Microsoft365ProviderError('MICROSOFT365_ROOM_RESPONSE_INVALID');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Microsoft365ProviderError('MICROSOFT365_ROOM_RESPONSE_INVALID');
  }
  if (
    url.origin !== GRAPH_ORIGIN
    || url.pathname !== '/v1.0/places/microsoft.graph.room'
    || url.username
    || url.password
    || url.hash
    || url.href.length > PROVIDER_URL_MAX_LENGTH
  ) {
    throw new Microsoft365ProviderError('MICROSOFT365_ROOM_RESPONSE_INVALID');
  }
  const keys = [...url.searchParams.keys()];
  const allowed = new Set(['$top', '$select', '$skip', '$skiptoken']);
  if (keys.some((key) => !allowed.has(key))) {
    throw new Microsoft365ProviderError('MICROSOFT365_ROOM_RESPONSE_INVALID');
  }
  const top = url.searchParams.getAll('$top');
  const select = url.searchParams.getAll('$select');
  const skips = url.searchParams.getAll('$skip');
  const skipTokens = url.searchParams.getAll('$skiptoken');
  const skip = skips.length === 1 && /^\d+$/.test(skips[0]) ? Number(skips[0]) : null;
  if (
    top.length !== 1
    || top[0] !== String(ROOM_PAGE_SIZE)
    || select.length !== 1
    || select[0] !== ROOM_SELECT
    || (skips.length === 1) === (skipTokens.length === 1)
    || skips.length > 1
    || skipTokens.length > 1
    || skips.length === 1 && (!Number.isSafeInteger(skip) || skip < 1)
    || skipTokens.length === 1 && skipTokens[0].length < 1
  ) {
    throw new Microsoft365ProviderError('MICROSOFT365_ROOM_RESPONSE_INVALID');
  }
  return url;
}

async function roomPage({ fetchImpl, accessToken, timeoutMs, totalDeadlineSignal, url }) {
  const response = await fetchGraph(
    fetchImpl,
    url,
    accessToken,
    timeoutMs,
    totalDeadlineSignal,
  );
  const classification = classifyGraphStatus(response.status);
  if (classification === 'revoked') {
    throw new Microsoft365ProviderError('MICROSOFT365_GRAPH_UNAUTHORIZED');
  }
  if (classification === 'permission_missing') {
    throw new Microsoft365ProviderError('MICROSOFT365_GRAPH_PERMISSION_MISSING');
  }
  if (response.status === 429) {
    throw new Microsoft365ProviderError('MICROSOFT365_GRAPH_THROTTLED');
  }
  if (classification === 'transient') {
    throw new Microsoft365ProviderError('MICROSOFT365_GRAPH_UNAVAILABLE');
  }
  if (response.status !== 200) {
    throw new Microsoft365ProviderError('MICROSOFT365_ROOM_RESPONSE_INVALID');
  }
  const payload = await readBoundedJson(response);
  if (
    !payload
    || typeof payload !== 'object'
    || Array.isArray(payload)
    || !Array.isArray(payload.value)
    || payload.value.length > ROOM_PAGE_SIZE
  ) {
    throw new Microsoft365ProviderError('MICROSOFT365_ROOM_RESPONSE_INVALID');
  }
  const nextLink = Object.hasOwn(payload, '@odata.nextLink')
    ? requireRoomNextLink(payload['@odata.nextLink'])
    : null;
  return Object.freeze({
    values: Object.freeze(payload.value.map(normalizeRoom)),
    nextLink,
  });
}

function roomCollectionBytes(rooms) {
  let bytes = 0;
  for (const room of rooms) {
    bytes += Buffer.byteLength(JSON.stringify(room), 'utf8') + 1;
  }
  return bytes;
}

function requireFreeBusySchedules(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > FREE_BUSY_SCHEDULE_LIMIT) {
    throw new Microsoft365ProviderError('MICROSOFT365_FREE_BUSY_REQUEST_INVALID');
  }
  const seen = new Set();
  return Object.freeze(value.map((schedule) => {
    if (
      typeof schedule !== 'string'
      || schedule.length < 3
      || schedule.length > FREE_BUSY_SCHEDULE_MAX
      || schedule.trim() !== schedule
      || /[\u0000-\u001f\u007f]/.test(schedule)
    ) {
      throw new Microsoft365ProviderError('MICROSOFT365_FREE_BUSY_REQUEST_INVALID');
    }
    const key = schedule.toLowerCase();
    if (seen.has(key)) throw new Microsoft365ProviderError('MICROSOFT365_FREE_BUSY_REQUEST_INVALID');
    seen.add(key);
    return schedule;
  }));
}

function requireFreeBusyWindow(startsAt, endsAt) {
  if (
    typeof startsAt !== 'string'
    || typeof endsAt !== 'string'
    || !UTC_ISO_PATTERN.test(startsAt)
    || !UTC_ISO_PATTERN.test(endsAt)
  ) {
    throw new Microsoft365ProviderError('MICROSOFT365_FREE_BUSY_REQUEST_INVALID');
  }
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > FREE_BUSY_MAX_WINDOW_MS) {
    throw new Microsoft365ProviderError('MICROSOFT365_FREE_BUSY_REQUEST_INVALID');
  }
  return Object.freeze({
    startsAt: new Date(start),
    endsAt: new Date(end),
  });
}

function graphUtcDateTime(value) {
  return value.toISOString().replace(/Z$/, '');
}

function normalizeFreeBusyPayload(payload, schedules, expectedSlots) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.value)) {
    throw new Microsoft365ProviderError('MICROSOFT365_FREE_BUSY_RESPONSE_INVALID');
  }
  if (payload.value.length !== schedules.length) {
    throw new Microsoft365ProviderError('MICROSOFT365_FREE_BUSY_RESPONSE_INVALID');
  }
  return Object.freeze(payload.value.map((item, index) => {
    const expectedSchedule = schedules[index];
    if (
      !item
      || typeof item !== 'object'
      || Array.isArray(item)
      || typeof item.scheduleId !== 'string'
      || item.scheduleId.toLowerCase() !== expectedSchedule.toLowerCase()
      || item.error !== undefined && item.error !== null
      || typeof item.availabilityView !== 'string'
      || item.availabilityView.length !== expectedSlots
      || !/^[0-4]+$/.test(item.availabilityView)
    ) {
      throw new Microsoft365ProviderError('MICROSOFT365_FREE_BUSY_RESPONSE_INVALID');
    }
    const available = !/[1-4]/.test(item.availabilityView);
    return Object.freeze({
      schedule: expectedSchedule,
      available,
      conflictCount: available ? 0 : 1,
    });
  }));
}

async function freeBusy({ fetchImpl, accessToken, timeoutMs, schedules, startsAt, endsAt }) {
  const window = requireFreeBusyWindow(startsAt, endsAt);
  const expectedSlots = Math.ceil(
    (window.endsAt.getTime() - window.startsAt.getTime())
      / (FREE_BUSY_INTERVAL_MINUTES * 60 * 1_000),
  );
  if (expectedSlots < 1 || expectedSlots > FREE_BUSY_VIEW_MAX) {
    throw new Microsoft365ProviderError('MICROSOFT365_FREE_BUSY_REQUEST_INVALID');
  }
  const normalizedSchedules = requireFreeBusySchedules(schedules);
  const url = new URL(
    `/v1.0/users/${encodeURIComponent(normalizedSchedules[0])}/calendar/getSchedule`,
    GRAPH_ORIGIN,
  );
  const response = await graphJsonRequest({
    fetchImpl,
    url,
    accessToken,
    timeoutMs,
    method: 'POST',
    payload: {
      schedules: normalizedSchedules,
      startTime: { dateTime: graphUtcDateTime(window.startsAt), timeZone: 'UTC' },
      endTime: { dateTime: graphUtcDateTime(window.endsAt), timeZone: 'UTC' },
      availabilityViewInterval: FREE_BUSY_INTERVAL_MINUTES,
    },
    preferUtc: true,
  });
  const classification = classifyGraphStatus(response.status);
  if (classification === 'revoked') throw new Microsoft365ProviderError('MICROSOFT365_GRAPH_UNAUTHORIZED');
  if (classification === 'permission_missing') {
    throw new Microsoft365ProviderError('MICROSOFT365_GRAPH_PERMISSION_MISSING');
  }
  if (response.status === 429) throw new Microsoft365ProviderError('MICROSOFT365_GRAPH_THROTTLED');
  if (classification === 'transient') throw new Microsoft365ProviderError('MICROSOFT365_GRAPH_UNAVAILABLE');
  if (response.status !== 200) throw new Microsoft365ProviderError('MICROSOFT365_FREE_BUSY_RESPONSE_INVALID');
  return normalizeFreeBusyPayload(
    await readBoundedJson(response),
    normalizedSchedules,
    expectedSlots,
  );
}

function requireResourceAddress(value) {
  const schedules = requireFreeBusySchedules([value]);
  return schedules[0];
}

function requireCalendarWindow(startsAt, endsAt) {
  const window = requireFreeBusyWindow(startsAt, endsAt);
  return Object.freeze({
    startTime: { dateTime: graphUtcDateTime(window.startsAt), timeZone: 'UTC' },
    endTime: { dateTime: graphUtcDateTime(window.endsAt), timeZone: 'UTC' },
  });
}

function requireProviderReference(value) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > EVENT_REFERENCE_MAX
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Microsoft365ProviderError('MICROSOFT365_CALENDAR_REFERENCE_INVALID');
  }
  return value;
}

function requireIdempotencyKey(value) {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new Microsoft365ProviderError('MICROSOFT365_CALENDAR_IDEMPOTENCY_INVALID');
  }
  return value;
}

function calendarEventUrl(resourceAddress, providerReference = null) {
  const address = requireResourceAddress(resourceAddress);
  const path = providerReference === null
    ? `/v1.0/users/${encodeURIComponent(address)}/calendar/events`
    : `/v1.0/users/${encodeURIComponent(address)}/events/${encodeURIComponent(requireProviderReference(providerReference))}`;
  return new URL(path, GRAPH_ORIGIN);
}

function calendarEventPayload({ startsAt, endsAt, idempotencyKey = null }) {
  const window = requireCalendarWindow(startsAt, endsAt);
  const payload = {
    subject: CALENDAR_EVENT_SUBJECT,
    start: window.startTime,
    end: window.endTime,
    showAs: 'busy',
  };
  if (idempotencyKey !== null) payload.transactionId = requireIdempotencyKey(idempotencyKey);
  return payload;
}

function calendarWriteErrorFor(response, invalidResponseCode = 'MICROSOFT365_CALENDAR_WRITE_RESPONSE_INVALID') {
  const classification = classifyGraphStatus(response.status);
  if (classification === 'revoked') return 'MICROSOFT365_GRAPH_UNAUTHORIZED';
  if (classification === 'permission_missing') return 'MICROSOFT365_GRAPH_PERMISSION_MISSING';
  if (response.status === 429) return 'MICROSOFT365_GRAPH_THROTTLED';
  if (classification === 'transient') return 'MICROSOFT365_GRAPH_UNAVAILABLE';
  if (classification === 'conflict') return 'MICROSOFT365_CALENDAR_CONFLICT';
  if (classification === 'not_found') return 'MICROSOFT365_CALENDAR_NOT_FOUND';
  return classification === 'ok' ? null : invalidResponseCode;
}

async function createCalendarEvent({ fetchImpl, accessToken, timeoutMs, resourceAddress, startsAt, endsAt, idempotencyKey }) {
  const response = await graphJsonRequest({
    fetchImpl,
    url: calendarEventUrl(resourceAddress),
    accessToken,
    timeoutMs,
    method: 'POST',
    payload: calendarEventPayload({ startsAt, endsAt, idempotencyKey }),
  });
  const code = calendarWriteErrorFor(response);
  if (code) throw new Microsoft365ProviderError(code);
  if (response.status !== 201) throw new Microsoft365ProviderError('MICROSOFT365_CALENDAR_WRITE_RESPONSE_INVALID');
  const payload = await readBoundedJson(response);
  if (!validCalendarPayload(payload)) {
    throw new Microsoft365ProviderError('MICROSOFT365_CALENDAR_WRITE_RESPONSE_INVALID');
  }
  return Object.freeze({ providerReference: payload.id, disposition: 'created' });
}

async function updateCalendarEvent({ fetchImpl, accessToken, timeoutMs, resourceAddress, providerReference, startsAt, endsAt }) {
  const expectedReference = requireProviderReference(providerReference);
  const response = await graphJsonRequest({
    fetchImpl,
    url: calendarEventUrl(resourceAddress, expectedReference),
    accessToken,
    timeoutMs,
    method: 'PATCH',
    payload: calendarEventPayload({ startsAt, endsAt }),
  });
  const code = calendarWriteErrorFor(response);
  if (code) throw new Microsoft365ProviderError(code);
  if (response.status !== 200) throw new Microsoft365ProviderError('MICROSOFT365_CALENDAR_WRITE_RESPONSE_INVALID');
  const payload = await readBoundedJson(response);
  if (!validCalendarPayload(payload) || payload.id !== expectedReference) {
    throw new Microsoft365ProviderError('MICROSOFT365_CALENDAR_WRITE_RESPONSE_INVALID');
  }
  return Object.freeze({ providerReference: expectedReference, disposition: 'updated' });
}

async function cancelCalendarEvent({ fetchImpl, accessToken, timeoutMs, resourceAddress, providerReference }) {
  const expectedReference = requireProviderReference(providerReference);
  const response = await graphDeleteRequest({
    fetchImpl,
    url: calendarEventUrl(resourceAddress, expectedReference),
    accessToken,
    timeoutMs,
  });
  if (response.status === 404) {
    return Object.freeze({ providerReference: expectedReference, disposition: 'already_cancelled' });
  }
  const code = calendarWriteErrorFor(response);
  if (code) throw new Microsoft365ProviderError(code);
  if (response.status !== 204) throw new Microsoft365ProviderError('MICROSOFT365_CALENDAR_WRITE_RESPONSE_INVALID');
  return Object.freeze({ providerReference: expectedReference, disposition: 'cancelled' });
}

function revoked(reason = 'provider_unauthorized', places = 'unknown') {
  return Object.freeze({
    status: MICROSOFT365_VERIFICATION.REVOKED,
    places,
    calendars: 'unknown',
    reason,
  });
}

function degraded({ places = 'unknown', calendars = 'unknown', reason }) {
  return Object.freeze({
    status: MICROSOFT365_VERIFICATION.DEGRADED,
    places,
    calendars,
    reason,
  });
}

function isValidCallbackOrigin(origin, allowInsecureLocalhost) {
  if (
    origin.username
    || origin.password
    || origin.pathname !== '/'
    || origin.search
    || origin.hash
  ) {
    return false;
  }
  if (origin.protocol === 'https:') return true;
  return allowInsecureLocalhost === true
    && origin.protocol === 'http:'
    && LOCAL_HOSTS.has(origin.hostname);
}

export function createMicrosoft365Client({
  clientId,
  clientSecret,
  publicOrigin,
  fetchImpl = globalThis.fetch,
  applicationFactory,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  allowInsecureLocalhost = false,
} = {}) {
  const normalizedClientId = requireGuid(
    clientId,
    'MICROSOFT365_CLIENT_ID_INVALID',
  );
  if (typeof clientSecret !== 'string' || clientSecret.length < 1) {
    throw new TypeError('MICROSOFT365_CLIENT_SECRET_REQUIRED');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('MICROSOFT365_FETCH_REQUIRED');
  if (typeof allowInsecureLocalhost !== 'boolean') {
    throw new TypeError('MICROSOFT365_LOCALHOST_MODE_INVALID');
  }
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1_000
    || timeoutMs > 30_000
  ) {
    throw new TypeError('MICROSOFT365_TIMEOUT_INVALID');
  }

  let origin;
  try {
    origin = new URL(publicOrigin);
  } catch {
    throw new TypeError('MICROSOFT365_PUBLIC_ORIGIN_INVALID');
  }
  if (!isValidCallbackOrigin(origin, allowInsecureLocalhost)) {
    throw new TypeError('MICROSOFT365_PUBLIC_ORIGIN_INVALID');
  }
  const redirectUri = new URL(
    '/api/v1/integrations/microsoft365/callback',
    origin,
  ).toString();

  async function acquireAccessToken(tenantReference, totalDeadlineSignal = null) {
    const tenant = requireGuid(
      tenantReference,
      'MICROSOFT365_TENANT_INVALID',
    );
    const application = createMsalApplication({
      clientId: normalizedClientId,
      clientSecret,
      tenantReference: tenant,
      fetchImpl,
      timeoutMs,
      totalDeadlineSignal,
      applicationFactory,
    });
    let result;
    try {
      result = await application.acquireTokenByClientCredential({
        scopes: [GRAPH_SCOPE],
      });
    } catch {
      throw new Microsoft365ProviderError('MICROSOFT365_TOKEN_ACQUISITION_FAILED');
    }
    if (!validAccessToken(result?.accessToken)) {
      throw new Microsoft365ProviderError('MICROSOFT365_TOKEN_INVALID');
    }
    return result.accessToken;
  }

  return Object.freeze({
    redirectUri,

    adminConsentUrl({ tenantReference, state }) {
      const tenant = requireGuid(
        tenantReference,
        'MICROSOFT365_TENANT_INVALID',
      );
      const url = new URL(`${LOGIN_ORIGIN}/${tenant}${CONSENT_PATH_SUFFIX}`);
      url.searchParams.set('client_id', normalizedClientId);
      url.searchParams.set('scope', GRAPH_SCOPE);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', requireState(state));
      return url.toString();
    },

    async discoverRooms({ tenantReference }) {
      const tenant = requireGuid(
        tenantReference,
        'MICROSOFT365_TENANT_INVALID',
      );
      const totalDeadlineSignal = AbortSignal.timeout(timeoutMs);
      const accessToken = await acquireAccessToken(tenant, totalDeadlineSignal);
      if (totalDeadlineSignal.aborted) {
        throw new Microsoft365ProviderError('MICROSOFT365_GRAPH_UNAVAILABLE');
      }
      const rooms = [];
      let materializedBytes = 2;
      let url = roomDiscoveryUrl();
      const visited = new Set();
      const externalRoomIds = new Set();
      const resourceAddresses = new Set();
      for (let page = 0; page < ROOM_PAGE_LIMIT; page += 1) {
        const href = url.toString();
        if (visited.has(href)) {
          throw new Microsoft365ProviderError('MICROSOFT365_ROOM_RESPONSE_INVALID');
        }
        visited.add(href);
        const { values, nextLink } = await roomPage({
          fetchImpl,
          accessToken,
          timeoutMs,
          totalDeadlineSignal,
          url,
        });
        for (const room of values) {
          const externalRoomKey = room.externalRoomId.toLowerCase();
          const resourceAddressKey = room.resourceAddress.toLowerCase();
          if (externalRoomIds.has(externalRoomKey) || resourceAddresses.has(resourceAddressKey)) {
            throw new Microsoft365ProviderError('MICROSOFT365_ROOM_RESPONSE_INVALID');
          }
          externalRoomIds.add(externalRoomKey);
          resourceAddresses.add(resourceAddressKey);
        }
        const nextSize = rooms.length + values.length;
        const nextBytes = materializedBytes + roomCollectionBytes(values);
        if (nextSize > ROOM_COLLECTION_LIMIT || nextBytes > ROOM_COLLECTION_MAX_BYTES) {
          throw new Microsoft365ProviderError('MICROSOFT365_ROOM_COLLECTION_LIMIT_EXCEEDED');
        }
        rooms.push(...values);
        materializedBytes = nextBytes;
        if (!nextLink) return Object.freeze(rooms);
        if (rooms.length >= ROOM_COLLECTION_LIMIT) {
          throw new Microsoft365ProviderError('MICROSOFT365_ROOM_COLLECTION_LIMIT_EXCEEDED');
        }
        url = nextLink;
      }
      throw new Microsoft365ProviderError(
        'MICROSOFT365_ROOM_PAGE_LIMIT_EXCEEDED',
      );
    },

    async lookupFreeBusy({ tenantReference, schedules, startsAt, endsAt }) {
      const tenant = requireGuid(tenantReference, 'MICROSOFT365_TENANT_INVALID');
      const accessToken = await acquireAccessToken(tenant);
      return freeBusy({
        fetchImpl,
        accessToken,
        timeoutMs,
        schedules,
        startsAt,
        endsAt,
      });
    },

    async createCalendarEvent({ tenantReference, resourceAddress, startsAt, endsAt, idempotencyKey }) {
      const tenant = requireGuid(tenantReference, 'MICROSOFT365_TENANT_INVALID');
      const accessToken = await acquireAccessToken(tenant);
      return createCalendarEvent({
        fetchImpl,
        accessToken,
        timeoutMs,
        resourceAddress,
        startsAt,
        endsAt,
        idempotencyKey,
      });
    },

    async updateCalendarEvent({ tenantReference, resourceAddress, providerReference, startsAt, endsAt }) {
      const tenant = requireGuid(tenantReference, 'MICROSOFT365_TENANT_INVALID');
      const accessToken = await acquireAccessToken(tenant);
      return updateCalendarEvent({
        fetchImpl,
        accessToken,
        timeoutMs,
        resourceAddress,
        providerReference,
        startsAt,
        endsAt,
      });
    },

    async cancelCalendarEvent({ tenantReference, resourceAddress, providerReference }) {
      const tenant = requireGuid(tenantReference, 'MICROSOFT365_TENANT_INVALID');
      const accessToken = await acquireAccessToken(tenant);
      return cancelCalendarEvent({
        fetchImpl,
        accessToken,
        timeoutMs,
        resourceAddress,
        providerReference,
      });
    },

    async verifyBasePermissions({
      tenantReference,
      claimantUserReference = null,
    }) {
      const tenant = requireGuid(
        tenantReference,
        'MICROSOFT365_TENANT_INVALID',
      );
      let accessToken;
      try {
        accessToken = await acquireAccessToken(tenant);
      } catch (error) {
        if (
          error instanceof Microsoft365ProviderError
          && error.code === 'MICROSOFT365_TOKEN_INVALID'
        ) {
          return revoked('token_invalid');
        }
        if (error instanceof Microsoft365ProviderError) {
          return degraded({ reason: 'provider_unavailable' });
        }
        throw error;
      }

      const placesUrl = new URL(
        '/v1.0/places/microsoft.graph.room',
        GRAPH_ORIGIN,
      );
      placesUrl.searchParams.set('$top', '1');
      placesUrl.searchParams.set('$select', 'id');
      let placesResponse;
      try {
        placesResponse = await fetchGraph(
          fetchImpl,
          placesUrl,
          accessToken,
          timeoutMs,
        );
      } catch (error) {
        if (error instanceof Microsoft365ProviderError) {
          return degraded({ reason: 'provider_unavailable' });
        }
        throw error;
      }
      const placesClass = classifyGraphStatus(placesResponse.status);
      if (placesClass === 'revoked') return revoked();
      if (placesClass === 'transient') {
        return degraded({ reason: 'provider_unavailable' });
      }
      if (placesClass === 'permission_missing') {
        return degraded({
          places: 'missing',
          reason: 'places_permission_missing',
        });
      }
      if (
        placesResponse.status !== 200
        || !await validGraphPayload(placesResponse, validCollectionPayload)
      ) {
        return degraded({ reason: 'provider_response_invalid' });
      }

      if (claimantUserReference === null) {
        return degraded({
          places: 'granted',
          calendars: 'unverified',
          reason: 'calendars_permission_unverified',
        });
      }

      const claimant = requireGuid(
        claimantUserReference,
        'MICROSOFT365_USER_INVALID',
      );
      const calendarUrl = new URL(
        `/v1.0/users/${claimant}/calendar`,
        GRAPH_ORIGIN,
      );
      calendarUrl.searchParams.set('$select', 'id');
      let calendarResponse;
      try {
        calendarResponse = await fetchGraph(
          fetchImpl,
          calendarUrl,
          accessToken,
          timeoutMs,
        );
      } catch (error) {
        if (error instanceof Microsoft365ProviderError) {
          return degraded({
            places: 'granted',
            reason: 'provider_unavailable',
          });
        }
        throw error;
      }
      const calendarClass = classifyGraphStatus(calendarResponse.status);
      if (calendarClass === 'revoked') {
        return revoked('provider_unauthorized', 'granted');
      }
      if (calendarClass === 'permission_missing') {
        return degraded({
          places: 'granted',
          calendars: 'missing',
          reason: 'calendars_permission_missing',
        });
      }
      if (calendarClass === 'transient') {
        return degraded({
          places: 'granted',
          reason: 'provider_unavailable',
        });
      }
      if (calendarClass === 'not_found') {
        return degraded({
          places: 'granted',
          calendars: 'unverified',
          reason: 'calendars_permission_unverified',
        });
      }
      if (
        calendarResponse.status !== 200
        || !await validGraphPayload(calendarResponse, validCalendarPayload)
      ) {
        return degraded({
          places: 'granted',
          reason: 'provider_response_invalid',
        });
      }
      return Object.freeze({
        status: MICROSOFT365_VERIFICATION.CONNECTED,
        places: 'granted',
        calendars: 'granted',
        reason: null,
      });
    },
  });
}
