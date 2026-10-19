import { isInternalUuid } from './identifiers.js';
import { capabilityForCateringOrderOperation } from './catering-order-state.js';
import { cateringOrderStateFromReceipt } from './catering-receipt-state.js';
import { normalizeCateringReceipt } from './catering-receipt.js';

const CHANNELS = ['email','telephone','portal','in_person','other'];
function invalid() { throw new TypeError('CATERING_MANUAL_VALUE_INVALID'); }
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return !keys.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value');
  })) invalid();
}
function uuid(value) { if (!isInternalUuid(value)) invalid(); return value.toLowerCase(); }
function positive(value, maximum = Number.MAX_SAFE_INTEGER - 1) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) invalid();
  return value;
}
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid();
  return value;
}
function details(value) {
  if (!['transmitted','receipt'].includes(value.kind) || !CHANNELS.includes(value.channel)
    || typeof value.reference !== 'string' || value.reference.trim() !== value.reference
    || !/^[A-Za-z0-9][A-Za-z0-9 ._/#-]{0,199}$/u.test(value.reference)) invalid();
  instant(value.occurredAt);
  return { kind: value.kind, channel: value.channel, reference: value.reference, occurredAt: value.occurredAt };
}
function receipt(value, kind, orderId, orderVersion) {
  if (kind === 'transmitted') { if (value !== null) invalid(); return null; }
  record(value, ['orderId','orderVersion','positions']);
  const positions = value.positions;
  if (!Array.isArray(positions) || Object.getPrototypeOf(positions) !== Array.prototype || positions.length < 1
    || positions.length > 101 || Reflect.ownKeys(positions).length !== positions.length + 1) invalid();
  const positionIds = [];
  for (let index = 0; index < positions.length; index++) {
    const property = Object.getOwnPropertyDescriptor(positions, String(index));
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) invalid();
    record(property.value, ['positionId','outcome']);
    positionIds.push(uuid(property.value.positionId));
  }
  // Structural validation only. The repository must normalize again against
  // independently loaded sealed position IDs before persisting an external fact.
  const normalized = normalizeCateringReceipt(value, { orderId, orderVersion, positionIds });
  const { counts: _counts, ...result } = normalized;
  return Object.freeze(result);
}

export function normalizeCateringManualCommand(value, { orderId } = {}) {
  record(value, ['schemaVersion','commandId','expectedOrderVersion','expectedStateRevision',
    'kind','channel','reference','occurredAt','receipt']);
  if (value.schemaVersion !== 1) invalid();
  const id = uuid(orderId); const version = positive(value.expectedOrderVersion);
  return Object.freeze({ schemaVersion: 1, orderId: id, commandId: uuid(value.commandId), expectedOrderVersion: version,
    expectedStateRevision: positive(value.expectedStateRevision, Number.MAX_SAFE_INTEGER - 2), ...details(value),
    receipt: receipt(value.receipt, value.kind, id, version) });
}

export function normalizeCateringManualFact(value, { tenantId, orderId, orderVersion } = {}) {
  record(value, ['tenantId','orderId','orderVersion','sequence','commandId','originStateRevision','kind','channel','reference',
    'occurredAt','recordedAt','actorUserId','actorSecurityVersion','quoteRevision','decisionSequence','operation','status','receipt']);
  const tenant = uuid(tenantId); const id = uuid(orderId); const version = positive(orderVersion);
  if (value.tenantId !== tenant || value.orderId !== id || value.orderVersion !== version) invalid();
  capabilityForCateringOrderOperation(value.operation);
  const normalizedReceipt = receipt(value.receipt, value.kind, id, version);
  const normalized = normalizedReceipt === null ? null : normalizeCateringReceipt(normalizedReceipt, {
    orderId: id, orderVersion: version, positionIds: normalizedReceipt.positions.map((position) => position.positionId),
  });
  const status = normalized === null ? 'transmitted' : cateringOrderStateFromReceipt({ operation: value.operation,
    positionCount: normalized.positions.length, counts: normalized.counts });
  if (value.status !== status || instant(value.recordedAt) < instant(value.occurredAt)) invalid();
  return Object.freeze({ tenantId: tenant, orderId: id, orderVersion: version, sequence: positive(value.sequence),
    commandId: uuid(value.commandId), originStateRevision: positive(value.originStateRevision, Number.MAX_SAFE_INTEGER - 2),
    ...details(value), recordedAt: value.recordedAt, actorUserId: uuid(value.actorUserId),
    actorSecurityVersion: positive(value.actorSecurityVersion),
    quoteRevision: positive(value.quoteRevision), decisionSequence: positive(value.decisionSequence), operation: value.operation,
    status, receipt: normalizedReceipt });
}
