import { isRequestId } from './request.js';
import { isInternalUuid } from './identifiers.js';

function invalid() { throw new TypeError('CATERING_VERSION_PROPOSAL_INVALID'); }
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return !keys.includes(key) || !property.enumerable || !Object.hasOwn(property, 'value');
  })) invalid();
}
function positive(value, maximum = Number.MAX_SAFE_INTEGER - 1) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) invalid();
  return value;
}
function uuid(value) { if (!isInternalUuid(value)) invalid(); return value.toLowerCase(); }

export function normalizeCateringVersionCommand(value, { orderId } = {}) {
  record(value, ['schemaVersion','commandId','expectedOrderVersion','expectedStateRevision',
    'expectedRequestVersion','expectedAssignmentRevision','operation','justification']);
  if (value.schemaVersion !== 1 || !['change','cancel','exception'].includes(value.operation)
    || typeof value.justification !== 'string' || value.justification.length < 1 || value.justification.length > 1000
    || value.justification.trim() !== value.justification || /[\u0000-\u001f\u007f]/u.test(value.justification)) invalid();
  return Object.freeze({ schemaVersion: 1, orderId: uuid(orderId), commandId: uuid(value.commandId),
    expectedOrderVersion: positive(value.expectedOrderVersion, Number.MAX_SAFE_INTEGER - 2),
    expectedStateRevision: positive(value.expectedStateRevision), expectedRequestVersion: positive(value.expectedRequestVersion),
    expectedAssignmentRevision: positive(value.expectedAssignmentRevision), operation: value.operation,
    justification: value.justification });
}

// Necessary progression over independently loaded persisted evidence only.
// This never authorizes a user, approves a cost or creates/cancels a supplier order.
// Requiring justification for every proposal also covers unknown supplier cutoffs;
// it does not infer an accepted normal-change window from missing supplier data.
export function cateringVersionProposalBasis(value) {
  record(value, ['operation','headVersion','headStatus','effective','currentRequestVersion','currentRequestStatus',
    'effectiveRequestVersion','effectiveAssignmentRevision']);
  if (!['change','cancel','exception'].includes(value.operation)
    || !['Confirmed','Cancelled'].includes(value.currentRequestStatus)) invalid();
  const head = positive(value.headVersion, Number.MAX_SAFE_INTEGER - 2);
  const request = positive(value.currentRequestVersion);
  const basisRequest = positive(value.effectiveRequestVersion);
  const assignment = positive(value.effectiveAssignmentRevision);
  if (value.effective === null) return Object.freeze({ eligible: false, reason: 'confirmed_order_required' });
  record(value.effective, ['orderVersion','status']);
  const effectiveVersion = positive(value.effective.orderVersion);
  if (!['confirmed','cancelled'].includes(value.effective.status) || effectiveVersion > head || basisRequest > request) invalid();
  if (value.effective.status === 'cancelled') return Object.freeze({ eligible: false, reason: 'order_already_cancelled' });
  if (!['confirmed','rejected','failed'].includes(value.headStatus)
    || (value.headStatus === 'confirmed' && effectiveVersion !== head)) {
    return Object.freeze({ eligible: false, reason: 'prior_version_unresolved' });
  }
  if (value.operation !== 'cancel' && value.currentRequestStatus !== 'Confirmed') {
    return Object.freeze({ eligible: false, reason: 'conference_not_confirmed' });
  }
  if ((value.operation === 'change' && request === basisRequest)
    || (value.operation === 'exception' && request !== basisRequest)) {
    return Object.freeze({ eligible: false, reason: 'request_change_required' });
  }
  return Object.freeze({ eligible: true, source: value.operation === 'change' ? 'current_request' : 'effective_order',
    basisOrderVersion: effectiveVersion, sourceRequestVersion: value.operation === 'change' ? request : basisRequest,
    basisAssignmentRevision: assignment, requestEvidenceVersion: request, requestEvidenceStatus: value.currentRequestStatus,
    nextOrderVersion: head + 1 });
}

export function normalizeCateringVersionProposal(value, { tenantId, orderId } = {}) {
  record(value, ['tenantId','orderId','orderVersion','priorOrderVersion','priorStateRevision','basisOrderVersion','commandId',
    'operation','requestId','requestEvidenceVersion','requestEvidenceStatus','sourceRequestVersion','assignmentRevision',
    'configurationRevision','justification','proposedAt','proposedByUserId','proposerSecurityVersion']);
  const tenant = uuid(tenantId); const order = uuid(orderId);
  const command = normalizeCateringVersionCommand({ schemaVersion: 1, commandId: value.commandId,
    expectedOrderVersion: value.priorOrderVersion, expectedStateRevision: value.priorStateRevision,
    expectedRequestVersion: value.requestEvidenceVersion, expectedAssignmentRevision: value.assignmentRevision,
    operation: value.operation, justification: value.justification }, { orderId: order });
  if (value.tenantId !== tenant || value.orderId !== order || value.orderVersion !== command.expectedOrderVersion + 1
    || positive(value.basisOrderVersion) > command.expectedOrderVersion || !isRequestId(value.requestId)
    || !['Confirmed','Cancelled'].includes(value.requestEvidenceStatus)
    || (value.operation !== 'cancel' && value.requestEvidenceStatus !== 'Confirmed')
    || positive(value.sourceRequestVersion) > command.expectedRequestVersion
    || (value.operation !== 'cancel' && value.sourceRequestVersion !== command.expectedRequestVersion)
    || typeof value.proposedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.proposedAt)
    || !Number.isFinite(Date.parse(value.proposedAt)) || new Date(value.proposedAt).toISOString() !== value.proposedAt) invalid();
  return Object.freeze({ tenantId: tenant, orderId: order, orderVersion: value.orderVersion,
    priorOrderVersion: command.expectedOrderVersion, priorStateRevision: command.expectedStateRevision,
    basisOrderVersion: value.basisOrderVersion, commandId: command.commandId, operation: command.operation,
    requestId: value.requestId, requestEvidenceVersion: command.expectedRequestVersion,
    requestEvidenceStatus: value.requestEvidenceStatus, sourceRequestVersion: value.sourceRequestVersion,
    assignmentRevision: command.expectedAssignmentRevision, configurationRevision: positive(value.configurationRevision),
    justification: command.justification, proposedAt: value.proposedAt, proposedByUserId: uuid(value.proposedByUserId),
    proposerSecurityVersion: positive(value.proposerSecurityVersion) });
}
