import { isInternalUuid } from '../../domain/identifiers.js';
import { withPostgresTransaction } from './transaction.js';

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function assertUuid(value, code) {
  if (!isInternalUuid(value)) throw new TypeError(code);
}

function assertHash(value, code) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) throw new TypeError(code);
}

function assertProvider(value) {
  if (typeof value !== 'string' || !PROVIDER_PATTERN.test(value)) {
    throw new TypeError('ONBOARDING_PROVIDER_INVALID');
  }
}

function assertReference(value, code) {
  if (typeof value !== 'string' || !REFERENCE_PATTERN.test(value)) throw new TypeError(code);
}

function assertDate(value, code) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError(code);
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function mapBinding(row) {
  if (!row) return null;
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    provider: row.provider,
    providerTenantReference: row.provider_tenant_reference,
    claimantProviderUserReference: row.claimant_provider_user_reference ?? null,
    status: row.status,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function mapInvitation(row) {
  if (!row) return null;
  return Object.freeze({
    invitationId: row.id,
    tenantId: row.tenant_id,
    revision: Number(row.revision ?? 1),
    expiresAt: iso(row.expires_at),
    consumedAt: row.consumed_at ? iso(row.consumed_at) : null,
    revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
  });
}

export function createPostgresTenantOnboardingRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
  }

  async function createTenantInvitationWithClient(client, {
    tenantId,
    displayName,
    invitationId,
    tokenHash,
    createdAt,
    expiresAt,
  }) {
    assertUuid(tenantId, 'ONBOARDING_TENANT_ID_INVALID');
    assertUuid(invitationId, 'ONBOARDING_INVITATION_ID_INVALID');
    assertHash(tokenHash, 'ONBOARDING_INVITATION_HASH_INVALID');
    assertDate(createdAt, 'ONBOARDING_CREATED_AT_INVALID');
    assertDate(expiresAt, 'ONBOARDING_EXPIRES_AT_INVALID');
    const tenant = await client.query({
      name: 'onboarding-create-pending-tenant',
      text: `
        INSERT INTO tenants (id, display_name, status, created_at, updated_at)
        VALUES ($1, $2, 'pending', $3, $3)
        ON CONFLICT (id) DO NOTHING
        RETURNING id, display_name, status, lifecycle_revision, created_at
      `,
      values: [tenantId, displayName, createdAt],
    });
    if (tenant.rowCount !== 1) return null;
    const invitation = await client.query({
      name: 'onboarding-create-invitation',
      text: `
        INSERT INTO tenant_onboarding_invitations (
          id, tenant_id, token_hash, created_at, expires_at
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT DO NOTHING
        RETURNING id, tenant_id, revision, expires_at, consumed_at, revoked_at
      `,
      values: [invitationId, tenantId, tokenHash, createdAt, expiresAt],
    });
    if (invitation.rowCount !== 1) throw new Error('ONBOARDING_INVITATION_COLLISION');
    return Object.freeze({
      tenant: Object.freeze({
        tenantId: tenant.rows[0].id,
        displayName: tenant.rows[0].display_name,
        status: tenant.rows[0].status,
        revision: Number(tenant.rows[0].lifecycle_revision),
        createdAt: iso(tenant.rows[0].created_at),
      }),
      invitation: mapInvitation(invitation.rows[0]),
    });
  }

  async function revokeInvitationWithClient(client, {
    tenantId,
    invitationId,
    expectedRevision,
    changedAt,
    allowExpired = false,
  }) {
    assertUuid(tenantId, 'ONBOARDING_TENANT_ID_INVALID');
    assertUuid(invitationId, 'ONBOARDING_INVITATION_ID_INVALID');
    assertDate(changedAt, 'ONBOARDING_CHANGED_AT_INVALID');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new TypeError('ONBOARDING_INVITATION_REVISION_INVALID');
    }
    const updated = await client.query({
      name: 'onboarding-revoke-invitation-cas',
      text: `
        UPDATE tenant_onboarding_invitations
        SET revoked_at = $4
        WHERE tenant_id = $1 AND id = $2 AND revision = $3
          AND consumed_at IS NULL AND revoked_at IS NULL
          AND ($5::boolean = true OR expires_at > $4)
        RETURNING id, tenant_id, revision, expires_at, consumed_at, revoked_at
      `,
      values: [tenantId, invitationId, expectedRevision, changedAt, allowExpired],
    });
    if (updated.rowCount !== 1) return null;
    await client.query({
      name: 'onboarding-revoke-invitation-claims',
      text: 'DELETE FROM tenant_claim_transactions WHERE invitation_id = $1',
      values: [invitationId],
    });
    return mapInvitation(updated.rows[0]);
  }

  async function reissueInvitationWithClient(client, {
    tenantId,
    invitationId,
    expectedRevision,
    newInvitationId,
    tokenHash,
    changedAt,
    expiresAt,
  }) {
    assertUuid(newInvitationId, 'ONBOARDING_INVITATION_ID_INVALID');
    assertHash(tokenHash, 'ONBOARDING_INVITATION_HASH_INVALID');
    assertDate(expiresAt, 'ONBOARDING_EXPIRES_AT_INVALID');
    const revoked = await revokeInvitationWithClient(client, {
      tenantId,
      invitationId,
      expectedRevision,
      changedAt,
      allowExpired: true,
    });
    if (!revoked) return null;
    const inserted = await client.query({
      name: 'onboarding-reissue-invitation',
      text: `
        INSERT INTO tenant_onboarding_invitations (
          id, tenant_id, token_hash, created_at, expires_at, reissued_from_id
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, tenant_id, revision, expires_at, consumed_at, revoked_at
      `,
      values: [newInvitationId, tenantId, tokenHash, changedAt, expiresAt, invitationId],
    });
    return mapInvitation(inserted.rows[0]);
  }

  return Object.freeze({
    createTenantInvitationWithClient,
    revokeInvitationWithClient,
    reissueInvitationWithClient,

    async findInvitationByTenantId(tenantId, invitationId, { client = pool } = {}) {
      assertUuid(tenantId, 'ONBOARDING_TENANT_ID_INVALID');
      assertUuid(invitationId, 'ONBOARDING_INVITATION_ID_INVALID');
      const result = await client.query({
        name: 'onboarding-find-invitation-by-tenant',
        text: `
          SELECT id, tenant_id, revision, expires_at, consumed_at, revoked_at
          FROM tenant_onboarding_invitations
          WHERE tenant_id = $1 AND id = $2
          LIMIT 1
        `,
        values: [tenantId, invitationId],
      });
      return mapInvitation(result.rows[0]);
    },

    async createTenantInvitation({
      tenantId,
      displayName,
      invitationId,
      tokenHash,
      createdAt,
      expiresAt,
      auditEvent,
    }) {
      assertUuid(tenantId, 'ONBOARDING_TENANT_ID_INVALID');
      assertUuid(invitationId, 'ONBOARDING_INVITATION_ID_INVALID');
      assertHash(tokenHash, 'ONBOARDING_INVITATION_HASH_INVALID');
      assertDate(createdAt, 'ONBOARDING_CREATED_AT_INVALID');
      assertDate(expiresAt, 'ONBOARDING_EXPIRES_AT_INVALID');
      return withPostgresTransaction(pool, async (client) => {
        const created = await createTenantInvitationWithClient(client, {
          tenantId, displayName, invitationId, tokenHash, createdAt, expiresAt,
        });
        if (!created) return null;
        const audit = await auditRepository.appendWithClient(client, auditEvent);
        if (!audit) throw new Error('AUDIT_APPEND_FAILED');
        return Object.freeze({ tenantId, invitationId });
      });
    },

    async findOpenInvitationByTokenHash({ tokenHash, now }) {
      assertHash(tokenHash, 'ONBOARDING_INVITATION_HASH_INVALID');
      assertDate(now, 'ONBOARDING_NOW_INVALID');
      const result = await pool.query({
        name: 'onboarding-find-open-invitation',
        text: `
          SELECT i.id, i.tenant_id
          FROM tenant_onboarding_invitations i
          JOIN tenants t ON t.id = i.tenant_id
          WHERE i.token_hash = $1
            AND i.consumed_at IS NULL
            AND i.revoked_at IS NULL
            AND i.expires_at > $2
            AND t.status IN ('pending', 'onboarding')
        `,
        values: [tokenHash, now],
      });
      const row = result.rows[0];
      if (!row) return null;
      return Object.freeze({ id: row.id, tenantId: row.tenant_id });
    },

    async prepareClaim({
      tokenHash,
      invitationId,
      provider,
      providerTenantReference,
      providerUserReference,
      displayName,
      createdAt,
      expiresAt,
    }) {
      assertHash(tokenHash, 'ONBOARDING_CLAIM_HASH_INVALID');
      assertUuid(invitationId, 'ONBOARDING_INVITATION_ID_INVALID');
      assertProvider(provider);
      assertReference(providerTenantReference, 'ONBOARDING_PROVIDER_TENANT_REFERENCE_INVALID');
      assertReference(providerUserReference, 'ONBOARDING_PROVIDER_USER_REFERENCE_INVALID');
      assertDate(createdAt, 'ONBOARDING_CREATED_AT_INVALID');
      assertDate(expiresAt, 'ONBOARDING_EXPIRES_AT_INVALID');
      return withPostgresTransaction(pool, async (client) => {
        await client.query({
          name: 'onboarding-delete-expired-claim-transactions',
          text: 'DELETE FROM tenant_claim_transactions WHERE expires_at <= $1',
          values: [createdAt],
        });
        const invitation = await client.query({
          name: 'onboarding-lock-open-invitation-for-claim',
          text: `
            SELECT i.tenant_id
            FROM tenant_onboarding_invitations i
            JOIN tenants t ON t.id = i.tenant_id
            WHERE i.id = $1
              AND i.consumed_at IS NULL
              AND i.revoked_at IS NULL
              AND i.expires_at > $2
              AND t.status IN ('pending', 'onboarding')
            FOR UPDATE OF i, t
          `,
          values: [invitationId, createdAt],
        });
        const tenantId = invitation.rows[0]?.tenant_id;
        if (!tenantId) return null;
        const conflicts = await client.query({
          name: 'onboarding-check-active-binding-conflict',
          text: `
            SELECT 1
            FROM tenant_identity_bindings
            WHERE status = 'active'
              AND (
                (tenant_id = $1 AND provider = $2)
                OR (provider = $2 AND provider_tenant_reference = $3)
              )
            LIMIT 1
          `,
          values: [tenantId, provider, providerTenantReference],
        });
        if (conflicts.rowCount > 0) return null;
        const inserted = await client.query({
          name: 'onboarding-create-claim-transaction',
          text: `
            INSERT INTO tenant_claim_transactions (
              token_hash,
              invitation_id,
              provider,
              provider_tenant_reference,
              provider_user_reference,
              display_name,
              created_at,
              expires_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (token_hash) DO NOTHING
            RETURNING token_hash
          `,
          values: [
            tokenHash,
            invitationId,
            provider,
            providerTenantReference,
            providerUserReference,
            displayName,
            createdAt,
            expiresAt,
          ],
        });
        return inserted.rowCount === 1;
      });
    },

    async findPendingClaim({ tokenHash, now }) {
      assertHash(tokenHash, 'ONBOARDING_CLAIM_HASH_INVALID');
      assertDate(now, 'ONBOARDING_NOW_INVALID');
      const result = await pool.query({
        name: 'onboarding-find-pending-claim',
        text: `
          SELECT
            c.invitation_id,
            c.provider,
            c.provider_tenant_reference,
            c.provider_user_reference,
            c.display_name,
            c.expires_at,
            i.tenant_id,
            t.display_name AS tenant_display_name
          FROM tenant_claim_transactions c
          JOIN tenant_onboarding_invitations i ON i.id = c.invitation_id
          JOIN tenants t ON t.id = i.tenant_id
          WHERE c.token_hash = $1
            AND c.expires_at > $2
            AND i.consumed_at IS NULL
            AND i.revoked_at IS NULL
            AND i.expires_at > $2
            AND t.status IN ('pending', 'onboarding')
        `,
        values: [tokenHash, now],
      });
      const row = result.rows[0];
      if (!row) return null;
      return Object.freeze({
        invitationId: row.invitation_id,
        tenantId: row.tenant_id,
        tenantDisplayName: row.tenant_display_name,
        provider: row.provider,
        providerTenantReference: row.provider_tenant_reference,
        providerUserReference: row.provider_user_reference,
        displayName: row.display_name,
        expiresAt: row.expires_at,
      });
    },

    async confirmClaim({ tokenHash, bindingId, confirmedAt, auditEvent }) {
      assertHash(tokenHash, 'ONBOARDING_CLAIM_HASH_INVALID');
      assertUuid(bindingId, 'ONBOARDING_BINDING_ID_INVALID');
      assertDate(confirmedAt, 'ONBOARDING_CONFIRMED_AT_INVALID');
      return withPostgresTransaction(pool, async (client) => {
        const consumed = await client.query({
          name: 'onboarding-consume-claim-transaction',
          text: `
            DELETE FROM tenant_claim_transactions
            WHERE token_hash = $1
              AND expires_at > $2
            RETURNING
              invitation_id,
              provider,
              provider_tenant_reference,
              provider_user_reference,
              display_name
          `,
          values: [tokenHash, confirmedAt],
        });
        const claim = consumed.rows[0];
        if (!claim) return null;
        const invitation = await client.query({
          name: 'onboarding-lock-invitation-for-confirmation',
          text: `
            SELECT i.tenant_id, t.status
            FROM tenant_onboarding_invitations i
            JOIN tenants t ON t.id = i.tenant_id
            WHERE i.id = $1
              AND i.consumed_at IS NULL
              AND i.revoked_at IS NULL
              AND i.expires_at > $2
              AND t.status IN ('pending', 'onboarding')
            FOR UPDATE OF i, t
          `,
          values: [claim.invitation_id, confirmedAt],
        });
        const row = invitation.rows[0];
        if (!row) return null;
        const binding = await client.query({
          name: 'onboarding-create-active-identity-binding',
          text: `
            INSERT INTO tenant_identity_bindings (
              id,
              tenant_id,
              provider,
              provider_tenant_reference,
              claimant_provider_user_reference,
              status,
              created_at,
              updated_at
            )
            VALUES ($1, $2, $3, $4, $5, 'active', $6, $6)
            ON CONFLICT DO NOTHING
            RETURNING id
          `,
          values: [
            bindingId,
            row.tenant_id,
            claim.provider,
            claim.provider_tenant_reference,
            claim.provider_user_reference,
            confirmedAt,
          ],
        });
        if (binding.rowCount !== 1) return Object.freeze({ conflict: true });
        await client.query({
          name: 'onboarding-consume-invitation',
          text: `
            UPDATE tenant_onboarding_invitations
            SET consumed_at = $2
            WHERE id = $1 AND consumed_at IS NULL
          `,
          values: [claim.invitation_id, confirmedAt],
        });
        const tenant = await client.query({
          name: 'onboarding-advance-tenant-status',
          text: `
            UPDATE tenants
            SET status = CASE WHEN status = 'pending' THEN 'onboarding' ELSE status END,
                updated_at = $2
            WHERE id = $1 AND status IN ('pending', 'onboarding')
            RETURNING status
          `,
          values: [row.tenant_id, confirmedAt],
        });
        if (tenant.rowCount !== 1) return null;
        const audit = await auditRepository.appendWithClient(client, auditEvent);
        if (!audit) throw new Error('AUDIT_APPEND_FAILED');
        return Object.freeze({
          tenantId: row.tenant_id,
          tenantStatus: tenant.rows[0].status,
          provider: claim.provider,
          providerTenantReference: claim.provider_tenant_reference,
          providerUserReference: claim.provider_user_reference,
          displayName: claim.display_name,
        });
      });
    },

    async findActiveBindingByTenantId(tenantId, provider) {
      assertUuid(tenantId, 'ONBOARDING_TENANT_ID_INVALID');
      assertProvider(provider);
      const result = await pool.query({
        name: 'onboarding-find-active-binding-by-tenant',
        text: `
          SELECT
            id,
            tenant_id,
            provider,
            provider_tenant_reference,
            claimant_provider_user_reference,
            status,
            created_at,
            updated_at
          FROM tenant_identity_bindings
          WHERE tenant_id = $1 AND provider = $2 AND status = 'active'
        `,
        values: [tenantId, provider],
      });
      return mapBinding(result.rows[0]);
    },

    async findActiveBindingByProvider(provider, providerTenantReference) {
      assertProvider(provider);
      assertReference(providerTenantReference, 'ONBOARDING_PROVIDER_TENANT_REFERENCE_INVALID');
      const result = await pool.query({
        name: 'onboarding-find-active-binding-by-provider',
        text: `
          SELECT
            id,
            tenant_id,
            provider,
            provider_tenant_reference,
            claimant_provider_user_reference,
            status,
            created_at,
            updated_at
          FROM tenant_identity_bindings
          WHERE provider = $1
            AND provider_tenant_reference = $2
            AND status = 'active'
        `,
        values: [provider, providerTenantReference],
      });
      return mapBinding(result.rows[0]);
    },

    async unbindActive({ tenantId, provider, changedAt, auditEvent }) {
      assertUuid(tenantId, 'ONBOARDING_TENANT_ID_INVALID');
      assertProvider(provider);
      assertDate(changedAt, 'ONBOARDING_CHANGED_AT_INVALID');
      return withPostgresTransaction(pool, async (client) => {
        const tenant = await client.query({
          name: 'onboarding-lock-tenant-for-unbind',
          text: `
            SELECT status
            FROM tenants
            WHERE id = $1
              AND status IN ('pending', 'onboarding', 'ready')
            FOR SHARE
          `,
          values: [tenantId],
        });
        if (tenant.rowCount !== 1) return null;
        await client.query({
          name: 'onboarding-lock-microsoft365-for-unbind',
          text: `
            SELECT id
            FROM integrations
            WHERE tenant_id = $1
              AND provider = 'microsoft365'
            FOR UPDATE
          `,
          values: [tenantId],
        });
        const activeBinding = await client.query({
          name: 'onboarding-lock-active-identity-for-unbind',
          text: `
            SELECT
              id,
              tenant_id,
              provider,
              provider_tenant_reference,
              claimant_provider_user_reference,
              status,
              created_at,
              updated_at
            FROM tenant_identity_bindings
            WHERE tenant_id = $1
              AND provider = $2
              AND status = 'active'
            FOR UPDATE
          `,
          values: [tenantId, provider],
        });
        if (activeBinding.rowCount !== 1) return null;
        const unresolvedBookings = await client.query({
          name: 'onboarding-unbind-block-unresolved-bookings',
          text: `
            SELECT 1
            FROM booking_provider_references
            WHERE tenant_id = $1
              AND state <> 'cancelled'
            LIMIT 1
            FOR UPDATE
          `,
          values: [tenantId],
        });
        if (unresolvedBookings.rowCount > 0) return null;
        const result = await client.query({
          name: 'onboarding-unbind-active-identity',
          text: `
            UPDATE tenant_identity_bindings
            SET status = 'unbound', updated_at = $2
            WHERE id = $1
              AND status = 'active'
            RETURNING
              id,
              tenant_id,
              provider,
              provider_tenant_reference,
              claimant_provider_user_reference,
              status,
              created_at,
              updated_at
          `,
          values: [activeBinding.rows[0].id, changedAt],
        });
        if (result.rowCount !== 1) return null;
        await client.query({
          name: 'onboarding-unbind-invalidate-user-security-versions',
          text: `
            UPDATE users
            SET security_version = security_version + 1,
                updated_at = GREATEST(updated_at, $2)
            WHERE tenant_id = $1
          `,
          values: [tenantId, changedAt],
        });
        await client.query({
          name: 'onboarding-unbind-revoke-sessions',
          text: `
            UPDATE sessions
            SET revoked_at = GREATEST(issued_at, $2)
            WHERE tenant_id = $1
              AND revoked_at IS NULL
          `,
          values: [tenantId, changedAt],
        });
        await client.query({
          name: 'onboarding-unbind-delete-microsoft365-consent',
          text: `
            DELETE FROM microsoft365_consent_transactions
            WHERE tenant_id = $1
          `,
          values: [tenantId],
        });
        await client.query({
          name: 'onboarding-unbind-disconnect-microsoft365',
          text: `
            UPDATE integrations
            SET status = 'disconnected',
                connection_version = connection_version + 1,
                last_verified_at = NULL,
                connection_reason = NULL,
                places_permission_status = 'unknown',
                calendars_permission_status = 'unknown',
                updated_at = GREATEST(updated_at, $2)
            WHERE tenant_id = $1
              AND provider = 'microsoft365'
          `,
          values: [tenantId, changedAt],
        });
        const audit = await auditRepository.appendWithClient(client, auditEvent);
        if (!audit) throw new Error('AUDIT_APPEND_FAILED');
        return mapBinding(result.rows[0]);
      });
    },
  });
}
