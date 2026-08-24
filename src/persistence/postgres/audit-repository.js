import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import {
  canonicalAuditPayload,
  normalizeAuditEvent,
} from '../../audit/event.js';
import { withPostgresTransaction } from './transaction.js';

const AUDIT_COLUMNS = `
  id,
  tenant_id,
  actor_user_id,
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

function mapAuditRow(row) {
  if (!row) return null;
  return Object.freeze({
    id: String(row.id),
    tenantId: row.tenant_id,
    actorUserId: row.actor_user_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    previousState: row.previous_state,
    newState: row.new_state,
    occurredAt: row.occurred_at.toISOString(),
    correlationId: row.correlation_id,
    outcome: row.outcome,
    metadata: row.metadata,
    retentionClass: row.retention_class,
    previousHash: row.previous_hash,
    eventHash: row.event_hash,
    integrityVersion: Number(row.integrity_version),
  });
}

function createSigner(secretValue) {
  if (typeof secretValue !== 'string') throw new TypeError('AUDIT_HMAC_SECRET_REQUIRED');
  const secret = Buffer.from(secretValue, 'utf8');
  if (secret.byteLength < 32 || secret.byteLength > 512) throw new TypeError('AUDIT_HMAC_SECRET_INVALID');
  return (event, previousHash) => {
    return createHmac('sha256', secret)
      .update(canonicalAuditPayload(event, previousHash), 'utf8')
      .digest('hex');
  };
}

export function createPostgresAuditRepository(pool, { hmacSecret } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  const sign = createSigner(hmacSecret);

  async function appendWithClient(client, eventValue) {
    const event = normalizeAuditEvent(eventValue);
    await client.query({
      name: 'audit-lock-tenant-chain',
      text: 'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
      values: [event.tenantId],
    });
    const tenant = await client.query({
      name: 'audit-tenant-exists',
      text: 'SELECT id FROM tenants WHERE id = $1',
      values: [event.tenantId],
    });
    if (tenant.rowCount !== 1) return null;

    const previous = await client.query({
      name: 'audit-previous-event-hash',
      text: `
        SELECT event_hash
        FROM audit_events
        WHERE tenant_id = $1
        ORDER BY id DESC
        LIMIT 1
      `,
      values: [event.tenantId],
    });
    const previousHash = previous.rows[0]?.event_hash || null;
    const eventHash = sign(event, previousHash);
    const result = await client.query({
      name: 'audit-event-append',
      text: `
        INSERT INTO audit_events (
          tenant_id,
          actor_user_id,
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
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11::jsonb, $12, $13, $14, 1)
        RETURNING ${AUDIT_COLUMNS}
      `,
      values: [
        event.tenantId,
        event.actorUserId,
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
    return mapAuditRow(result.rows[0]);
  }

  return Object.freeze({
    appendWithClient,

    async append(event) {
      return withPostgresTransaction(pool, (client) => appendWithClient(client, event));
    },

    async listByTenantId(tenantId, { limit = 50, beforeId = null } = {}) {
      const result = await pool.query({
        name: 'audit-events-list-by-tenant',
        text: `
          SELECT ${AUDIT_COLUMNS}
          FROM audit_events
          WHERE tenant_id = $1
            AND ($2::bigint IS NULL OR id < $2::bigint)
          ORDER BY id DESC
          LIMIT $3
        `,
        values: [tenantId, beforeId, limit],
      });
      return Object.freeze(result.rows.map(mapAuditRow));
    },

    async verifyTenantChain(tenantId) {
      const result = await pool.query({
        name: 'audit-events-verify-chain',
        text: `
          SELECT ${AUDIT_COLUMNS}
          FROM audit_events
          WHERE tenant_id = $1
          ORDER BY id ASC
        `,
        values: [tenantId],
      });
      let previousHash = null;
      for (const row of result.rows) {
        const stored = mapAuditRow(row);
        const event = normalizeAuditEvent(stored);
        if (stored.integrityVersion !== 1 || stored.previousHash !== previousHash) return false;
        const expected = sign(event, previousHash);
        if (!secureEqual(stored.eventHash, expected)) return false;
        previousHash = stored.eventHash;
      }
      return true;
    },
  });
}
