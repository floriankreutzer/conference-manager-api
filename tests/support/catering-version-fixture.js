import { cateringId as id } from './catering-order-fixture.js';
export const versionContext = () => ({ principal: { tenantId: id(1), userId: id(20), roles: ['conference_manager'],
  permissions: ['request:manage'], session: { id: id(21), securityVersion: 1 } },
  tenantContext: { tenantId: id(1), status: 'active' }, correlationId: id(90) });
export const versionCommand = () => ({ ...versionContext(), orderId: id(5), schemaVersion: 1, commandId: id(7),
  expectedOrderVersion: 1, expectedStateRevision: 6, expectedRequestVersion: 2, expectedAssignmentRevision: 2,
  operation: 'change', justification: 'Synthetic changed schedule' });
export const versionProposal = (orderVersion = 2, extra = {}) => ({ tenantId: id(1), orderId: id(5), orderVersion,
  priorOrderVersion: orderVersion - 1, priorStateRevision: 6, basisOrderVersion: 1, commandId: id(7), operation: 'change',
  requestId: 'request-a', requestEvidenceVersion: 2, requestEvidenceStatus: 'Confirmed', sourceRequestVersion: 2,
  assignmentRevision: 2, configurationRevision: 1, justification: 'Synthetic changed schedule', proposedAt: '2026-10-19T15:00:00.000Z',
  proposedByUserId: id(20), proposerSecurityVersion: 1, ...extra });
export const versionPage = (proposals = [], head = 1, next = null) => ({ tenantId: id(1), orderId: id(5), requestId: 'request-a',
  orderState: { orderVersion: head, revision: 6, status: head === 1 ? 'confirmed' : 'rejected' },
  currentRequest: { version: 2, status: 'Confirmed' }, currentAssignmentRevision: 2,
  basis: { orderVersion: 1, status: 'confirmed', requestVersion: 1, assignmentRevision: 1,
    providerCost: { amountMinor: 1200, currency: 'EUR' } },
  allowedOperations: ['change','cancel'], proposals, nextAfterOrderVersion: next });
