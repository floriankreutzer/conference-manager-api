import { isInternalUuid } from '../../domain/identifiers.js';

const OUTCOMES = new Set(['success', 'failure', 'denied']);

function requireInstant(value, code) {
  if (
    typeof value !== 'string'
    || !value.endsWith('Z')
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new TypeError(code);
  }
}

function mapRow(row) {
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
  });
}

export function createPostgresTenantAuditQueryRepository(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');

  return Object.freeze({
    async listByTenantId({
      tenantId,
      limit = 51,
      beforeId = null,
      categoryActions = null,
      outcome = null,
      actorUserId = null,
      from,
      to,
    } = {}) {
      if (!isInternalUuid(tenantId)) throw new TypeError('AUDIT_TENANT_ID_INVALID');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 101) {
        throw new TypeError('AUDIT_LIMIT_INVALID');
      }
      if (beforeId !== null && (typeof beforeId !== 'string' || !/^[1-9]\d{0,18}$/.test(beforeId))) {
        throw new TypeError('AUDIT_CURSOR_INVALID');
      }
      if (
        categoryActions !== null
        && (
          !Array.isArray(categoryActions)
          || categoryActions.length < 1
          || categoryActions.length > 32
          || categoryActions.some((action) => typeof action !== 'string' || action.length > 128)
        )
      ) {
        throw new TypeError('AUDIT_CATEGORY_ACTIONS_INVALID');
      }
      if (outcome !== null && !OUTCOMES.has(outcome)) throw new TypeError('AUDIT_OUTCOME_INVALID');
      if (actorUserId !== null && !isInternalUuid(actorUserId)) throw new TypeError('AUDIT_ACTOR_INVALID');
      requireInstant(from, 'AUDIT_FROM_INVALID');
      requireInstant(to, 'AUDIT_TO_INVALID');

      const result = await pool.query({
        name: 'tenant-audit-bounded-query',
        text: `
          SELECT
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
            outcome
          FROM audit_events
          WHERE tenant_id = $1
            AND ($2::bigint IS NULL OR id < $2::bigint)
            AND occurred_at >= $3::timestamptz
            AND occurred_at <= $4::timestamptz
            AND ($5::text IS NULL OR outcome = $5)
            AND ($6::uuid IS NULL OR actor_user_id = $6)
            AND ($7::text[] IS NULL OR action = ANY($7::text[]))
          ORDER BY id DESC
          LIMIT $8
        `,
        values: [tenantId, beforeId, from, to, outcome, actorUserId, categoryActions, limit],
      });
      return Object.freeze(result.rows.map(mapRow));
    },
  });
}
