import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizeTenantOrganization } from '../../domain/tenant-organization.js';
import { withPostgresTransaction } from './transaction.js';

const DEFAULT_PRESENTATION = Object.freeze({
  defaultLocale: 'de-DE',
  defaultCurrency: 'EUR',
});
const DEFAULT_BRANDING = Object.freeze({ logoAssetRef: null, accentToken: 'default' });

function requireUuid(value, code) {
  if (!isInternalUuid(value)) throw new TypeError(code);
  return value.toLowerCase();
}

function requireDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError('TENANT_ORGANIZATION_CHANGED_AT_INVALID');
  }
}

function organizationFromRow(row) {
  if (!row) return null;
  return normalizeTenantOrganization({
    displayName: row.display_name,
    businessMetadata: {
      legalName: row.legal_name ?? null,
      registrationNumber: row.registration_number ?? null,
      countryCode: row.country_code ?? null,
    },
    presentation: {
      defaultLocale: row.default_locale ?? DEFAULT_PRESENTATION.defaultLocale,
      defaultCurrency: row.default_currency ?? DEFAULT_PRESENTATION.defaultCurrency,
    },
    branding: {
      logoAssetRef: row.logo_asset_ref ?? DEFAULT_BRANDING.logoAssetRef,
      accentToken: row.accent_token ?? DEFAULT_BRANDING.accentToken,
    },
  });
}

function currentFromRow(row) {
  if (!row) return null;
  return Object.freeze({
    revision: Number(row.organization_revision),
    organization: organizationFromRow(row),
    effectiveAt: row.organization_effective_at,
  });
}

function snapshotEqual(left, right) {
  return JSON.stringify(normalizeTenantOrganization(left))
    === JSON.stringify(normalizeTenantOrganization(right));
}

async function loadCurrentWithClient(client, tenantId, { lock = false } = {}) {
  const result = await client.query({
    name: lock ? 'tenant-organization-current-lock' : 'tenant-organization-current-read',
    text: `
      SELECT
        t.id,
        t.display_name,
        t.organization_revision,
        COALESCE(o.updated_at, t.created_at) AS organization_effective_at,
        o.legal_name,
        o.registration_number,
        o.country_code,
        o.default_locale,
        o.default_currency,
        o.logo_asset_ref,
        o.accent_token
      FROM tenants t
      LEFT JOIN tenant_organization_settings o ON o.tenant_id = t.id
      WHERE t.id = $1
      ${lock ? 'FOR UPDATE OF t' : ''}
    `,
    values: [tenantId],
  });
  return currentFromRow(result.rows[0]);
}

async function ensureSnapshot(client, {
  tenantId,
  revision,
  organization,
  effectiveAt,
  actorUserId,
  correlationId,
}) {
  const existing = await client.query({
    name: 'tenant-organization-snapshot-read',
    text: `
      SELECT snapshot
      FROM tenant_organization_revisions
      WHERE tenant_id = $1 AND revision = $2
    `,
    values: [tenantId, revision],
  });
  if (existing.rowCount === 1) {
    if (!snapshotEqual(existing.rows[0].snapshot, organization)) {
      throw new Error('TENANT_ORGANIZATION_SNAPSHOT_DIVERGED');
    }
    return;
  }
  const inserted = await client.query({
    name: 'tenant-organization-snapshot-insert',
    text: `
      INSERT INTO tenant_organization_revisions (
        tenant_id,
        revision,
        snapshot,
        effective_at,
        actor_user_id,
        correlation_id
      )
      VALUES ($1, $2, $3::jsonb, $4, $5, $6)
    `,
    values: [
      tenantId,
      revision,
      JSON.stringify(organization),
      effectiveAt,
      actorUserId,
      correlationId,
    ],
  });
  if (inserted.rowCount !== 1) throw new Error('TENANT_ORGANIZATION_SNAPSHOT_INSERT_FAILED');
}

export function createPostgresTenantOrganizationRepository(pool, { auditRepository } = {}) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
  }

  return Object.freeze({
    async loadCurrent(tenantIdValue) {
      const tenantId = requireUuid(tenantIdValue, 'TENANT_ORGANIZATION_TENANT_ID_INVALID');
      return withPostgresTransaction(pool, async (client) => {
        return loadCurrentWithClient(client, tenantId);
      });
    },

    async listHistory({ tenantId: tenantIdValue, limit = 25, beforeRevision = null } = {}) {
      const tenantId = requireUuid(tenantIdValue, 'TENANT_ORGANIZATION_TENANT_ID_INVALID');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new TypeError('TENANT_ORGANIZATION_HISTORY_LIMIT_INVALID');
      }
      if (
        beforeRevision !== null
        && (!Number.isSafeInteger(beforeRevision) || beforeRevision < 1)
      ) {
        throw new TypeError('TENANT_ORGANIZATION_HISTORY_CURSOR_INVALID');
      }
      const result = await pool.query({
        name: 'tenant-organization-history-list',
        text: `
          SELECT revision, snapshot, effective_at
          FROM tenant_organization_revisions
          WHERE tenant_id = $1
            AND ($2::bigint IS NULL OR revision < $2::bigint)
          ORDER BY revision DESC
          LIMIT $3
        `,
        values: [tenantId, beforeRevision, limit],
      });
      return Object.freeze(result.rows.map((row) => Object.freeze({
        revision: Number(row.revision),
        effectiveAt: row.effective_at.toISOString(),
        organization: normalizeTenantOrganization(row.snapshot),
      })));
    },

    async update({
      tenantId: tenantIdValue,
      actorUserId: actorUserIdValue,
      expectedRevision,
      organization: organizationValue,
      changedAt,
      correlationId: correlationIdValue,
      auditEventFor,
    } = {}) {
      const tenantId = requireUuid(tenantIdValue, 'TENANT_ORGANIZATION_TENANT_ID_INVALID');
      const actorUserId = requireUuid(actorUserIdValue, 'TENANT_ORGANIZATION_ACTOR_ID_INVALID');
      const correlationId = requireUuid(
        correlationIdValue,
        'TENANT_ORGANIZATION_CORRELATION_ID_INVALID',
      );
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
        throw new TypeError('TENANT_ORGANIZATION_REVISION_INVALID');
      }
      const organization = normalizeTenantOrganization(organizationValue);
      requireDate(changedAt);
      if (typeof auditEventFor !== 'function') {
        throw new TypeError('TENANT_ORGANIZATION_AUDIT_FACTORY_REQUIRED');
      }

      return withPostgresTransaction(pool, async (client) => {
        const current = await loadCurrentWithClient(client, tenantId, { lock: true });
        if (!current) return Object.freeze({ status: 'not_found' });
        if (current.revision !== expectedRevision) {
          return Object.freeze({ status: 'conflict', currentRevision: current.revision });
        }

        await ensureSnapshot(client, {
          tenantId,
          revision: current.revision,
          organization: current.organization,
          effectiveAt: current.effectiveAt,
          actorUserId: null,
          correlationId: null,
        });

        const settings = await client.query({
          name: 'tenant-organization-settings-upsert',
          text: `
            INSERT INTO tenant_organization_settings (
              tenant_id,
              legal_name,
              registration_number,
              country_code,
              default_locale,
              default_currency,
              logo_asset_ref,
              accent_token,
              created_at,
              updated_at,
              updated_by_user_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10)
            ON CONFLICT (tenant_id) DO UPDATE SET
              legal_name = EXCLUDED.legal_name,
              registration_number = EXCLUDED.registration_number,
              country_code = EXCLUDED.country_code,
              default_locale = EXCLUDED.default_locale,
              default_currency = EXCLUDED.default_currency,
              logo_asset_ref = EXCLUDED.logo_asset_ref,
              accent_token = EXCLUDED.accent_token,
              updated_at = EXCLUDED.updated_at,
              updated_by_user_id = EXCLUDED.updated_by_user_id
          `,
          values: [
            tenantId,
            organization.businessMetadata.legalName,
            organization.businessMetadata.registrationNumber,
            organization.businessMetadata.countryCode,
            organization.presentation.defaultLocale,
            organization.presentation.defaultCurrency,
            organization.branding.logoAssetRef,
            organization.branding.accentToken,
            changedAt,
            actorUserId,
          ],
        });
        if (settings.rowCount !== 1) throw new Error('TENANT_ORGANIZATION_SETTINGS_UPDATE_FAILED');

        const nextRevision = current.revision + 1;
        const tenant = await client.query({
          name: 'tenant-organization-tenant-update',
          text: `
            UPDATE tenants
            SET display_name = $3,
                organization_revision = $4,
                updated_at = $5
            WHERE id = $1 AND organization_revision = $2
          `,
          values: [tenantId, current.revision, organization.displayName, nextRevision, changedAt],
        });
        if (tenant.rowCount !== 1) throw new Error('TENANT_ORGANIZATION_REVISION_UPDATE_FAILED');

        await ensureSnapshot(client, {
          tenantId,
          revision: nextRevision,
          organization,
          effectiveAt: changedAt,
          actorUserId,
          correlationId,
        });
        const auditEvent = auditEventFor({
          previous: current.organization,
          next: organization,
          nextRevision,
        });
        const audit = await auditRepository.appendWithClient(client, auditEvent);
        if (!audit) throw new Error('AUDIT_APPEND_FAILED');

        return Object.freeze({
          status: 'updated',
          current: Object.freeze({ revision: nextRevision, organization }),
        });
      });
    },
  });
}
