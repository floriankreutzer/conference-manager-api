import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  canonicalPlatformAuditCheckpoint,
  canonicalPlatformAuditPayload,
  normalizePlatformAuditEvent,
} from '../../platform/audit/event.js';
import { isInternalUuid } from '../../domain/identifiers.js';
import { PlatformAuditIntegrityError, PlatformAuditInputError } from '../../platform/audit/errors.js';

export const PLATFORM_AUDIT_CHECKPOINT_INTERVAL = 32;
const MAX_PAGE_SIZE = 100;
const MAX_VERIFICATION_EVENTS = MAX_PAGE_SIZE * PLATFORM_AUDIT_CHECKPOINT_INTERVAL;

// A pure integrity primitive shared by the scoped audit reader and the closed
// Demo aggregate collector. No operator scope or read authority is created here.
export function createPlatformAuditRowVerifier({ hmacSecret } = {}) {
  const sign = createSigners(hmacSecret);
  return (rows, checkpointRow = null) => {
    let previousHash = null;
    let expectedSequence = 1;
    try {
      if (checkpointRow) {
        const checkpoint = {
          eventCount: Number(checkpointRow.event_count),
          terminalEventHash: checkpointRow.terminal_event_hash,
          previousCheckpointHash: checkpointRow.previous_checkpoint_hash,
          createdAt: instant(checkpointRow.created_at),
        };
        if (Number(checkpointRow.integrity_version) !== 1
          || !secureEqual(checkpointRow.checkpoint_hash, sign.checkpoint(checkpoint))) return false;
        previousHash = checkpoint.terminalEventHash;
        expectedSequence = checkpoint.eventCount + 1;
      }
      if (rows.length > MAX_VERIFICATION_EVENTS) return false;
      for (const row of rows) {
        const stored = mapEventRow(row);
        const event = normalizePlatformAuditEvent(stored);
        if (stored.integrityVersion !== 1 || stored.sequence !== expectedSequence
          || stored.previousHash !== previousHash
          || !secureEqual(stored.eventHash, sign.event(event, stored.sequence, previousHash))) return false;
        previousHash = stored.eventHash;
        expectedSequence += 1;
      }
      return true;
    } catch { return false; }
  };
}

const EVENT_COLUMNS = `
  sequence,
  operator_id,
  roles,
  permissions,
  assurance_level,
  target_tenant_id,
  action,
  target_type,
  target_id,
  previous_state,
  new_state,
  occurred_at,
  correlation_id,
  outcome,
  metadata,
  retention_class,
  previous_hash,
  event_hash,
  integrity_version
`;
export { EVENT_COLUMNS as PLATFORM_AUDIT_EVENT_COLUMNS };

export function secureEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left, 'ascii');
  const rightBuffer = Buffer.from(right, 'ascii');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function instant(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function mapEventRow(row) {
  if (!row) return null;
  return Object.freeze({
    sequence: Number(row.sequence),
    operatorId: row.operator_id,
    roles: Object.freeze([...row.roles]),
    permissions: Object.freeze([...row.permissions]),
    assuranceLevel: row.assurance_level,
    targetTenantId: row.target_tenant_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    previousState: row.previous_state,
    newState: row.new_state,
    occurredAt: instant(row.occurred_at),
    correlationId: row.correlation_id,
    outcome: row.outcome,
    metadata: row.metadata,
    retentionClass: row.retention_class,
    previousHash: row.previous_hash,
    eventHash: row.event_hash,
    integrityVersion: Number(row.integrity_version),
  });
}

export function projectEvent(event) {
  return Object.freeze({
    sequence: event.sequence,
    operatorId: event.operatorId,
    roles: event.roles,
    permissions: event.permissions,
    assuranceLevel: event.assuranceLevel,
    targetTenantId: event.targetTenantId,
    action: event.action,
    targetType: event.targetType,
    targetId: event.targetId,
    previousState: event.previousState,
    newState: event.newState,
    occurredAt: event.occurredAt,
    correlationId: event.correlationId,
    outcome: event.outcome,
    metadata: event.metadata,
    retentionClass: event.retentionClass,
  });
}

export function createSigners(secretValue) {
  if (typeof secretValue !== 'string') throw new TypeError('PLATFORM_AUDIT_HMAC_SECRET_REQUIRED');
  const secret = Buffer.from(secretValue, 'utf8');
  if (secret.byteLength < 32 || secret.byteLength > 512) {
    throw new TypeError('PLATFORM_AUDIT_HMAC_SECRET_INVALID');
  }
  function hmac(domain, payload) {
    return createHmac('sha256', secret).update(domain, 'utf8').update('\0', 'utf8').update(payload, 'utf8').digest('hex');
  }
  return Object.freeze({
    event: (event, sequence, previousHash) => hmac(
      'conference-manager:platform-audit:event:v1',
      canonicalPlatformAuditPayload(event, { sequence, previousHash }),
    ),
    checkpoint: (checkpoint) => hmac(
      'conference-manager:platform-audit:checkpoint:v1',
      canonicalPlatformAuditCheckpoint(checkpoint),
    ),
  });
}

export function normalizeAuditSegment(value) {
  if (!value || ![Object.prototype,null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).sort().join(',') !== 'deploymentEpoch,environment,id'
    || Reflect.ownKeys(value).some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'))
    || !isInternalUuid(value.id) || value.environment !== 'int' || !isInternalUuid(value.deploymentEpoch)) {
    throw new PlatformAuditInputError('PLATFORM_AUDIT_SEGMENT_INVALID');
  }
  return Object.freeze({ ...value });
}

function segmentBinding(segment) {
  normalizeAuditSegment({ id: segment.id,environment: segment.environment,deploymentEpoch: segment.deploymentEpoch });
  if (!Number.isSafeInteger(segment.legacyEventCount) || segment.legacyEventCount < 0
    || !/^[0-9a-f]{64}$/.test(segment.inventoryDigest)) throw new PlatformAuditIntegrityError();
  return { integrityVersion: 2,segmentId: segment.id,environment: segment.environment,
    deploymentEpoch: segment.deploymentEpoch,legacyEventCount: segment.legacyEventCount,inventoryDigest: segment.inventoryDigest };
}

export function createSegmentSigners(hmacSecret, segment) {
  createSigners(hmacSecret);
  const binding = Object.freeze(segmentBinding(segment));
  const sign = (purpose, value) => createHmac('sha256',hmacSecret)
    .update(`conference-manager:platform-audit:${purpose}:v2`).update('\0').update(JSON.stringify(value)).digest('hex');
  return Object.freeze({
    event(event, sequence, previousHash) {
      const segmentSequence = sequence - segment.legacyEventCount;
      if (!Number.isSafeInteger(segmentSequence) || segmentSequence < 1) throw new PlatformAuditIntegrityError();
      return sign('event',{ ...binding,segmentSequence,
        payload: canonicalPlatformAuditPayload(event,{ sequence,previousHash }) });
    },
    checkpoint(value) {
      return sign('checkpoint',{ ...binding,terminalSequence: segment.legacyEventCount + value.eventCount,
        payload: canonicalPlatformAuditCheckpoint(value) });
    },
  });
}

export function createSegmentRowVerifier({ hmacSecret,segment }) {
  const sign = createSegmentSigners(hmacSecret,segment);
  return (rows, checkpoint = null) => {
    try {
      let count = 0, previous = null;
      if (checkpoint) {
        count = Number(checkpoint.event_count);
        if (checkpoint.segment_id !== segment.id || checkpoint.integrity_version !== 2 || count < 1 || count % 32 !== 0
          || Number(checkpoint.terminal_sequence) !== segment.legacyEventCount + count
          || !secureEqual(checkpoint.checkpoint_hash,sign.checkpoint({ eventCount: count,
            terminalEventHash: checkpoint.terminal_event_hash,previousCheckpointHash: checkpoint.previous_checkpoint_hash,
            createdAt: instant(checkpoint.created_at) }))) return false;
        previous = checkpoint.terminal_event_hash;
      }
      if (rows.length > MAX_VERIFICATION_EVENTS) return false;
      for (const row of rows) {
        count += 1;
        if (row.integrity_version !== 2 || row.segment_id !== segment.id || Number(row.segment_sequence) !== count
          || Number(row.sequence) !== segment.legacyEventCount + count || row.previous_hash !== previous
          || !secureEqual(row.event_hash,sign.event(mapEventRow(row),Number(row.sequence),previous))) return false;
        previous = row.event_hash;
      }
      return true;
    } catch { return false; }
  };
}

