import { publicGuestRoomFields } from '../../domain/request-room-guest-presentation.js';
import { publicSiteGuestInformation } from '../../domain/site-guest-information.js';
import {
  normalizePublicRoomGuestValues,
  normalizePublicSiteGuestValues,
} from '../../domain/public-guest-values.js';
import {
  isRequestId,
  normalizePublicRequest,
  normalizeRequest,
  toPublicRequest,
} from '../../domain/request.js';
import {
  RequestCompositionUnavailableError,
  createRequestCompositionSnapshot,
  normalizeRequestCompositionDraft,
  priceRequestCompositionForSchemaVersion,
} from '../../domain/request-composition.js';
import {
  BOOKING_POLICY_OPERATION,
  evaluateTenantBookingPolicy,
} from '../../domain/tenant-booking-policies.js';
import {
  createTenantCostAllocationSnapshot,
  normalizeTenantCostAllocation,
} from '../../domain/tenant-cost-allocation.js';
import {
  TenantCatalogueValidationError,
  normalizeTenantCatalogue,
  snapshotTenantCatalogueSelection,
} from '../../domain/tenant-catalogue.js';
import { isIanaTimeZone } from '../../domain/site-time-zone.js';
import { normalizeActionAttribution } from '../../domain/request-attribution.js';
import { withPostgresTransaction } from './transaction.js';

const REQUEST_COLUMNS = `
  tenant_id,
  id,
  requester_user_id,
  requester_display_name,
  room_id,
  status,
  status_reason,
  starts_at,
  ends_at,
  internal_participants,
  external_participants,
  schema_version,
  request_version,
  request_snapshot,
  status_changed_at,
  created_at,
  updated_at
`;

function mapRequestRow(row) {
  if (!row) return null;
  return normalizeRequest({
    tenantId: row.tenant_id,
    id: row.id,
    requesterUserId: row.requester_user_id,
    requesterAttribution: { displayName: row.requester_display_name },
    roomId: row.room_id,
    status: row.status,
    statusReason: row.status_reason,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    internalParticipants: row.internal_participants,
    externalParticipants: row.external_participants,
    schemaVersion: Number(row.schema_version ?? 1),
    version: Number(row.request_version ?? 1),
    snapshot: row.request_snapshot ?? null,
    statusChangedAt: row.status_changed_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  });
}

function publicRevisionRequest(row, tenantId) {
  return normalizePublicRequest({
    ...row.record,
    requesterAttribution: { displayName: row.requester_display_name },
  }, { tenantId, requesterUserId: row.requester_user_id });
}

function mapCurrentRoomContextRow(row) {
  if (!row) return null;
  const locationsRevision = Number(row.locations_revision);
  const capacity = Number(row.room_capacity);
  if (
    !Number.isSafeInteger(locationsRevision)
    || locationsRevision < 1
    || !isRequestId(row.room_id)
    || !isRequestId(row.room_site_id)
    || !isRequestId(row.site_id)
    || row.room_site_id !== row.site_id
    || typeof row.room_name !== 'string'
    || row.room_name.length < 1
    || typeof row.site_name !== 'string'
    || row.site_name.length < 1
    || !Number.isSafeInteger(capacity)
    || capacity < 1
    || typeof row.room_active !== 'boolean'
    || typeof row.site_active !== 'boolean'
    || (row.site_time_zone !== null && !isIanaTimeZone(row.site_time_zone))
  ) throw new TypeError('REQUEST_ROOM_CONTEXT_INVALID');

  return Object.freeze({
    locationsRevision,
    room: Object.freeze({
      id: row.room_id,
      siteId: row.room_site_id,
      name: row.room_name,
      capacity,
      active: row.room_active,
    }),
    site: Object.freeze({
      id: row.site_id,
      name: row.site_name,
      active: row.site_active,
      timeZone: row.site_time_zone,
    }),
  });
}

function normalizeRequestRevisionSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('REQUEST_REVISION_SNAPSHOT_INVALID');
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'asOf' || keys[1] !== 'revisionWatermark') {
    throw new TypeError('REQUEST_REVISION_SNAPSHOT_INVALID');
  }
  const parsed = new Date(value.asOf);
  if (
    !Number.isSafeInteger(value.revisionWatermark)
    || value.revisionWatermark < 0
    || Number.isNaN(parsed.getTime())
    || parsed.toISOString() !== value.asOf
  ) throw new TypeError('REQUEST_REVISION_SNAPSHOT_INVALID');
  return Object.freeze({
    revisionWatermark: value.revisionWatermark,
    asOf: value.asOf,
  });
}

async function captureRequestRevisionSnapshotWithClient(client, tenantId) {
  await client.query({
    name: 'request-revision-watermark-lock',
    text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    values: [`request-revision-watermark:${tenantId}`],
  });
  const result = await client.query({
    name: 'request-revision-watermark-capture',
    text: `
      SELECT transaction_timestamp() AS as_of,
        COALESCE(MAX(revision_sequence), 0) AS revision_watermark
      FROM request_revisions
      WHERE tenant_id = $1
    `,
    values: [tenantId],
  });
  const asOf = result.rows[0]?.as_of;
  return normalizeRequestRevisionSnapshot({
    revisionWatermark: Number(result.rows[0]?.revision_watermark),
    asOf: asOf instanceof Date ? asOf.toISOString() : null,
  });
}

async function appendAudit(client, auditRepository, auditEvent) {
  const audit = await auditRepository.appendWithClient(client, auditEvent);
  if (!audit) throw new Error('AUDIT_APPEND_FAILED');
}

export async function lockFinalRequestRoomWithClient(client, tenantId, roomId) {
  await client.query({
    name: 'request-final-room-lock',
    text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    values: [`final-room-confirmation:${tenantId}:${roomId}`],
  });
}

export async function lockRequestCompositionTenantWithClient(client, tenantId) {
  const result = await client.query({
    name: 'request-v2-authority-tenant-order-lock',
    text: "SELECT id FROM tenants WHERE id = $1 AND status = 'active' FOR UPDATE",
    values: [tenantId],
  });
  return result.rowCount === 1;
}

function frozenPrice(row) {
  return Object.freeze({ amountMinor: Number(row.price_minor), currency: row.currency });
}

function frozenApplicability(row) {
  return Object.freeze({
    id: row.id,
    name: row.name,
    description: row.description,
    price: frozenPrice(row),
    active: row.active,
    order: Number(row.sort_order),
    siteIds: Object.freeze([...(row.site_ids || [])].sort()),
    roomIds: Object.freeze([...(row.room_ids || [])].sort()),
  });
}

async function selectedCatalogueWithClient(client, {
  tenantId,
  draft,
  room,
  catalogueRevision,
  capturedAt,
}) {
  const servicesResult = await client.query({
    name: 'request-v2-authority-services',
    text: `
      SELECT
        service.id,
        service.name,
        service.description,
        service.price_minor,
        service.currency,
        service.active,
        service.sort_order,
        ARRAY(
          SELECT relation.site_id
          FROM service_site_applicability relation
          WHERE relation.tenant_id = service.tenant_id
            AND relation.service_id = service.id
          ORDER BY relation.site_id
        ) AS site_ids,
        ARRAY(
          SELECT relation.room_id
          FROM service_room_applicability relation
          WHERE relation.tenant_id = service.tenant_id
            AND relation.service_id = service.id
          ORDER BY relation.room_id
        ) AS room_ids
      FROM services service
      WHERE service.tenant_id = $1
        AND service.id = ANY($2::varchar[])
      FOR SHARE OF service
    `,
    values: [tenantId, draft.serviceIds],
  });

  let packageRow = null;
  let variantRow = null;
  let includedItemIds = [];
  if (draft.catering.packageSelection !== null) {
    const packageResult = await client.query({
      name: 'request-v2-authority-package',
      text: `
        SELECT
          selected_package.id,
          selected_package.name,
          selected_package.description,
          selected_package.price_minor,
          selected_package.currency,
          selected_package.active,
          selected_package.sort_order,
          ARRAY(
            SELECT relation.site_id
            FROM catering_package_site_applicability relation
            WHERE relation.tenant_id = selected_package.tenant_id
              AND relation.package_id = selected_package.id
            ORDER BY relation.site_id
          ) AS site_ids,
          ARRAY(
            SELECT relation.room_id
            FROM catering_package_room_applicability relation
            WHERE relation.tenant_id = selected_package.tenant_id
              AND relation.package_id = selected_package.id
            ORDER BY relation.room_id
          ) AS room_ids,
          ARRAY(
            SELECT relation.item_id
            FROM catering_package_items relation
            WHERE relation.tenant_id = selected_package.tenant_id
              AND relation.package_id = selected_package.id
            ORDER BY relation.item_id
          ) AS item_ids
        FROM catering_packages selected_package
        WHERE selected_package.tenant_id = $1 AND selected_package.id = $2
        FOR SHARE OF selected_package
      `,
      values: [tenantId, draft.catering.packageSelection.packageId],
    });
    packageRow = packageResult.rows[0] ?? null;
    includedItemIds = packageRow?.item_ids ?? [];
    const variantResult = await client.query({
      name: 'request-v2-authority-package-variant',
      text: `
        SELECT id, name, description, price_minor, currency, active, sort_order
        FROM catering_package_variants
        WHERE tenant_id = $1 AND package_id = $2 AND id = $3
        FOR SHARE
      `,
      values: [
        tenantId,
        draft.catering.packageSelection.packageId,
        draft.catering.packageSelection.variantId,
      ],
    });
    variantRow = variantResult.rows[0] ?? null;
  }

  const directItemIds = draft.catering.itemQuantities.map((entry) => entry.itemId);
  const selectedItemIds = [...new Set([...directItemIds, ...includedItemIds])];
  const itemsResult = await client.query({
    name: 'request-v2-authority-catering-items',
    text: `
      SELECT
        item.id,
        item.name,
        item.description,
        item.price_minor,
        item.currency,
        item.active,
        item.sort_order,
        ARRAY(
          SELECT relation.site_id
          FROM catering_item_site_applicability relation
          WHERE relation.tenant_id = item.tenant_id
            AND relation.item_id = item.id
          ORDER BY relation.site_id
        ) AS site_ids,
        ARRAY(
          SELECT relation.room_id
          FROM catering_item_room_applicability relation
          WHERE relation.tenant_id = item.tenant_id
            AND relation.item_id = item.id
          ORDER BY relation.room_id
        ) AS room_ids
      FROM catering_items item
      WHERE item.tenant_id = $1
        AND item.id = ANY($2::varchar[])
      FOR SHARE OF item
    `,
    values: [tenantId, selectedItemIds],
  });

  const equipmentResult = await client.query({
    name: 'request-v3-authority-equipment',
    text: `
      SELECT entry.id, entry.name, entry.description, entry.price_minor,
        entry.currency, entry.active, entry.sort_order,
        ARRAY(
          SELECT relation.site_id FROM equipment_site_applicability relation
          WHERE relation.tenant_id = entry.tenant_id AND relation.equipment_id = entry.id
          ORDER BY relation.site_id
        ) AS site_ids,
        ARRAY(
          SELECT relation.room_id FROM equipment_room_applicability relation
          WHERE relation.tenant_id = entry.tenant_id AND relation.equipment_id = entry.id
          ORDER BY relation.room_id
        ) AS room_ids
      FROM equipment entry
      WHERE entry.tenant_id = $1 AND entry.id = ANY($2::varchar[])
      FOR SHARE OF entry
    `,
    values: [tenantId, draft.equipmentIds ?? []],
  });
  const catalogue = normalizeTenantCatalogue({
    services: servicesResult.rows.map(frozenApplicability),
    equipment: equipmentResult.rows.map(frozenApplicability),
    cateringPackages: packageRow ? [{
      ...frozenApplicability(packageRow),
      itemIds: Object.freeze([...includedItemIds].sort()),
      variants: variantRow ? [Object.freeze({
        id: variantRow.id,
        name: variantRow.name,
        description: variantRow.description,
        price: frozenPrice(variantRow),
        active: variantRow.active,
        order: Number(variantRow.sort_order),
      })] : [],
    }] : [],
    cateringItems: itemsResult.rows.map(frozenApplicability),
    roomPrices: [{ roomId: room.id, price: room.price }],
  });
  const selection = {
    serviceIds: draft.serviceIds,
    equipmentIds: draft.equipmentIds ?? [],
    cateringItemIds: directItemIds,
    catering: draft.catering.packageSelection === null ? [] : [{
      packageId: draft.catering.packageSelection.packageId,
      variantId: draft.catering.packageSelection.variantId,
      itemIds: includedItemIds,
    }],
  };
  try {
    return snapshotTenantCatalogueSelection({
      catalogue,
      revision: catalogueRevision,
      selection,
      siteId: room.siteId,
      roomId: room.id,
      capturedAt,
    });
  } catch (error) {
    if (error instanceof TenantCatalogueValidationError) {
      throw new RequestCompositionUnavailableError();
    }
    throw error;
  }
}

export async function resolveCurrentRequestCompositionWithClient(client, {
  tenantId,
  actorUserId,
  draft: draftValue,
  schemaVersion = 2,
  operation,
  capturedAt,
  requestVersion,
  changeWindowStartsAt,
}) {
  const draft = normalizeRequestCompositionDraft(draftValue, schemaVersion);
  const tenantResult = await client.query({
    name: 'request-v2-authority-tenant-lock',
    text: `
      SELECT
        tenant.organization_revision,
        tenant.locations_revision,
        tenant.catalog_revision,
        tenant.booking_policies_revision,
        tenant.cost_allocation_revision,
        organization.default_currency
      FROM tenants tenant
      JOIN tenant_organization_settings organization
        ON organization.tenant_id = tenant.id
      JOIN users actor
        ON actor.tenant_id = tenant.id AND actor.id = $2 AND actor.active = TRUE
      WHERE tenant.id = $1 AND tenant.status = 'active'
      FOR UPDATE OF tenant, organization
    `,
    values: [tenantId, actorUserId],
  });
  const tenant = tenantResult.rows[0];
  if (!tenant) throw new RequestCompositionUnavailableError();
  const revisions = Object.freeze({
    organization: Number(tenant.organization_revision),
    locations: Number(tenant.locations_revision),
    catalogue: Number(tenant.catalog_revision),
    bookingPolicies: Number(tenant.booking_policies_revision),
    costAllocation: Number(tenant.cost_allocation_revision),
  });
  if (Object.entries(revisions).some(([key, revision]) => (
    draft.configurationRevisions[key] !== revision
  ))) {
    return Object.freeze({ status: 'configuration_conflict', revisions });
  }

  const roomResult = await client.query({
    name: 'request-v2-authority-room',
    text: `
      SELECT
        room.id,
        room.site_id,
        room.name,
        room.capacity,
        room.active AS room_active,
        site.active AS site_active,
        site.time_zone,
        price.price_minor,
        price.currency
      FROM rooms room
      JOIN sites site
        ON site.tenant_id = room.tenant_id AND site.id = room.site_id
      JOIN tenant_room_prices price
        ON price.tenant_id = room.tenant_id AND price.room_id = room.id
      WHERE room.tenant_id = $1 AND room.id = $2
      FOR SHARE OF room, site, price
    `,
    values: [tenantId, draft.roomId],
  });
  const row = roomResult.rows[0];
  const participants = draft.internalParticipants + draft.externalParticipants;
  if (
    !row
    || row.room_active !== true
    || row.site_active !== true
    || !isIanaTimeZone(row.time_zone)
    || row.capacity < participants
  ) throw new RequestCompositionUnavailableError();
  const room = Object.freeze({
    id: row.id,
    siteId: row.site_id,
    name: row.name,
    price: frozenPrice(row),
  });
  const catalogueSnapshot = await selectedCatalogueWithClient(client, {
    tenantId,
    draft,
    room,
    catalogueRevision: revisions.catalogue,
    capturedAt,
  });

  const policyResult = await client.query({
    name: 'request-v2-authority-booking-policy',
    text: `
      SELECT configuration
      FROM tenant_booking_policy_configuration
      WHERE tenant_id = $1
      FOR SHARE
    `,
    values: [tenantId],
  });
  if (!policyResult.rows[0]) throw new RequestCompositionUnavailableError();
  const bookingPolicySnapshot = evaluateTenantBookingPolicy(
    policyResult.rows[0].configuration,
    {
      operation,
      evaluationInstant: new Date(capturedAt),
      startsAt: new Date(draft.startsAt),
      ...(operation === BOOKING_POLICY_OPERATION.CHANGE
        ? { changeWindowStartsAt: new Date(changeWindowStartsAt) }
        : {}),
      siteId: room.siteId,
      roomId: room.id,
      serviceIds: draft.serviceIds,
      participants,
    },
  );

  const allocationConfigurationResult = await client.query({
    name: 'request-v2-authority-allocation-configuration',
    text: `
      SELECT allocation_required
      FROM tenant_cost_allocation_configuration
      WHERE tenant_id = $1
      FOR SHARE
    `,
    values: [tenantId],
  });
  const allocationCentersResult = await client.query({
    name: 'request-v2-authority-allocation-centers',
    text: `
      SELECT id, code, name, group_name, active
      FROM tenant_cost_centers
      WHERE tenant_id = $1
      ORDER BY id
      FOR SHARE
    `,
    values: [tenantId],
  });
  if (!allocationConfigurationResult.rows[0]) throw new RequestCompositionUnavailableError();
  const allocationConfiguration = normalizeTenantCostAllocation({
    allocationRequired: allocationConfigurationResult.rows[0].allocation_required,
    costCenters: allocationCentersResult.rows.map((center) => ({
      id: center.id,
      code: center.code,
      name: center.name,
      group: center.group_name,
      active: center.active,
    })),
  });

  const pricingInput = {
    schemaVersion,
    draft,
    room,
    catalogueSnapshot,
    defaultCurrency: tenant.default_currency,
  };
  const pricing = priceRequestCompositionForSchemaVersion(pricingInput);
  const allocation = createTenantCostAllocationSnapshot(allocationConfiguration, {
    entries: draft.allocations,
    totalMinor: pricing.totalMinor,
    currency: pricing.currency,
  });
  const allocationSnapshot = Object.freeze({
    schemaVersion: 1,
    configurationRevision: revisions.costAllocation,
    snapshottedAt: capturedAt,
    ...allocation,
  });
  const snapshot = createRequestCompositionSnapshot({
    schemaVersion,
    draft,
    requestVersion,
    capturedAt,
    room,
    catalogueSnapshot,
    bookingPolicySnapshot,
    allocationSnapshot,
    revisions,
    defaultCurrency: tenant.default_currency,
  });
  return Object.freeze({ status: 'ready', draft, snapshot });
}

export async function appendRequestRevisionWithClient(
  client, request, operation, auditEvent, actorRoleAtAction,
) {
  await client.query({
    name: 'request-revision-watermark-lock',
    text: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    values: [`request-revision-watermark:${request.tenantId}`],
  });
  const { requesterAttribution, ...record } = toPublicRequest(request);
  if (!requesterAttribution) throw new TypeError('REQUEST_ATTRIBUTION_INVALID');
  const inserted = await client.query({
    name: 'request-revision-append',
    text: `
      INSERT INTO request_revisions (
        tenant_id,
        request_id,
        request_version,
        schema_version,
        operation,
        record,
        captured_at,
        actor_user_id,
        correlation_id,
        actor_role_at_action
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
      RETURNING revision_sequence
    `,
    values: [
      request.tenantId,
      request.id,
      request.version,
      request.schemaVersion,
      operation,
      JSON.stringify(record),
      new Date(request.updatedAt),
      auditEvent.actorUserId,
      auditEvent.correlationId,
      actorRoleAtAction,
    ],
  });
  const revisionSequence = Number(inserted.rows[0]?.revision_sequence);
  if (
    inserted.rowCount !== 1
    || !Number.isSafeInteger(revisionSequence)
    || revisionSequence < 1
  ) throw new Error('REQUEST_REVISION_APPEND_FAILED');
  const pointed = await client.query({
    name: 'request-current-revision-point',
    text: `
      UPDATE requests
      SET current_revision_sequence = $3
      WHERE tenant_id = $1
        AND id = $2
        AND request_version = $4
    `,
    values: [request.tenantId, request.id, revisionSequence, request.version],
  });
  if (pointed.rowCount !== 1) throw new Error('REQUEST_REVISION_POINTER_FAILED');
  return revisionSequence;
}

export function createPostgresRequestRepository(
  pool,
  { auditRepository, calendarAuthorityGuard } = {},
) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('POSTGRES_POOL_REQUIRED');
  }
  if (!auditRepository || typeof auditRepository.appendWithClient !== 'function') {
    throw new TypeError('AUDIT_REPOSITORY_REQUIRED');
  }
  if (
    !calendarAuthorityGuard
    || typeof calendarAuthorityGuard.lockCurrent !== 'function'
    || typeof calendarAuthorityGuard.completePreConfirmationCleanup !== 'function'
  ) {
    throw new TypeError('CALENDAR_AUTHORITY_GUARD_REQUIRED');
  }

  return Object.freeze({
    async findByTenantIdAndId(tenantId, requestId) {
      const result = await pool.query({
        name: 'request-find-by-tenant-and-id',
        text: `
          SELECT ${REQUEST_COLUMNS}
          FROM requests
          WHERE tenant_id = $1
            AND id = $2
          LIMIT 1
        `,
        values: [tenantId, requestId],
      });
      return mapRequestRow(result.rows[0]);
    },

    async findRoomContextByTenantIdAndRoomId(tenantId, roomId) {
      const result = await pool.query({
        name: 'request-room-context-by-tenant-and-room',
        text: `
          SELECT
            tenant.locations_revision,
            room.id AS room_id,
            room.site_id AS room_site_id,
            room.name AS room_name,
            room.capacity AS room_capacity,
            room.active AS room_active,
            site.id AS site_id,
            site.name AS site_name,
            site.active AS site_active,
            site.time_zone AS site_time_zone
          FROM tenants tenant
          JOIN rooms room
            ON room.tenant_id = tenant.id
          JOIN sites site
            ON site.tenant_id = room.tenant_id
            AND site.id = room.site_id
          WHERE tenant.id = $1
            AND room.id = $2
          LIMIT 1
        `,
        values: [tenantId, roomId],
      });
      return mapCurrentRoomContextRow(result.rows[0]);
    },

    async findGuestContextByTenantIdAndRequest(tenantId, requestId, expectedVersion, schemaVersion = 2) {
      const result = await pool.query({
        name: 'request-guest-context-by-tenant-request-version',
        text: `
          SELECT tenant.locations_revision,
            room.id AS room_id, room.site_id AS room_site_id,
            room.name AS room_name, room.capacity AS room_capacity,
            room.active AS room_active, room.details AS room_details,
            site.id AS site_id, site.name AS site_name, site.active AS site_active,
            site.time_zone AS site_time_zone, site.guest_information,
            site.guest_public_values AS site_guest_public_values,
            room.guest_public_values AS room_guest_public_values
          FROM requests request
          JOIN tenants tenant ON tenant.id = request.tenant_id
          JOIN rooms room ON room.tenant_id = request.tenant_id AND room.id = request.room_id
          JOIN sites site ON site.tenant_id = room.tenant_id AND site.id = room.site_id
          WHERE request.tenant_id = $1 AND request.id = $2
            AND request.request_version = $3 AND request.status = 'Confirmed'
          LIMIT 1
        `,
        values: [tenantId, requestId, expectedVersion],
      });
      const row = result.rows[0];
      if (!row) return null;
      const context = mapCurrentRoomContextRow(row);
      return Object.freeze({
        ...context,
        room: Object.freeze({
          ...context.room, ...publicGuestRoomFields(row.room_details),
          ...(schemaVersion === 3
            ? { guestPublicValues: normalizePublicRoomGuestValues(row.room_guest_public_values) } : {}),
        }),
        guestPresentation: publicSiteGuestInformation(row.guest_information),
        ...(schemaVersion === 3
          ? { guestPublicValues: normalizePublicSiteGuestValues(row.site_guest_public_values) } : {}),
      });
    },

    async listByTenantId(tenantId, { requesterUserId = null, limit = 500 } = {}) {
      const result = await pool.query({
        name: 'request-list-by-tenant',
        text: `
          SELECT ${REQUEST_COLUMNS}
          FROM requests
          WHERE tenant_id = $1
            AND ($2::uuid IS NULL OR requester_user_id = $2::uuid)
          ORDER BY starts_at DESC, id
          LIMIT $3
        `,
        values: [tenantId, requesterUserId, limit],
      });
      return result.rows.map(mapRequestRow);
    },

    async listPageByTenantId({
      tenantId,
      requesterUserId = null,
      snapshot = null,
      afterStartsAt = null,
      afterRequestId = null,
      limit,
    }) {
      if (
        !Number.isSafeInteger(limit)
        || limit < 1
        || limit > 11
        || (afterStartsAt === null) !== (afterRequestId === null)
        || (afterRequestId !== null && !isRequestId(afterRequestId))
        || (
          afterStartsAt !== null
          && (!(afterStartsAt instanceof Date) || Number.isNaN(afterStartsAt.getTime()))
        )
      ) throw new TypeError('APPLICATION_REQUEST_LIST_QUERY_INVALID');
      const normalizedSnapshot = snapshot === null
        ? null
        : normalizeRequestRevisionSnapshot(snapshot);
      return withPostgresTransaction(pool, async (client) => {
        const selectedSnapshot = normalizedSnapshot
          ?? await captureRequestRevisionSnapshotWithClient(client, tenantId);
        const result = await client.query({
          name: 'application-request-list-page-by-tenant',
          text: `
            WITH current_records AS (
              SELECT revision.record, request.requester_user_id, request.requester_display_name,
                request.starts_at, request.id
              FROM requests request
              JOIN request_revisions revision
                ON revision.revision_sequence = request.current_revision_sequence
               AND revision.tenant_id = request.tenant_id
               AND revision.request_id = request.id
              WHERE request.tenant_id = $1
                AND ($2::uuid IS NULL OR request.requester_user_id = $2::uuid)
                AND request.current_revision_sequence <= $3
                AND (
                  $4::timestamptz IS NULL
                  OR request.starts_at < $4
                  OR (request.starts_at = $4 AND request.id > $5)
                )
            ),
            historical_records AS (
              SELECT DISTINCT ON (request.id)
                revision.record, request.requester_user_id, request.requester_display_name,
                (revision.record ->> 'startsAt')::timestamptz AS starts_at,
                request.id
              FROM requests request
              JOIN request_revisions revision
                ON revision.tenant_id = request.tenant_id
               AND revision.request_id = request.id
               AND revision.revision_sequence <= $3
              WHERE request.tenant_id = $1
                AND ($2::uuid IS NULL OR request.requester_user_id = $2::uuid)
                AND request.current_revision_sequence > $3
              ORDER BY request.id, revision.revision_sequence DESC
            ),
            candidates AS (
              SELECT * FROM current_records
              UNION ALL
              SELECT *
              FROM historical_records
              WHERE $4::timestamptz IS NULL
                 OR starts_at < $4
                 OR (starts_at = $4 AND id > $5)
            )
            SELECT record, requester_user_id, requester_display_name
            FROM candidates
            ORDER BY starts_at DESC, id
            LIMIT $6
          `,
          values: [
            tenantId,
            requesterUserId,
            selectedSnapshot.revisionWatermark,
            afterStartsAt,
            afterRequestId,
            limit,
          ],
        });
        return Object.freeze({
          status: 'ready',
          snapshot: selectedSnapshot,
          requests: Object.freeze(result.rows.map((row) => publicRevisionRequest(row, tenantId))),
        });
      }, { isolationLevel: 'READ COMMITTED', readOnly: true });
    },

    async listReportPageByTenantId({
      tenantId,
      from,
      to,
      snapshot = null,
      afterStartsAt = null,
      afterRequestId = null,
      limit,
    }) {
      if (
        !(from instanceof Date)
        || Number.isNaN(from.getTime())
        || !(to instanceof Date)
        || Number.isNaN(to.getTime())
        || to <= from
        || !Number.isSafeInteger(limit)
        || limit < 1
        || limit > 201
        || (afterStartsAt === null) !== (afterRequestId === null)
        || (afterRequestId !== null && !isRequestId(afterRequestId))
        || (
          afterStartsAt !== null
          && (!(afterStartsAt instanceof Date) || Number.isNaN(afterStartsAt.getTime()))
        )
        || (afterStartsAt !== null && (afterStartsAt < from || afterStartsAt >= to))
      ) throw new TypeError('REQUEST_REPORT_QUERY_INVALID');
      const normalizedSnapshot = snapshot === null
        ? null
        : normalizeRequestRevisionSnapshot(snapshot);
      return withPostgresTransaction(pool, async (client) => {
        const selectedSnapshot = normalizedSnapshot
          ?? await captureRequestRevisionSnapshotWithClient(client, tenantId);
        const result = await client.query({
          name: 'request-report-page-by-tenant',
          text: `
            WITH current_records AS (
              SELECT revision.record, request.requester_user_id, request.requester_display_name,
                request.starts_at, request.id
              FROM requests request
              JOIN request_revisions revision
                ON revision.revision_sequence = request.current_revision_sequence
               AND revision.tenant_id = request.tenant_id
               AND revision.request_id = request.id
              WHERE request.tenant_id = $1
                AND request.current_revision_sequence <= $4
                AND request.starts_at >= $2
                AND request.starts_at < $3
                AND (
                  $5::timestamptz IS NULL
                  OR request.starts_at > $5
                  OR (request.starts_at = $5 AND request.id > $6)
                )
            ),
            historical_records AS (
              SELECT DISTINCT ON (request.id)
                revision.record, request.requester_user_id, request.requester_display_name,
                (revision.record ->> 'startsAt')::timestamptz AS starts_at,
                request.id
              FROM requests request
              JOIN request_revisions revision
                ON revision.tenant_id = request.tenant_id
               AND revision.request_id = request.id
               AND revision.revision_sequence <= $4
              WHERE request.tenant_id = $1
                AND request.current_revision_sequence > $4
              ORDER BY request.id, revision.revision_sequence DESC
            ),
            candidates AS (
              SELECT * FROM current_records
              UNION ALL
              SELECT *
              FROM historical_records
              WHERE starts_at >= $2
                AND starts_at < $3
                AND (
                  $5::timestamptz IS NULL
                  OR starts_at > $5
                  OR (starts_at = $5 AND id > $6)
                )
            )
            SELECT record, requester_user_id, requester_display_name
            FROM candidates
            ORDER BY starts_at, id
            LIMIT $7
          `,
          values: [
            tenantId,
            from,
            to,
            selectedSnapshot.revisionWatermark,
            afterStartsAt,
            afterRequestId,
            limit,
          ],
        });
        return Object.freeze({
          status: 'ready',
          snapshot: selectedSnapshot,
          requests: Object.freeze(result.rows.map((row) => publicRevisionRequest(row, tenantId))),
        });
      }, { isolationLevel: 'READ COMMITTED', readOnly: true });
    },

    async listHistoryPageByTenantIdAndId(tenantId, requestId, {
      asOfVersion,
      beforeVersion = null,
      limit,
    } = {}) {
      if (
        !isRequestId(requestId)
        || !Number.isSafeInteger(asOfVersion)
        || asOfVersion < 1
        || asOfVersion >= Number.MAX_SAFE_INTEGER
        || (
          beforeVersion !== null
          && (
            !Number.isSafeInteger(beforeVersion)
            || beforeVersion < 1
            || beforeVersion > asOfVersion
          )
        )
        || !Number.isSafeInteger(limit)
        || limit < 1
        || limit > 11
      ) throw new TypeError('REQUEST_HISTORY_PAGE_INVALID');
      const result = await pool.query({
        name: 'request-history-page-by-tenant-and-id',
        text: `
          SELECT revision.request_version, revision.schema_version, revision.operation,
            revision.record, revision.captured_at, revision.actor_display_name, revision.actor_role_at_action,
            request.requester_user_id, request.requester_display_name
          FROM request_revisions revision
          JOIN requests request
            ON request.tenant_id = revision.tenant_id AND request.id = revision.request_id
          WHERE revision.tenant_id = $1 AND revision.request_id = $2
            AND revision.request_version <= $3
            AND ($4::bigint IS NULL OR revision.request_version < $4::bigint)
          ORDER BY revision.request_version DESC
          LIMIT $5
        `,
        values: [tenantId, requestId, asOfVersion, beforeVersion, limit],
      });
      return Object.freeze(result.rows.map((row) => Object.freeze({
        version: Number(row.request_version),
        schemaVersion: Number(row.schema_version),
        operation: row.operation,
        actorAttribution: row.actor_display_name === null ? null : normalizeActionAttribution({
          displayName: row.actor_display_name, roleAtAction: row.actor_role_at_action,
        }),
        capturedAt: row.captured_at.toISOString(),
        request: publicRevisionRequest(row, tenantId),
      })));
    },

    async createVersionedForTenant({
      tenantId,
      requestId,
      requesterUserId,
      schemaVersion = 2,
      requestDraft,
      createdAt,
      auditEvent,
    }) {
      return withPostgresTransaction(pool, async (client) => {
        const capturedAt = createdAt.toISOString();
        const authority = await resolveCurrentRequestCompositionWithClient(client, {
          tenantId,
          actorUserId: requesterUserId,
          schemaVersion,
          draft: requestDraft,
          operation: BOOKING_POLICY_OPERATION.CREATE,
          capturedAt,
          requestVersion: 1,
        });
        if (authority.status !== 'ready') return authority;
        const { draft, snapshot } = authority;
        const result = await client.query({
          name: 'request-v2-create-for-tenant',
          text: `
            INSERT INTO requests (
              tenant_id,
              id,
              requester_user_id,
              room_id,
              status,
              starts_at,
              ends_at,
              internal_participants,
              external_participants,
              schema_version,
              request_version,
              request_snapshot,
              status_changed_at,
              created_at,
              updated_at
            )
            VALUES (
              $1, $2, $3, $4, 'Submitted', $5, $6, $7, $8,
              $11, 1, $9::jsonb, $10, $10, $10
            )
            RETURNING ${REQUEST_COLUMNS}
          `,
          values: [
            tenantId,
            requestId,
            requesterUserId,
            draft.roomId,
            new Date(draft.startsAt),
            new Date(draft.endsAt),
            draft.internalParticipants,
            draft.externalParticipants,
            JSON.stringify(snapshot),
            createdAt,
            schemaVersion,
          ],
        });
        const request = mapRequestRow(result.rows[0]);
        if (!request) throw new Error('REQUEST_CREATE_FAILED');
        await appendRequestRevisionWithClient(client, request, 'created', auditEvent, 'employee');
        await appendAudit(client, auditRepository, auditEvent);
        return Object.freeze({ status: 'created', request });
      });
    },

    async resubmitVersionedForTenant({
      tenantId,
      requestId,
      requesterUserId,
      schemaVersion = 2,
      expectedVersion,
      requestDraft,
      changedAt,
      auditEvent,
    }) {
      return withPostgresTransaction(pool, async (client) => {
        if (!await lockRequestCompositionTenantWithClient(client, tenantId)) {
          return Object.freeze({ status: 'not_found' });
        }
        const locked = await client.query({
          name: 'request-v2-resubmit-lock',
          text: `
            SELECT ${REQUEST_COLUMNS}
            FROM requests
            WHERE tenant_id = $1 AND id = $2
            FOR UPDATE
          `,
          values: [tenantId, requestId],
        });
        const current = mapRequestRow(locked.rows[0]);
        if (!current || current.requesterUserId !== requesterUserId) {
          return Object.freeze({ status: 'not_found' });
        }
        if (current.version !== expectedVersion || current.status !== 'Change Requested') {
          return Object.freeze({ status: 'state_conflict' });
        }
        const nextVersion = current.version + 1;
        const authority = await resolveCurrentRequestCompositionWithClient(client, {
          tenantId,
          actorUserId: requesterUserId,
          schemaVersion,
          draft: requestDraft,
          operation: BOOKING_POLICY_OPERATION.RESUBMIT,
          capturedAt: changedAt.toISOString(),
          requestVersion: nextVersion,
        });
        if (authority.status !== 'ready') return authority;
        const { draft, snapshot } = authority;
        const updated = await client.query({
          name: 'request-v2-resubmit-update',
          text: `
            UPDATE requests
            SET room_id = $4,
                starts_at = $5,
                ends_at = $6,
                internal_participants = $7,
                external_participants = $8,
                schema_version = $13,
                request_version = $9,
                request_snapshot = $10::jsonb,
                status = 'Submitted',
                status_reason = NULL,
                status_changed_at = $11,
                updated_at = $11
            WHERE tenant_id = $1
              AND id = $2
              AND requester_user_id = $3
              AND request_version = $12
              AND status = 'Change Requested'
            RETURNING ${REQUEST_COLUMNS}
          `,
          values: [
            tenantId,
            requestId,
            requesterUserId,
            draft.roomId,
            new Date(draft.startsAt),
            new Date(draft.endsAt),
            draft.internalParticipants,
            draft.externalParticipants,
            nextVersion,
            JSON.stringify(snapshot),
            changedAt,
            expectedVersion,
            schemaVersion,
          ],
        });
        const request = mapRequestRow(updated.rows[0]);
        if (!request) return Object.freeze({ status: 'state_conflict' });
        await appendRequestRevisionWithClient(client, request, 'resubmitted', auditEvent, 'employee');
        await appendAudit(client, auditRepository, auditEvent);
        return Object.freeze({ status: 'resubmitted', request });
      });
    },

    async transitionByTenantIdAndId({
      tenantId,
      requestId,
      actorUserId,
      actorRoleAtAction,
      expectedStatus,
      expectedVersion,
      nextStatus,
      reason,
      changedAt,
      auditEvent,
      bookingChangeAuditEvent,
    }) {
      return withPostgresTransaction(pool, async (client) => {
        if (!await lockRequestCompositionTenantWithClient(client, tenantId)) return null;
        const locked = await client.query({
          name: 'request-transition-lock-request',
          text: `
            SELECT ${REQUEST_COLUMNS}
            FROM requests
            WHERE tenant_id = $1 AND id = $2
            FOR UPDATE
          `,
          values: [tenantId, requestId],
        });
        const current = mapRequestRow(locked.rows[0]);
        if (
          !current
          || current.status !== expectedStatus
          || current.version !== expectedVersion
        ) return null;
        const openChange = await client.query({
          name: 'request-transition-lock-open-booking-change',
          text: `
            SELECT id, status
            FROM booking_change_requests
            WHERE tenant_id = $1
              AND request_id = $2
              AND status IN ('pending', 'applying')
            LIMIT 1
            FOR UPDATE
          `,
          values: [tenantId, requestId],
        });
        let appendBookingChangeAudit = false;
        if (openChange.rows[0]?.status === 'applying') return null;
        if (openChange.rows[0]?.status === 'pending') {
          if (current.status !== 'Confirmed' || nextStatus === 'Confirmed') return null;
          const superseded = await client.query({
            name: 'request-transition-supersede-booking-change',
            text: `
              UPDATE booking_change_requests
              SET status = 'superseded',
                  decided_by_user_id = $4,
                  decider_role_at_action = $6,
                  updated_at = $5
              WHERE tenant_id = $1
                AND request_id = $2
                AND id = $3
                AND status = 'pending'
            `,
            values: [tenantId, requestId, openChange.rows[0].id, actorUserId, changedAt, actorRoleAtAction],
          });
          if (superseded.rowCount !== 1 || !bookingChangeAuditEvent) {
            throw new Error('BOOKING_CHANGE_SUPERSEDE_FAILED');
          }
          appendBookingChangeAudit = true;
        }
        const result = await client.query({
          name: 'request-transition-by-tenant-and-id',
          text: `
            UPDATE requests
            SET status = $5,
              status_reason = $6,
              status_changed_at = $7,
              updated_at = $7,
              request_version = request_version + 1,
              request_snapshot = CASE
                WHEN schema_version IN (2, 3) THEN jsonb_set(
                  request_snapshot,
                  '{requestVersion}',
                  to_jsonb(request_version + 1)
                )
                ELSE NULL
              END
            WHERE tenant_id = $1
              AND id = $2
              AND status = $3
              AND request_version = $4
            RETURNING ${REQUEST_COLUMNS}
          `,
          values: [
            tenantId,
            requestId,
            expectedStatus,
            expectedVersion,
            nextStatus,
            reason,
            changedAt,
          ],
        });
        const request = mapRequestRow(result.rows[0]);
        if (!request) return null;
        await appendRequestRevisionWithClient(client, request, 'transitioned', auditEvent, actorRoleAtAction);
        if (appendBookingChangeAudit) {
          await appendAudit(client, auditRepository, bookingChangeAuditEvent);
        }
        await appendAudit(client, auditRepository, auditEvent);
        return request;
      });
    },

    async confirmIfRoomAvailable({
      tenantId,
      requestId,
      expectedStatus,
      expectedVersion,
      calendarAuthority,
      calendarCleanup = null,
      changedAt,
      auditEvent,
    }) {
      return withPostgresTransaction(pool, async (client) => {
        const locked = await client.query({
          name: 'request-final-confirm-lock-request',
          text: `
            SELECT ${REQUEST_COLUMNS}
            FROM requests
            WHERE tenant_id = $1 AND id = $2
            FOR UPDATE
          `,
          values: [tenantId, requestId],
        });
        const current = mapRequestRow(locked.rows[0]);
        if (
          !current
          || current.status !== expectedStatus
          || current.version !== expectedVersion
          || !current.roomId
        ) {
          return Object.freeze({ status: 'state_conflict', request: current });
        }

        if (!await calendarAuthorityGuard.lockCurrent(
          client,
          {
            tenantId,
            requestId,
            authority: calendarAuthority,
            cleanupReference: calendarCleanup?.reference ?? null,
          },
        )) {
          return Object.freeze({ status: 'provider_authority_conflict', request: current });
        }

        await lockFinalRequestRoomWithClient(client, tenantId, current.roomId);
        const conflict = await client.query({
          name: 'request-final-confirm-room-conflict',
          text: `
            SELECT 1
            FROM requests
            WHERE tenant_id = $1
              AND room_id = $2
              AND id <> $3
              AND status = 'Confirmed'
              AND starts_at < $5
              AND ends_at > $4
            LIMIT 1
          `,
          values: [tenantId, current.roomId, requestId, current.startsAt, current.endsAt],
        });
        if (conflict.rowCount > 0) {
          return Object.freeze({ status: 'room_conflict', request: current });
        }

        const result = await client.query({
          name: 'request-final-confirm-update',
          text: `
            UPDATE requests
            SET status = 'Confirmed',
                status_reason = NULL,
                status_changed_at = $5,
                updated_at = $5,
                request_version = request_version + 1,
                request_snapshot = CASE
                  WHEN schema_version IN (2, 3) THEN jsonb_set(
                    request_snapshot,
                    '{requestVersion}',
                    to_jsonb(request_version + 1)
                  )
                  ELSE NULL
                END
            WHERE tenant_id = $1
              AND id = $2
              AND status = $3
              AND request_version = $4
            RETURNING ${REQUEST_COLUMNS}
          `,
          values: [tenantId, requestId, expectedStatus, expectedVersion, changedAt],
        });
        const confirmed = mapRequestRow(result.rows[0]);
        if (!confirmed) return Object.freeze({ status: 'state_conflict', request: current });
        if (calendarCleanup !== null) {
          const completed = await calendarAuthorityGuard.completePreConfirmationCleanup(client, {
            tenantId,
            requestId,
            reference: calendarCleanup.reference,
            changedAt,
          });
          if (!completed) throw new Error('CALENDAR_CLEANUP_FINALIZE_FAILED');
        }
        await appendRequestRevisionWithClient(client, confirmed, 'transitioned', auditEvent, 'conference_manager');
        if (calendarCleanup !== null) {
          await appendAudit(client, auditRepository, calendarCleanup.auditEvent);
        }
        await appendAudit(client, auditRepository, auditEvent);
        return Object.freeze({ status: 'confirmed', request: confirmed });
      });
    },
  });
}
