import { withPostgresTransaction } from './transaction.js';

const COLUMNS = 'id, status, started_at, ended_at, submission_fingerprint';

function publicWorkflow(row) {
  return row ? Object.freeze({ id: row.id, status: row.status,
    startedAt: row.started_at.toISOString(), endedAt: row.ended_at?.toISOString() ?? null }) : null;
}

// All lifecycle mutations share the established Tenant -> User -> Request order.
// The session guard establishes authority; these locks close revocation races.
export async function lockRequestDraftOwnerWithClient(client, {
  tenantId, ownerUserId, securityVersion,
}) {
  if (!Number.isSafeInteger(securityVersion) || securityVersion < 1) return false;
  const tenant = await client.query({
    name: 'request-workflow-tenant-lock',
    text: "SELECT id FROM tenants WHERE id = $1 AND status = 'active' FOR UPDATE",
    values: [tenantId],
  });
  if (tenant.rowCount !== 1) return false;
  const owner = await client.query({
    name: 'request-workflow-owner-lock',
    text: `SELECT id FROM users WHERE tenant_id = $1 AND id = $2
      AND active = TRUE AND security_version = $3 FOR SHARE`,
    values: [tenantId, ownerUserId, securityVersion],
  });
  return owner.rowCount === 1;
}

export async function lockRequestDraftWorkflowWithClient(client, { tenantId, ownerUserId, workflowId }) {
  const result = await client.query({
    name: 'request-workflow-owner-state-lock',
    text: `SELECT ${COLUMNS} FROM request_workflow_starts
      WHERE tenant_id = $1 AND owner_user_id = $2 AND id = $3 FOR UPDATE`,
    values: [tenantId, ownerUserId, workflowId],
  });
  return result.rows[0] ?? null;
}

export async function submitRequestDraftWorkflowWithClient(client, {
  tenantId, ownerUserId, workflowId, changedAt, submissionFingerprint,
}) {
  const result = await client.query({
    name: 'request-workflow-submit',
    text: `UPDATE request_workflow_starts
      SET status = 'submitted', ended_at = $4, request_id = id::text, submission_fingerprint = $5
      WHERE tenant_id = $1 AND owner_user_id = $2 AND id = $3 AND status = 'started'`,
    values: [tenantId, ownerUserId, workflowId, changedAt, submissionFingerprint],
  });
  if (result.rowCount !== 1) throw new Error('REQUEST_WORKFLOW_SUBMIT_FAILED');
}

export function createPostgresRequestDraftWorkflowRepository(pool, { auditRepository } = {}) {
  if (!pool?.connect || !auditRepository?.appendWithClient) {
    throw new TypeError('REQUEST_WORKFLOW_PERSISTENCE_REQUIRED');
  }
  async function appendAudit(client, event) {
    if (!await auditRepository.appendWithClient(client, event)) throw new Error('AUDIT_APPEND_FAILED');
  }

  return Object.freeze({
    async startForOwner(values) {
      return withPostgresTransaction(pool, async (client) => {
        if (!await lockRequestDraftOwnerWithClient(client, values)) return { status: 'not_found' };
        const { tenantId, ownerUserId, workflowId, idempotencyKey, changedAt, auditEvent } = values;
        const inserted = await client.query({
          name: 'request-workflow-start',
          text: `INSERT INTO request_workflow_starts
            (tenant_id, id, owner_user_id, idempotency_key, started_at)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (tenant_id, owner_user_id, idempotency_key) DO NOTHING
            RETURNING ${COLUMNS}`,
          values: [tenantId, workflowId, ownerUserId, idempotencyKey, changedAt],
        });
        if (inserted.rowCount === 1) {
          await appendAudit(client, auditEvent);
          return { status: 'started', workflow: publicWorkflow(inserted.rows[0]) };
        }
        const existing = await client.query({
          name: 'request-workflow-start-replay',
          text: `SELECT ${COLUMNS} FROM request_workflow_starts
            WHERE tenant_id = $1 AND owner_user_id = $2 AND idempotency_key = $3`,
          values: [tenantId, ownerUserId, idempotencyKey],
        });
        return { status: 'replayed', workflow: publicWorkflow(existing.rows[0]) };
      });
    },

    async abandonForOwner(values) {
      return withPostgresTransaction(pool, async (client) => {
        if (!await lockRequestDraftOwnerWithClient(client, values)) return { status: 'not_found' };
        const existing = await lockRequestDraftWorkflowWithClient(client, values);
        if (!existing) return { status: 'not_found' };
        if (existing.status === 'abandoned') return { status: 'replayed', workflow: publicWorkflow(existing) };
        if (existing.status !== 'started') return { status: 'conflict' };
        const result = await client.query({
          name: 'request-workflow-abandon',
          text: `UPDATE request_workflow_starts SET status = 'abandoned', ended_at = $4
            WHERE tenant_id = $1 AND owner_user_id = $2 AND id = $3 AND status = 'started'
            RETURNING ${COLUMNS}`,
          values: [values.tenantId, values.ownerUserId, values.workflowId, values.changedAt],
        });
        if (result.rowCount !== 1) throw new Error('REQUEST_WORKFLOW_ABANDON_FAILED');
        await appendAudit(client, values.auditEvent);
        return { status: 'abandoned', workflow: publicWorkflow(result.rows[0]) };
      });
    },
  });
}
