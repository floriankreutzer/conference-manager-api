import { isInternalUuid } from '../domain/identifiers.js';
import {
  newTenantBulkReceipt,
  sameTenantBulkValue,
  TENANT_BULK_RECEIPT_TTL_MS,
  tenantBulkCandidate,
  tenantBulkExport,
  tenantBulkPayloadHash,
  tenantBulkTemplate,
} from '../domain/tenant-bulk-transfer.js';
import { TenantSettingsConflictError, TenantSettingsInputError } from './tenant-settings-errors.js';

function inputError(code) {
  return new TenantSettingsInputError(code);
}

function requireReceiptId(value) {
  if (!isInternalUuid(value)) throw inputError('TENANT_BULK_RECEIPT_INVALID');
  return value.toLowerCase();
}

function safeValidationError(error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,96}$/.test(error.code)
    ? error.code
    : 'TENANT_BULK_ROW_INVALID';
  return Object.freeze({ row: null, code });
}

export function createTenantBulkTransferOperations({
  aggregate,
  bulkTransferRepository,
  clock = () => Date.now(),
} = {}) {
  if (!['locations', 'catalogue', 'cost_allocation'].includes(aggregate)) {
    throw new TypeError('TENANT_BULK_AGGREGATE_INVALID');
  }
  if (
    !bulkTransferRepository
    || typeof bulkTransferRepository.create !== 'function'
    || typeof bulkTransferRepository.load !== 'function'
  ) throw new TypeError('TENANT_BULK_TRANSFER_REPOSITORY_REQUIRED');
  if (typeof clock !== 'function') throw new TypeError('CLOCK_REQUIRED');

  function now() {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('TENANT_BULK_CLOCK_INVALID');
    return new Date(value);
  }

  return Object.freeze({
    template(type) {
      return tenantBulkTemplate(type, aggregate);
    },

    export(type, configuration) {
      return tenantBulkExport(type, aggregate, configuration);
    },

    async validate({ principal, tenantContext, correlationId, type, document, current, validateCandidate }) {
      let candidate;
      try {
        candidate = tenantBulkCandidate({ aggregate, type, current: current.configuration, document });
        if (validateCandidate && await validateCandidate(candidate) !== true) {
          throw inputError('TENANT_BULK_REFERENCE_INVALID');
        }
      } catch (error) {
        return Object.freeze({
          schemaVersion: 1,
          valid: false,
          changed: false,
          sourceRevision: current.revision,
          errors: Object.freeze([safeValidationError(error)]),
          receipt: null,
        });
      }
      const changed = !sameTenantBulkValue(current.configuration, candidate);
      if (!changed) {
        return Object.freeze({
          schemaVersion: 1,
          valid: true,
          changed: false,
          sourceRevision: current.revision,
          errors: Object.freeze([]),
          receipt: null,
        });
      }
      const createdAt = now();
      const id = newTenantBulkReceipt();
      const receipt = await bulkTransferRepository.create({
        tenantId: tenantContext.tenantId,
        id,
        actorUserId: principal.userId,
        aggregate,
        documentType: type,
        sourceRevision: current.revision,
        payloadSha256: tenantBulkPayloadHash(document),
        createdAt,
        expiresAt: new Date(createdAt.getTime() + TENANT_BULK_RECEIPT_TTL_MS),
        correlationId,
      });
      if (!receipt) throw new TypeError('TENANT_BULK_RECEIPT_CREATE_FAILED');
      return Object.freeze({
        schemaVersion: 1,
        valid: true,
        changed: true,
        sourceRevision: current.revision,
        errors: Object.freeze([]),
        receipt: Object.freeze({ id: receipt.id, expiresAt: receipt.expiresAt }),
      });
    },

    async apply({ principal, tenantContext, type, document, receiptId, current, update }) {
      const id = requireReceiptId(receiptId);
      const receipt = await bulkTransferRepository.load({ tenantId: tenantContext.tenantId, id });
      if (!receipt || receipt.actorUserId !== principal.userId || receipt.aggregate !== aggregate) {
        throw inputError('TENANT_BULK_RECEIPT_INVALID');
      }
      if (receipt.documentType !== type || receipt.payloadSha256 !== tenantBulkPayloadHash(document)) {
        throw inputError('TENANT_BULK_RECEIPT_INVALID');
      }
      if (receipt.status === 'applied') return receipt.appliedResponse;
      const appliedAt = now();
      if (Date.parse(receipt.expiresAt) < appliedAt.getTime()) {
        throw inputError('TENANT_BULK_RECEIPT_EXPIRED');
      }
      if (current.revision !== receipt.sourceRevision) {
        throw new TenantSettingsConflictError(current.revision);
      }
      const candidate = tenantBulkCandidate({ aggregate, type, current: current.configuration, document });
      return update({
        expectedRevision: current.revision,
        configuration: candidate,
        bulkReceipt: Object.freeze({
          id,
          aggregate,
          documentType: type,
          payloadSha256: receipt.payloadSha256,
          appliedAt,
        }),
      });
    },
  });
}
