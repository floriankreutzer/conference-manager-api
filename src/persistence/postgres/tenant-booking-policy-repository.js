import { withPostgresTransaction } from './transaction.js';

const DEFAULT_POLICY = Object.freeze({
  minNoticeMinutes: 0,
  maxAdvanceDays: 365,
  maxDurationMinutes: 1440,
  maxParticipants: 1000,
  allowExternalParticipants: true,
  cancellationCutoffMinutes: 0,
  changeCutoffMinutes: 0,
  effectiveFrom: null,
});

function publicPolicy(row) {
  if (!row?.tenant_id) return DEFAULT_POLICY;
  return Object.freeze({
    minNoticeMinutes: row.min_notice_minutes,
    maxAdvanceDays: row.max_advance_days,
    maxDurationMinutes: row.max_duration_minutes,
    maxParticipants: row.max_participants,
    allowExternalParticipants: row.allow_external_participants,
    cancellationCutoffMinutes: row.cancellation_cutoff_minutes,
    changeCutoffMinutes: row.change_cutoff_minutes,
    effectiveFrom: row.effective_from.toISOString(),
  });
}

export function createPostgresTenantBookingPolicyRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') throw new TypeError('AUDIT_REPOSITORY_REQUIRED');

  async function read(tenantId, client = pool) {
    const result = await client.query({
      name: 'tenant-booking-policy-get',
      text: `
        SELECT t.booking_policies_revision,
               p.tenant_id,p.min_notice_minutes,p.max_advance_days,p.max_duration_minutes,
               p.max_participants,p.allow_external_participants,p.cancellation_cutoff_minutes,
               p.change_cutoff_minutes,p.effective_from
        FROM tenants t
        LEFT JOIN tenant_booking_policies p ON p.tenant_id=t.id
        WHERE t.id=$1
      `,
      values: [tenantId],
    });
    if (!result.rows[0]) return null;
    return Object.freeze({
      revision: Number(result.rows[0].booking_policies_revision),
      bookingPolicy: publicPolicy(result.rows[0]),
    });
  }

  return Object.freeze({
    get: (tenantId) => read(tenantId),
    async update({ tenantId, expectedRevision, policy, changedAt, auditEvent }) {
      return withPostgresTransaction(pool, async (client) => {
        const locked = await client.query({
          name: 'tenant-booking-policy-lock',
          text: 'SELECT booking_policies_revision FROM tenants WHERE id=$1 FOR UPDATE',
          values: [tenantId],
        });
        if (!locked.rows[0]) return null;
        const currentRevision = Number(locked.rows[0].booking_policies_revision);
        if (currentRevision !== expectedRevision) return Object.freeze({ conflict: true, currentRevision });
        await client.query({
          name: 'tenant-booking-policy-upsert',
          text: `
            INSERT INTO tenant_booking_policies (
              tenant_id,min_notice_minutes,max_advance_days,max_duration_minutes,max_participants,
              allow_external_participants,cancellation_cutoff_minutes,change_cutoff_minutes,effective_from,updated_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
            ON CONFLICT (tenant_id) DO UPDATE SET
              min_notice_minutes=EXCLUDED.min_notice_minutes,
              max_advance_days=EXCLUDED.max_advance_days,
              max_duration_minutes=EXCLUDED.max_duration_minutes,
              max_participants=EXCLUDED.max_participants,
              allow_external_participants=EXCLUDED.allow_external_participants,
              cancellation_cutoff_minutes=EXCLUDED.cancellation_cutoff_minutes,
              change_cutoff_minutes=EXCLUDED.change_cutoff_minutes,
              effective_from=EXCLUDED.effective_from,
              updated_at=EXCLUDED.updated_at
          `,
          values: [
            tenantId, policy.minNoticeMinutes, policy.maxAdvanceDays, policy.maxDurationMinutes,
            policy.maxParticipants, policy.allowExternalParticipants, policy.cancellationCutoffMinutes,
            policy.changeCutoffMinutes, changedAt,
          ],
        });
        await client.query({
          name: 'tenant-booking-policy-revision-advance',
          text: 'UPDATE tenants SET booking_policies_revision=booking_policies_revision+1, updated_at=$2 WHERE id=$1',
          values: [tenantId, changedAt],
        });
        const audit = await auditRepository.appendWithClient(client, auditEvent);
        if (!audit) throw new Error('AUDIT_APPEND_FAILED');
        return read(tenantId, client);
      });
    },
  });
}
