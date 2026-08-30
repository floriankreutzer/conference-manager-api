import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  canonicalPlatformAuditCheckpoint,
  canonicalPlatformAuditPayload,
  normalizePlatformAuditEvent,
} from '../../platform/audit/event.js';
import { isInternalUuid } from '../../domain/identifiers.js';
import { PlatformAuditIntegrityError, PlatformAuditInputError } from '../../platform/audit/errors.js';
import { withPostgresTransaction } from './transaction.js';

export const PLATFORM_AUDIT_CHECKPOINT_INTERVAL = 32;
const MAX_PAGE_SIZE = 100;
const MAX_VERIFICATION_EVENTS = MAX_PAGE_SIZE * PLATFORM_AUDIT_CHECKPOINT_INTERVAL;

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

function secureEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left, 'ascii');
  const rightBuffer = Buffer.from(right, 'ascii');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function instant(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapEventRow(row) {
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

function projectEvent(event) {
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

function createSigners(secretValue) {
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

function validatePage({ limit, beforeSequence }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new PlatformAuditInputError('PLATFORM_AUDIT_PAGE_INVALID');
  }
  if (beforeSequence !== null && (!Number.isSafeInteger(beforeSequence) || beforeSequence < 2)) {
    throw new PlatformAuditInputError('PLATFORM_AUDIT_CURSOR_INVALID');
  }
}

function validateScope(scope) {
  if (
    !scope
    || typeof scope !== 'object'
    || Array.isArray(scope)
    || Object.keys(scope).sort().join(',') !== 'mode,operatorId,securityVersion'
    || !['all', 'allowlist'].includes(scope.mode)
    || !isInternalUuid(scope.operatorId)
    || !Number.isSafeInteger(scope.securityVersion)
    || scope.securityVersion < 1
  ) throw new PlatformAuditInputError('PLATFORM_AUDIT_SCOPE_INVALID');
  return scope;
}

function authoritativeTarget(event, expectedTargetTenantId) {
  if (event.targetTenantId === null) {
    if (expectedTargetTenantId !== undefined && expectedTargetTenantId !== null) {
      throw new PlatformAuditInputError('PLATFORM_AUDIT_TARGET_MISMATCH');
    }
    return;
  }
  if (expectedTargetTenantId === undefined || event.targetTenantId !== expectedTargetTenantId) {
    throw new PlatformAuditInputError('PLATFORM_AUDIT_AUTHORITATIVE_TARGET_REQUIRED');
  }
}

export function createPostgresPlatformAuditRepository(pool, { hmacSecret } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  const sign = createSigners(hmacSecret);

  async function appendWithClient(client, eventValue, { expectedTargetTenantId } = {}) {
    let event = normalizePlatformAuditEvent(eventValue);
    authoritativeTarget(event, expectedTargetTenantId);
    const chain = await client.query({
      name: 'platform-audit-chain-lock',
      text: `
        SELECT event_count, terminal_event_hash, terminal_checkpoint_hash
        FROM platform_audit_chain_state
        WHERE singleton = true
        FOR UPDATE
      `,
    });
    if (chain.rowCount !== 1) throw new PlatformAuditIntegrityError();
    const occurred = await client.query({
      name: 'platform-audit-database-clock',
      text: 'SELECT clock_timestamp() AS occurred_at',
    });
    event = normalizePlatformAuditEvent({ ...event, occurredAt: instant(occurred.rows[0].occurred_at) });
    const state = chain.rows[0];
    const sequence = Number(state.event_count) + 1;
    const previousHash = state.terminal_event_hash;
    const eventHash = sign.event(event, sequence, previousHash);
    const inserted = await client.query({
      name: 'platform-audit-event-append',
      text: `
        INSERT INTO platform_audit_events (
          sequence, operator_id, roles, permissions, assurance_level, target_tenant_id,
          action, target_type, target_id, previous_state, new_state, occurred_at,
          correlation_id, outcome, metadata, retention_class, previous_hash,
          event_hash, integrity_version
        )
        VALUES (
          $1, $2, $3::text[], $4::text[], $5, $6, $7, $8, $9, $10::jsonb,
          $11::jsonb, $12, $13, $14, $15::jsonb, $16, $17, $18, 1
        )
        RETURNING ${EVENT_COLUMNS}
      `,
      values: [
        sequence,
        event.operatorId,
        event.roles,
        event.permissions,
        event.assuranceLevel,
        event.targetTenantId,
        event.action,
        event.targetType,
        event.targetId,
        event.previousState === null ? null : JSON.stringify(event.previousState),
        event.newState === null ? null : JSON.stringify(event.newState),
        event.occurredAt,
        event.correlationId,
        event.outcome,
        JSON.stringify(event.metadata),
        event.retentionClass,
        previousHash,
        eventHash,
      ],
    });

    let terminalCheckpointHash = state.terminal_checkpoint_hash;
    if (sequence % PLATFORM_AUDIT_CHECKPOINT_INTERVAL === 0) {
      const checkpoint = Object.freeze({
        eventCount: sequence,
        terminalEventHash: eventHash,
        previousCheckpointHash: terminalCheckpointHash,
        createdAt: event.occurredAt,
      });
      terminalCheckpointHash = sign.checkpoint(checkpoint);
      await client.query({
        name: 'platform-audit-checkpoint-append',
        text: `
          INSERT INTO platform_audit_checkpoints (
            event_count, terminal_event_hash, previous_checkpoint_hash,
            checkpoint_hash, created_at, integrity_version
          )
          VALUES ($1, $2, $3, $4, $5, 1)
        `,
        values: [
          checkpoint.eventCount,
          checkpoint.terminalEventHash,
          checkpoint.previousCheckpointHash,
          terminalCheckpointHash,
          checkpoint.createdAt,
        ],
      });
    }
    await client.query({
      name: 'platform-audit-chain-advance',
      text: `
        UPDATE platform_audit_chain_state
        SET event_count = $1,
            terminal_event_hash = $2,
            terminal_checkpoint_hash = $3
        WHERE singleton = true
      `,
      values: [sequence, eventHash, terminalCheckpointHash],
    });
    return mapEventRow(inserted.rows[0]);
  }

  async function verifyRows(rows, checkpointRow) {
    let previousHash = null;
    let expectedSequence = 1;
    if (checkpointRow) {
      const checkpoint = {
        eventCount: Number(checkpointRow.event_count),
        terminalEventHash: checkpointRow.terminal_event_hash,
        previousCheckpointHash: checkpointRow.previous_checkpoint_hash,
        createdAt: instant(checkpointRow.created_at),
      };
      if (
        Number(checkpointRow.integrity_version) !== 1
        || !secureEqual(checkpointRow.checkpoint_hash, sign.checkpoint(checkpoint))
      ) return false;
      previousHash = checkpoint.terminalEventHash;
      expectedSequence = checkpoint.eventCount + 1;
    }
    if (rows.length > MAX_VERIFICATION_EVENTS) return false;
    for (const row of rows) {
      let stored;
      try {
        stored = mapEventRow(row);
        const event = normalizePlatformAuditEvent(stored);
        if (
          stored.integrityVersion !== 1
          || stored.sequence !== expectedSequence
          || stored.previousHash !== previousHash
          || !secureEqual(stored.eventHash, sign.event(event, stored.sequence, previousHash))
        ) return false;
      } catch {
        return false;
      }
      previousHash = stored.eventHash;
      expectedSequence += 1;
    }
    return true;
  }

  return Object.freeze({
    appendWithClient,

    async append(event, options) {
      return withPostgresTransaction(pool, (client) => appendWithClient(client, event, options));
    },

    async listVerified({ limit = 50, beforeSequence = null, scope: scopeValue } = {}) {
      validatePage({ limit, beforeSequence });
      const scope = validateScope(scopeValue);
      const page = await pool.query({
        name: 'platform-audit-page',
        text: `
          SELECT ${EVENT_COLUMNS}
          FROM platform_audit_events
          WHERE ($1::bigint IS NULL OR sequence < $1::bigint)
            AND EXISTS (
              SELECT 1
              FROM platform_operators operator
              WHERE operator.id = $3
                AND operator.status = 'active'
                AND operator.security_version = $4
                AND operator.scope_mode = $5
                AND (
                  operator.scope_mode = 'all'
                  OR (
                    platform_audit_events.target_tenant_id IS NULL
                    AND platform_audit_events.operator_id = operator.id
                  )
                  OR EXISTS (
                    SELECT 1
                    FROM platform_operator_tenant_scopes target_scope
                    WHERE target_scope.operator_id = operator.id
                      AND target_scope.tenant_id = platform_audit_events.target_tenant_id
                  )
                )
            )
          ORDER BY sequence DESC
          LIMIT $2
        `,
        values: [beforeSequence, limit, scope.operatorId, scope.securityVersion, scope.mode],
      });
      if (page.rowCount === 0) return Object.freeze([]);
      const verificationBuckets = new Map();
      for (const row of page.rows) {
        const sequence = Number(row.sequence);
        if (!Number.isSafeInteger(sequence) || sequence < 1) {
          throw new PlatformAuditIntegrityError();
        }
        const anchorCount = Math.floor((sequence - 1) / PLATFORM_AUDIT_CHECKPOINT_INTERVAL)
          * PLATFORM_AUDIT_CHECKPOINT_INTERVAL;
        verificationBuckets.set(
          anchorCount,
          Math.max(verificationBuckets.get(anchorCount) || 0, sequence),
        );
      }
      if (verificationBuckets.size * PLATFORM_AUDIT_CHECKPOINT_INTERVAL > MAX_VERIFICATION_EVENTS) {
        throw new PlatformAuditIntegrityError();
      }
      for (const [anchorCount, maximumSequence] of verificationBuckets) {
        const checkpoint = anchorCount === 0
          ? { rows: [], rowCount: 0 }
          : await pool.query({
            name: 'platform-audit-verification-anchor',
            text: `
              SELECT event_count, terminal_event_hash, previous_checkpoint_hash,
                checkpoint_hash, created_at, integrity_version
              FROM platform_audit_checkpoints
              WHERE event_count = $1
              LIMIT 1
            `,
            values: [anchorCount],
          });
        if (anchorCount > 0 && checkpoint.rowCount !== 1) {
          throw new PlatformAuditIntegrityError();
        }
        const segment = await pool.query({
          name: 'platform-audit-verification-segment',
          text: `
            SELECT ${EVENT_COLUMNS}
            FROM platform_audit_events
            WHERE sequence > $1 AND sequence <= $2
            ORDER BY sequence ASC
          `,
          values: [anchorCount, maximumSequence],
        });
        if (
          segment.rowCount !== maximumSequence - anchorCount
          || !await verifyRows(segment.rows, checkpoint.rows[0] || null)
        ) {
          throw new PlatformAuditIntegrityError();
        }
      }
      return Object.freeze(page.rows.map((row) => projectEvent(mapEventRow(row))));
    },
  });
}
