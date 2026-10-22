import { normalizePlatformAuditEvent } from '../../platform/audit/event.js';
import { isInternalUuid } from '../../domain/identifiers.js';
import { PlatformAuditIntegrityError, PlatformAuditInputError } from '../../platform/audit/errors.js';
import { withPostgresTransaction } from './transaction.js';
import { createPostgresPlatformAuditSegmentRepository } from './platform-audit-segment-repository.js';
import { createSigners, createPlatformAuditRowVerifier, instant, mapEventRow, projectEvent,
  PLATFORM_AUDIT_EVENT_COLUMNS as EVENT_COLUMNS, PLATFORM_AUDIT_CHECKPOINT_INTERVAL } from './platform-audit-integrity.js';
export { createPlatformAuditRowVerifier, mapEventRow, PLATFORM_AUDIT_EVENT_COLUMNS,
  PLATFORM_AUDIT_CHECKPOINT_INTERVAL } from './platform-audit-integrity.js';
const MAX_PAGE_SIZE = 100;
const MAX_VERIFICATION_EVENTS = MAX_PAGE_SIZE * PLATFORM_AUDIT_CHECKPOINT_INTERVAL;

async function readScopedPage(pool, { limit, beforeSequence, scope: scopeValue, from, to }, segmentId = null) {
  validatePage({ limit, beforeSequence, from, to });
  const scope = validateScope(scopeValue);
  return pool.query({
        name: 'platform-audit-page',
        text: `
          SELECT ${EVENT_COLUMNS}
          FROM platform_audit_events
          WHERE ($8::uuid IS NULL OR segment_id = $8)
            AND ($1::bigint IS NULL OR sequence < $1::bigint)
            AND ($6::timestamptz IS NULL OR occurred_at >= $6::timestamptz)
            AND ($7::timestamptz IS NULL OR occurred_at < $7::timestamptz)
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
        values: [beforeSequence, limit, scope.operatorId, scope.securityVersion, scope.mode, from, to, segmentId],
      });
}

function validatePage({ limit, beforeSequence, from, to }) {
  if ((from !== null || to !== null) && (typeof from !== 'string' || typeof to !== 'string'
    || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to))
    || new Date(from).toISOString() !== from || new Date(to).toISOString() !== to
    || Date.parse(from) >= Date.parse(to) || Date.parse(to) - Date.parse(from) > 90 * 86400000)) {
    throw new PlatformAuditInputError('PLATFORM_AUDIT_WINDOW_INVALID');
  }
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

export function createPostgresPlatformAuditRepository(pool, { hmacSecret, segment = null } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (segment !== null) return createPostgresPlatformAuditSegmentRepository(pool, { hmacSecret, segment,
    readPage: (values,client=pool) => readScopedPage(client, values, segment.id) });
  const sign = createSigners(hmacSecret);
  const verifyRows = createPlatformAuditRowVerifier({ hmacSecret });

  async function appendWithClient(client, eventValue, { expectedTargetTenantId } = {}) {
    let event = normalizePlatformAuditEvent(eventValue);
    authoritativeTarget(event, expectedTargetTenantId);
    await client.query('LOCK TABLE platform_audit_segments IN ACCESS SHARE MODE');
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

  return Object.freeze({
    appendWithClient,
    async isReady() {
      try {
        return await withPostgresTransaction(pool,async client=>{
          await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
          const active=await client.query('SELECT EXISTS(SELECT 1 FROM platform_audit_segments) AS active');
          if (active.rows[0]?.active!==false) return false;
          const rows=await client.query(`SELECT ${EVENT_COLUMNS} FROM platform_audit_events ORDER BY sequence LIMIT 3201`);
          const head=await client.query('SELECT event_count,terminal_event_hash FROM platform_audit_chain_state WHERE singleton');
          return head.rowCount===1 && Number(head.rows[0].event_count)===rows.rowCount
            && head.rows[0].terminal_event_hash===(rows.rows.at(-1)?.event_hash ?? null) && verifyRows(rows.rows);
        });
      } catch { return false; }
    },

    async append(event, options) {
      return withPostgresTransaction(pool, (client) => appendWithClient(client, event, options));
    },

    async listVerified({ limit = 50, beforeSequence = null, scope: scopeValue, from = null, to = null } = {}) {
      const page = await readScopedPage(pool, { limit, beforeSequence, scope: scopeValue, from, to });
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
