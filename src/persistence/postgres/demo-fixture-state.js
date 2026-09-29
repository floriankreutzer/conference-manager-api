import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tenantAuthorizationSnapshot } from '../../authorization/policy.js';
import { normalizeRequest } from '../../domain/request.js';
import { semanticChecksum } from '../../demo/fixture.js';
import {
  appendRequestRevisionWithClient,
  resolveCurrentRequestCompositionWithClient,
} from './request-repository.js';
import { refreshPlatformProjectionBatchWithClient } from './platform-projection-repository.js';
import {
  DEMO_RUNTIME_SCHEMA_VERSION,
  DEMO_SEED_VERSION,
} from '../../demo/runtime-contract.js';

function requireClient(client) {
  if (!client || typeof client.query !== 'function') throw new TypeError('POSTGRES_CLIENT_REQUIRED');
}

function iso(value) {
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError('DEMO_SEMANTIC_TIME_INVALID');
  return new Date(parsed).toISOString();
}

function safeInteger(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new TypeError('DEMO_SEMANTIC_INTEGER_INVALID');
  return number;
}

function displayName(persona) {
  return persona.split('_').map((word) => `${word[0].toUpperCase()}${word.slice(1)}`).join(' ');
}

async function seedTenants(client, fixture) {
  for (const tenant of fixture.tenants) {
    await client.query({
      name: 'demo-fixture-insert-tenant',
      text: `
        INSERT INTO tenants (
          id, display_name, status, lifecycle_revision, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $5)
      `,
      values: [
        tenant.id,
        tenant.displayName,
        tenant.lifecycleStatus,
        tenant.lifecycleRevision,
        fixture.fixedClock,
      ],
    });
  }
}

async function seedCustomerIdentities(client, fixture) {
  for (const persona of fixture.customerPersonas) {
    await client.query({
      name: 'demo-fixture-insert-user',
      text: `
        INSERT INTO users (
          tenant_id, id, display_name, active, security_version,
          lifecycle_revision, created_at, updated_at
        )
        VALUES ($1, $2, $3, true, $4, 1, $5, $5)
      `,
      values: [
        persona.tenantId,
        persona.userId,
        displayName(persona.persona),
        persona.securityVersion,
        fixture.fixedClock,
      ],
    });
    await client.query({
      name: 'demo-fixture-insert-user-identity',
      text: `
        INSERT INTO user_identity_bindings (
          tenant_id, provider, provider_tenant_reference,
          provider_user_reference, user_id, created_at, updated_at
        )
        VALUES ($1::uuid, $2, $1::text, $3, $4, $5, $5)
      `,
      values: [
        persona.tenantId,
        persona.providerIdentity.provider,
        persona.providerIdentity.reference,
        persona.userId,
        fixture.fixedClock,
      ],
    });
    for (const role of persona.roles.filter((candidate) => candidate !== 'employee')) {
      await client.query({
        name: 'demo-fixture-insert-user-role',
        text: `
          INSERT INTO tenant_user_roles (tenant_id, user_id, role, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $4)
        `,
        values: [persona.tenantId, persona.userId, role, fixture.fixedClock],
      });
    }
  }
}

function catalogueSnapshot(tenant) {
  const catalogue = tenant.settings.catalogue;
  const roomPrices = tenant.settings.locations.flatMap(({ rooms }) => rooms
    .filter(({ priceMinor }) => priceMinor !== null)
    .map(({ id, priceMinor }) => ({
      roomId: id,
      price: { amountMinor: priceMinor, currency: catalogue.currency },
    })));
  return {
    services: catalogue.services.map((id) => ({
      id, name: displayName(id), description: null, active: true, order: 0,
      price: { amountMinor: 0, currency: catalogue.currency }, siteIds: [], roomIds: [],
    })),
    equipment: catalogue.equipment,
    cateringPackages: catalogue.cateringPackages,
    cateringItems: catalogue.cateringItems,
    roomPrices,
  };
}

function mediaAssetKey(roomId) {
  const northwind = roomId.match(/^northwind-berlin-room-(10|[1-9])$/);
  if (northwind) return `northwind-room-${northwind[1].padStart(2, '0')}`;
  if (roomId === 'contoso-paris-room-1') return roomId;
  throw new Error('DEMO_FIXTURE_MEDIA_ROOM_INVALID');
}

async function verifiedMediaBytes(media) {
  const encoded = await readFile(new URL(
    `../../demo/media/${mediaAssetKey(media.roomId)}.webp.b64`, import.meta.url,
  ), 'utf8');
  const bytes = Buffer.from(encoded.trim(), 'base64');
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== media.byteLength || digest !== media.sha256
    || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WEBP') {
    throw new Error('DEMO_FIXTURE_MEDIA_BYTES_INVALID');
  }
  return bytes;
}

async function verifiedCatalogueBytes(media) {
  const suffix = media.contentType === 'image/png' ? '-plan.png' : '.webp';
  const prefix = media.contentType === 'image/png' ? 'rooms-' : 'catering-';
  const encoded = await readFile(new URL(
    `../../demo/media/${prefix}${media.assetKey}${suffix}.b64`, import.meta.url,
  ), 'utf8');
  const bytes = Buffer.from(encoded.trim(), 'base64');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const signatureValid = media.contentType === 'image/png'
    ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : bytes.toString('ascii', 0, 4) === 'RIFF'
      && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!signatureValid || bytes.length !== media.byteLength || digest !== media.sha256) {
    throw new Error('DEMO_FIXTURE_CATALOGUE_MEDIA_BYTES_INVALID');
  }
  return bytes;
}

async function seedTenantBusinessState(client, fixture) {
  for (const tenant of fixture.tenants) {
    await client.query({
      name: 'demo-fixture-update-organization',
      text: `
        UPDATE tenant_organization_settings
        SET legal_name = $2,
            country_code = $3,
            default_currency = $4,
            updated_at = $5
        WHERE tenant_id = $1
      `,
      values: [
        tenant.id,
        tenant.settings.organization.name,
        tenant.settings.organization.countryCode,
        tenant.settings.catalogue.currency,
        fixture.fixedClock,
      ],
    });
    const advancedOrganization = await client.query({
      name: 'demo-fixture-advance-organization-revision',
      text: `
        UPDATE tenants
        SET organization_revision = 2,
            updated_at = $2
        WHERE id = $1 AND organization_revision = 1
      `,
      values: [tenant.id, fixture.fixedClock],
    });
    if (advancedOrganization.rowCount !== 1) {
      throw new Error('DEMO_FIXTURE_ORGANIZATION_REVISION_ADVANCE_FAILED');
    }
    const organizationRevision = await client.query({
      name: 'demo-fixture-insert-organization-revision',
      text: `
        INSERT INTO tenant_organization_revisions (
          tenant_id,
          revision,
          snapshot,
          effective_at,
          actor_user_id,
          correlation_id
        )
        VALUES (
          $1,
          2,
          jsonb_build_object(
            'displayName', $2::text,
            'businessMetadata', jsonb_build_object(
              'legalName', $3::text,
              'registrationNumber', NULL,
              'countryCode', $4::text
            ),
            'presentation', jsonb_build_object(
              'defaultLocale', 'de-DE',
              'defaultCurrency', $5::text
            ),
            'branding', jsonb_build_object(
              'logoAssetRef', NULL,
              'accentToken', 'default'
            )
          ),
          $6,
          NULL,
          NULL
        )
      `,
      values: [
        tenant.id,
        tenant.displayName,
        tenant.settings.organization.name,
        tenant.settings.organization.countryCode,
        tenant.settings.catalogue.currency,
        fixture.fixedClock,
      ],
    });
    if (organizationRevision.rowCount !== 1) {
      throw new Error('DEMO_FIXTURE_ORGANIZATION_REVISION_INSERT_FAILED');
    }
    for (const location of tenant.settings.locations) {
      await client.query({
        name: 'demo-fixture-insert-site',
        text: `
          INSERT INTO sites (tenant_id, id, name, active, time_zone, details, created_at, updated_at, guest_information)
          VALUES ($1, $2, $3, true, $4, '{}'::jsonb, $5, $5, $6::jsonb)
        `,
        values: [tenant.id, location.id, location.name, location.timeZone,
          fixture.fixedClock, JSON.stringify(location.guestInformation)],
      });
      for (const room of location.rooms) {
        await client.query({
          name: 'demo-fixture-insert-room',
          text: `
            INSERT INTO rooms (
              tenant_id, id, site_id, name, capacity, active, details, created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, true, $6::jsonb, $7, $7)
          `,
          values: [
            tenant.id,
            room.id,
            location.id,
            room.name,
            room.capacity,
            JSON.stringify({
              description: room.description,
              floor: room.floor, equipment: room.equipment, accessibility: room.accessibility,
              mediaAssetIds: tenant.roomMedia.filter(({ roomId }) => roomId === room.id).map(({ id }) => id),
              floorplanAssetId: tenant.catalogueMedia.find(({ ownerKind, ownerId }) =>
                ownerKind === 'room_plan' && ownerId === room.id)?.id ?? null,
            }),
            fixture.fixedClock,
          ],
        });
        if (room.priceMinor !== null) await client.query({
          name: 'demo-fixture-insert-room-price',
          text: `
            INSERT INTO tenant_room_prices (
              tenant_id, room_id, price_minor, currency, created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $5)
          `,
          values: [
            tenant.id,
            room.id,
            room.priceMinor,
            tenant.settings.catalogue.currency,
            fixture.fixedClock,
          ],
        });
      }
    }
    for (const media of tenant.roomMedia) {
      const bytes = await verifiedMediaBytes(media);
      const creator = fixture.customerPersonas.find(({ tenantId, persona }) => (
        tenantId === tenant.id && persona === 'tenant_admin'
      ));
      if (!creator) throw new Error('DEMO_FIXTURE_MEDIA_CREATOR_INVALID');
      await client.query({
        name: 'demo-fixture-insert-room-media',
        text: `INSERT INTO tenant_room_media_assets (
          tenant_id, id, room_id, bytes, content_type, byte_length,
          width, height, content_sha256, created_at, created_by_user_id
        ) VALUES ($1, $2, $3, $4, 'image/webp', $5, $6, $7, $8, $9, $10)`,
        values: [tenant.id, media.id, media.roomId, bytes, media.byteLength,
          media.width, media.height, Buffer.from(media.sha256, 'hex'), fixture.fixedClock, creator.userId],
      });
    }
    for (const media of tenant.catalogueMedia) {
      const bytes = await verifiedCatalogueBytes(media);
      const creator = fixture.customerPersonas.find(({ tenantId, persona }) =>
        tenantId === tenant.id && persona === 'tenant_admin');
      if (!creator) throw new Error('DEMO_FIXTURE_CATALOGUE_MEDIA_CREATOR_INVALID');
      await client.query({
        name: 'demo-fixture-insert-catalogue-media',
        text: `INSERT INTO demo_catalogue_media_assets (
          tenant_id, id, owner_kind, owner_id, bytes, content_type,
          byte_length, content_sha256, alt_text, created_at, created_by_user_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        values: [tenant.id, media.id, media.ownerKind, media.ownerId, bytes,
          media.contentType, media.byteLength, Buffer.from(media.sha256, 'hex'),
          media.altText, fixture.fixedClock, creator.userId],
      });
    }
    for (const service of tenant.settings.catalogue.services) {
      await client.query({
        name: 'demo-fixture-insert-service',
        text: `
          INSERT INTO services (
            tenant_id, id, name, active, price_minor, currency,
            description, sort_order, created_at, updated_at
          )
          VALUES ($1, $2, $3, true, 0, $4, NULL, 0, $5, $5)
        `,
        values: [tenant.id, service, displayName(service), tenant.settings.catalogue.currency, fixture.fixedClock],
      });
    }
    for (const equipment of tenant.settings.catalogue.equipment) {
      await client.query({
        name: 'demo-fixture-insert-equipment',
        text: `
          INSERT INTO equipment (
            tenant_id, id, name, description, active, sort_order, price_minor, currency, created_at, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
        `,
        values: [tenant.id, equipment.id, equipment.name, equipment.description, equipment.active,
          equipment.order, equipment.price.amountMinor, equipment.price.currency, fixture.fixedClock],
      });
      for (const siteId of equipment.siteIds) {
        await client.query({
          name: 'demo-fixture-insert-equipment-site',
          text: 'INSERT INTO equipment_site_applicability (tenant_id,equipment_id,site_id) VALUES ($1,$2,$3)',
          values: [tenant.id, equipment.id, siteId],
        });
      }
      for (const roomId of equipment.roomIds) {
        await client.query({
          name: 'demo-fixture-insert-equipment-room',
          text: 'INSERT INTO equipment_room_applicability (tenant_id,equipment_id,room_id) VALUES ($1,$2,$3)',
          values: [tenant.id, equipment.id, roomId],
        });
      }
    }
    for (const center of tenant.costCenters) {
      await client.query({
        name: 'demo-fixture-insert-cost-center',
        text: `INSERT INTO tenant_cost_centers
          (tenant_id, id, code, name, active, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        values: [tenant.id, center.id, center.code, center.name, center.active, fixture.fixedClock],
      });
    }
    for (const item of tenant.settings.catalogue.cateringItems) {
      await client.query({
        name: 'demo-fixture-insert-catering-item',
        text: `INSERT INTO catering_items
          (tenant_id, id, name, description, active, sort_order, price_minor, currency, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
        values: [tenant.id, item.id, item.name, item.description, item.active, item.order,
          item.price.amountMinor, item.price.currency, fixture.fixedClock],
      });
      for (const siteId of item.siteIds) {
        await client.query({
          name: 'demo-fixture-insert-catering-item-site',
          text: 'INSERT INTO catering_item_site_applicability (tenant_id,item_id,site_id) VALUES ($1,$2,$3)',
          values: [tenant.id, item.id, siteId],
        });
      }
    }
    for (const cateringPackage of tenant.settings.catalogue.cateringPackages) {
      await client.query({
        name: 'demo-fixture-insert-catering-package',
        text: `INSERT INTO catering_packages
          (tenant_id, id, name, description, active, sort_order, price_minor, currency, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
        values: [tenant.id, cateringPackage.id, cateringPackage.name, cateringPackage.description,
          cateringPackage.active, cateringPackage.order, cateringPackage.price.amountMinor,
          cateringPackage.price.currency, fixture.fixedClock],
      });
      for (const variant of cateringPackage.variants) {
        await client.query({
          name: 'demo-fixture-insert-catering-package-variant',
          text: `INSERT INTO catering_package_variants
            (tenant_id, package_id, id, name, description, active, sort_order,
             price_minor, currency, created_at, updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
          values: [tenant.id, cateringPackage.id, variant.id, variant.name, variant.description,
            variant.active, variant.order, variant.price.amountMinor, variant.price.currency,
            fixture.fixedClock],
        });
      }
      for (const siteId of cateringPackage.siteIds) {
        await client.query({
          name: 'demo-fixture-insert-catering-package-site',
          text: 'INSERT INTO catering_package_site_applicability (tenant_id,package_id,site_id) VALUES ($1,$2,$3)',
          values: [tenant.id, cateringPackage.id, siteId],
        });
      }
      for (const itemId of cateringPackage.itemIds) {
        await client.query({
          name: 'demo-fixture-insert-catering-package-item',
          text: 'INSERT INTO catering_package_items (tenant_id,package_id,item_id) VALUES ($1,$2,$3)',
          values: [tenant.id, cateringPackage.id, itemId],
        });
      }
    }
    await client.query({
      name: 'demo-fixture-insert-catalogue-revision',
      text: `INSERT INTO tenant_catalogue_revisions
        (tenant_id, revision, snapshot, effective_at, actor_user_id, correlation_id)
        VALUES ($1, 2, $2::jsonb, $3, NULL, NULL)`,
      values: [tenant.id, JSON.stringify(catalogueSnapshot(tenant)), fixture.fixedClock],
    });
    const advancedCatalogue = await client.query({
      name: 'demo-fixture-advance-catalogue-revision',
      text: `UPDATE tenants SET catalog_revision = 2, updated_at = $2
        WHERE id = $1 AND catalog_revision = 1`,
      values: [tenant.id, fixture.fixedClock],
    });
    if (advancedCatalogue.rowCount !== 1) {
      throw new Error('DEMO_FIXTURE_CATALOGUE_REVISION_ADVANCE_FAILED');
    }
    if (tenant.requests.length > 0) {
    const revisionResult = await client.query({
      name: 'demo-fixture-request-authority-revisions',
      text: `SELECT organization_revision, locations_revision, catalog_revision,
        booking_policies_revision, cost_allocation_revision
        FROM tenants WHERE id = $1`,
      values: [tenant.id],
    });
    const revisionsRow = revisionResult.rows[0];
    const configurationRevisions = {
      organization: Number(revisionsRow.organization_revision),
      locations: Number(revisionsRow.locations_revision),
      catalogue: Number(revisionsRow.catalog_revision),
      bookingPolicies: Number(revisionsRow.booking_policies_revision),
      costAllocation: Number(revisionsRow.cost_allocation_revision),
    };
    for (const request of tenant.requests) {
      const participants = request.internalParticipants + request.externalParticipants;
      const draft = {
        title: request.title,
        roomId: request.roomId,
        startsAt: request.startsAt,
        endsAt: request.endsAt,
        internalParticipants: request.internalParticipants,
        externalParticipants: request.externalParticipants,
        serviceIds: [],
        equipmentIds: request.equipmentIds,
        catering: {
          participantCount: request.cateringPackageId === null ? 0 : participants,
          packageSelection: request.cateringPackageId === null ? null : {
            packageId: request.cateringPackageId,
            variantId: `${request.cateringPackageId}-standard`,
          },
          itemQuantities: [],
        },
        dietaryRequirements: null,
        specialRequirements: request.description,
        allocations: request.costCenterId === null ? [] : [{
          costCenterId: request.costCenterId, percentageBasisPoints: 10_000,
        }],
        configurationRevisions,
      };
      const authority = await resolveCurrentRequestCompositionWithClient(client, {
        tenantId: tenant.id,
        actorUserId: request.requesterUserId,
        draft,
        schemaVersion: 3,
        operation: 'create',
        capturedAt: fixture.fixedClock,
        requestVersion: 1,
        allowReadyDemoSeed: tenant.lifecycleStatus === 'ready',
      });
      if (authority.status !== 'ready') throw new Error('DEMO_FIXTURE_REQUEST_AUTHORITY_INVALID');
      const inserted = await client.query({
        name: 'demo-fixture-insert-request',
        text: `INSERT INTO requests (
          tenant_id, id, requester_user_id, room_id, status, status_reason,
          starts_at, ends_at, internal_participants, external_participants,
          status_changed_at, schema_version, request_version, request_snapshot,
          created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10,3,1,$11::jsonb,$10,$10)
        RETURNING requester_display_name`,
        values: [
          tenant.id, request.id, request.requesterUserId, request.roomId,
          request.status, request.startsAt, request.endsAt,
          request.internalParticipants, request.externalParticipants,
          fixture.fixedClock, JSON.stringify(authority.snapshot),
        ],
      });
      const record = normalizeRequest({
        tenantId: tenant.id, id: request.id, requesterUserId: request.requesterUserId,
        requesterAttribution: { displayName: inserted.rows[0].requester_display_name },
        roomId: request.roomId, status: request.status, statusReason: null,
        startsAt: request.startsAt, endsAt: request.endsAt,
        internalParticipants: request.internalParticipants,
        externalParticipants: request.externalParticipants,
        schemaVersion: 3, version: 1, snapshot: authority.snapshot,
        statusChangedAt: fixture.fixedClock, createdAt: fixture.fixedClock,
        updatedAt: fixture.fixedClock,
      });
      await appendRequestRevisionWithClient(
        client, record, 'created',
        { actorUserId: request.requesterUserId, correlationId: request.id },
        'employee',
      );
    }
    }
    for (const capabilityId of [
      'microsoft.directory',
      'microsoft.calendar',
      'microsoft.calendar.write',
    ]) {
      await client.query({
        name: 'demo-fixture-insert-entitlement',
        text: `
          INSERT INTO tenant_entitlements (tenant_id, capability_id, enabled, updated_at)
          VALUES ($1, $2, true, $3)
        `,
        values: [tenant.id, capabilityId, fixture.fixedClock],
      });
    }
  }
}

async function seedTenantReadinessState(client, fixture) {
  for (const tenant of fixture.tenants) {
    const provider = tenant.providerSimulation;
    const rooms = tenant.settings.locations.flatMap(({ rooms: siteRooms }) => siteRooms);
    await client.query({
      name: 'demo-fixture-insert-identity-binding',
      text: `
        INSERT INTO tenant_identity_bindings (
          id, tenant_id, provider, provider_tenant_reference,
          claimant_provider_user_reference, status, created_at, updated_at
        )
        VALUES ($1, $2, 'microsoft_entra', $3, $4, 'active', $5, $5)
      `,
      values: [
        provider.identityBindingId,
        tenant.id,
        provider.providerTenantReference,
        `demo-admin-${tenant.id}`,
        fixture.fixedClock,
      ],
    });
    await client.query({
      name: 'demo-fixture-insert-microsoft365-integration',
      text: `
        INSERT INTO integrations (
          tenant_id, id, provider, provider_reference, status,
          connection_version, last_verified_at, connection_reason,
          places_permission_status, calendars_permission_status,
          created_at, updated_at
        )
        VALUES ($1, $2, 'microsoft365', $3, $4, 1, $5, NULL, $6, $7, $8, $8)
      `,
      values: [
        tenant.id,
        provider.integrationId,
        provider.providerTenantReference,
        provider.connectionState,
        tenant.lifecycleStatus === 'onboarding' ? null : fixture.fixedClock,
        provider.placesPermission,
        provider.calendarsPermission,
        fixture.fixedClock,
      ],
    });
    for (const mapping of provider.roomMappings) {
      const room = rooms.find(({ id }) => id === mapping.roomId);
      await client.query({
        name: 'demo-fixture-insert-microsoft365-room-mapping',
        text: `
          INSERT INTO microsoft365_room_mappings (
            tenant_id, room_id, integration_id, external_room_id,
            resource_address, provider_display_name, provider_capacity,
            provider_status, last_seen_at, created_at, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $8, $8)
        `,
        values: [
          tenant.id, mapping.roomId, provider.integrationId,
          mapping.externalRoomId, mapping.resourceAddress,
          room.name, room.capacity, fixture.fixedClock,
        ],
      });
    }
    if (tenant.lifecycleStatus === 'onboarding') continue;
    for (const capability of ['places', 'free_busy', 'calendar_write']) {
      await client.query({
        name: 'demo-fixture-insert-microsoft365-health',
        text: `
          INSERT INTO microsoft365_capability_health (
            tenant_id, integration_id, capability, status, reason,
            last_checked_at, last_success_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        values: [
          tenant.id,
          provider.integrationId,
          capability,
          provider.health,
          provider.health === 'healthy' ? null : 'provider_unavailable',
          fixture.fixedClock,
          provider.health === 'healthy' ? fixture.fixedClock : null,
        ],
      });
    }
  }
}

async function seedPlatformState(client, fixture) {
  for (const persona of fixture.platform.personas) {
    // Migration 029 increments the stored version once for every inserted Tenant scope.
    const initialSecurityVersion = persona.securityVersion - persona.tenantIds.length;
    if (!Number.isSafeInteger(initialSecurityVersion) || initialSecurityVersion < 1) {
      throw new TypeError('DEMO_FIXTURE_PLATFORM_SECURITY_VERSION_INVALID');
    }
    await client.query({
      name: 'demo-fixture-insert-platform-operator',
      text: `
        INSERT INTO platform_operators (
          id, provider, provider_tenant_reference, provider_subject_reference,
          status, scope_mode, roles, security_version, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8, $8)
      `,
      values: [
        persona.operatorId,
        persona.providerIdentity.provider,
        persona.providerIdentity.tenantReference,
        persona.providerIdentity.subjectReference,
        persona.targetScope.mode,
        persona.roles,
        initialSecurityVersion,
        fixture.fixedClock,
      ],
    });
    for (const tenantId of persona.tenantIds) {
      await client.query({
        name: 'demo-fixture-insert-platform-scope',
        text: `
          INSERT INTO platform_operator_tenant_scopes (operator_id, tenant_id, created_at)
          VALUES ($1, $2, $3)
        `,
        values: [persona.operatorId, tenantId, fixture.fixedClock],
      });
    }
  }

  const deployment = fixture.platform.deployment;
  await client.query({
    name: 'demo-fixture-insert-platform-deployment',
    text: `
      INSERT INTO platform_runtime_deployments (
        id, environment, deployment_reference, deployed_at,
        frontend_environment, api_environment, schema_environment,
        schema_expected_version, schema_current_version, dependencies_environment,
        required_dependencies_state, optional_dependencies_state, observed_at,
        record_state, revision, created_at, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $2, $2, $2, $5, $5, $2,
        $6, $7, $4, 'approved', 1, $4, $4
      )
    `,
    values: [
      deployment.id,
      deployment.environment,
      deployment.deploymentReference,
      fixture.fixedClock,
      deployment.schemaVersion,
      deployment.requiredDependenciesState,
      deployment.optionalDependenciesState,
    ],
  });
  for (const tenant of fixture.tenants) {
    await client.query({
      name: 'demo-fixture-insert-platform-deployment-mapping',
      text: `
        INSERT INTO platform_runtime_tenant_mappings (
          tenant_id, deployment_id, revision, mapped_at, updated_at
        )
        VALUES ($1, $2, 1, $3, $3)
      `,
      values: [tenant.id, deployment.id, fixture.fixedClock],
    });
  }
  for (const metering of fixture.platform.metering) {
    const tenant = fixture.tenants.find(({ id }) => id === metering.tenantId);
    await client.query({
      name: 'demo-fixture-insert-platform-metering',
      text: `
        INSERT INTO platform_metering_periods (
          tenant_id, period_start, period_end, data_state, measured_at,
          event_watermark, reconciled_at, active_users, active_rooms,
          requests_created, bookings_confirmed, integration_operations,
          revision, retain_until
        )
        VALUES (
          $1, $2, $3, 'complete', $4, $4, $4, $5, 0, $6, $7, 0, 1, $8
        )
      `,
      values: [
        metering.tenantId,
        `${metering.period}-01T00:00:00.000Z`,
        '2026-07-01T00:00:00.000Z',
        fixture.fixedClock,
        fixture.customerPersonas.filter(({ tenantId }) => tenantId === metering.tenantId).length,
        metering.requestCount,
        tenant.requests.filter(({ status }) => status === 'Confirmed').length,
        new Date(Math.max(
          Date.parse('2028-07-01T00:00:00.000Z'),
          Date.parse(fixture.fixedClock) + 732 * 24 * 60 * 60 * 1000,
        )).toISOString(),
      ],
    });
  }
}

export async function seedDemoBusinessState({
  client,
  fixture,
  refreshProjections = refreshPlatformProjectionBatchWithClient,
} = {}) {
  requireClient(client);
  if (typeof refreshProjections !== 'function') {
    throw new TypeError('DEMO_FIXTURE_PROJECTION_REFRESH_REQUIRED');
  }
  await seedTenants(client, fixture);
  await seedCustomerIdentities(client, fixture);
  await seedTenantBusinessState(client, fixture);
  await seedTenantReadinessState(client, fixture);
  await seedPlatformState(client, fixture);
  const projectionClock = await client.query({
    name: 'demo-fixture-projection-clock',
    text: 'SELECT clock_timestamp() AS observed_at',
    values: [],
  });
  const observedAtValue = projectionClock.rows[0]?.observed_at;
  const observedAt = observedAtValue instanceof Date
    ? observedAtValue.toISOString()
    : observedAtValue;
  if (
    typeof observedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(observedAt)
    || !Number.isFinite(Date.parse(observedAt))
  ) throw new Error('DEMO_FIXTURE_PROJECTION_CLOCK_INVALID');
  const projection = await refreshProjections(client, {
    limit: fixture.tenants.length,
    observedAt,
  });
  if (projection.refreshedCount !== fixture.tenants.length) {
    throw new Error('DEMO_FIXTURE_PLATFORM_PROJECTION_INCOMPLETE');
  }
}

async function readRows(client, name, text) {
  return (await client.query({ name, text })).rows;
}

export async function readDemoSemanticState({ client } = {}) {
  requireClient(client);
  const tenants = await readRows(client, 'demo-fixture-read-tenants', `
    SELECT tenant.id, tenant.display_name, tenant.status, tenant.lifecycle_revision,
           tenant.created_at, organization.legal_name, organization.country_code,
           organization.default_currency
    FROM tenants AS tenant
    JOIN tenant_organization_settings AS organization ON organization.tenant_id = tenant.id
    ORDER BY tenant.id
  `);
  const locations = await readRows(client, 'demo-fixture-read-sites', `
    SELECT tenant_id, id, name, time_zone, guest_information FROM sites ORDER BY tenant_id, id
  `);
  const rooms = await readRows(client, 'demo-fixture-read-rooms', `
    SELECT room.tenant_id, room.site_id, room.id, room.name, room.capacity, room.details,
           price.price_minor
    FROM rooms AS room
    LEFT JOIN tenant_room_prices AS price
      ON price.tenant_id = room.tenant_id AND price.room_id = room.id
    ORDER BY room.tenant_id, room.site_id, room.id
  `);
  const mediaAssets = await readRows(client, 'demo-fixture-read-room-media', `
    SELECT tenant_id, id, room_id, bytes, content_type, byte_length,
      width, height, content_sha256
    FROM tenant_room_media_assets ORDER BY tenant_id, id
  `);
  for (const media of mediaAssets) {
    const hash = createHash('sha256').update(media.bytes).digest('hex');
    if (media.content_type !== 'image/webp'
      || media.bytes.length !== safeInteger(media.byte_length)
      || !media.content_sha256.equals(Buffer.from(hash, 'hex'))) {
      throw new Error('DEMO_FIXTURE_MEDIA_BYTES_DIVERGED');
    }
  }
  const catalogueMediaAssets = await readRows(client, 'demo-fixture-read-catalogue-media', `
    SELECT tenant_id, id, owner_kind, owner_id, bytes, content_type,
      byte_length, content_sha256, alt_text
    FROM demo_catalogue_media_assets ORDER BY tenant_id, id
  `);
  for (const media of catalogueMediaAssets) {
    const hash = createHash('sha256').update(media.bytes).digest('hex');
    const signatureValid = media.content_type === 'image/png'
      ? media.bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      : media.content_type === 'image/webp'
        && media.bytes.toString('ascii', 0, 4) === 'RIFF'
        && media.bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!signatureValid || media.bytes.length !== safeInteger(media.byte_length)
      || !media.content_sha256.equals(Buffer.from(hash, 'hex'))) {
      throw new Error('DEMO_FIXTURE_CATALOGUE_MEDIA_BYTES_DIVERGED');
    }
  }
  for (const room of rooms) {
    const references = mediaAssets
      .filter(({ tenant_id: tenantId, room_id: roomId }) => (
        tenantId === room.tenant_id && roomId === room.id
      ))
      .map(({ id }) => id).sort();
    const plan = catalogueMediaAssets.find(({ tenant_id: tenantId, owner_kind: kind,
      owner_id: ownerId }) => tenantId === room.tenant_id
      && kind === 'room_plan' && ownerId === room.id);
    if ((room.details?.floorplanAssetId ?? null) !== (plan?.id ?? null)) {
      throw new Error('DEMO_FIXTURE_CATALOGUE_MEDIA_REFERENCES_DIVERGED');
    }
    const stored = room.details?.mediaAssetIds;
    if (!Array.isArray(stored)
      || JSON.stringify([...stored].sort()) !== JSON.stringify(references)) {
      throw new Error('DEMO_FIXTURE_MEDIA_REFERENCES_DIVERGED');
    }
  }
  const services = await readRows(client, 'demo-fixture-read-services', `
    SELECT tenant_id, id, currency FROM services ORDER BY tenant_id, id
  `);
  const equipment = await readRows(client, 'demo-fixture-read-equipment', `
    SELECT entry.tenant_id, entry.id, entry.name, entry.description, entry.active,
      entry.sort_order, entry.price_minor, entry.currency,
      ARRAY(SELECT site_id FROM equipment_site_applicability relation
        WHERE relation.tenant_id = entry.tenant_id AND relation.equipment_id = entry.id
        ORDER BY site_id) AS site_ids,
      ARRAY(SELECT room_id FROM equipment_room_applicability relation
        WHERE relation.tenant_id = entry.tenant_id AND relation.equipment_id = entry.id
        ORDER BY room_id) AS room_ids
    FROM equipment entry ORDER BY entry.tenant_id, entry.id
  `);
  const costCenters = await readRows(client, 'demo-fixture-read-cost-centers', `
    SELECT tenant_id, id, code, name, active FROM tenant_cost_centers ORDER BY tenant_id, id
  `);
  const cateringItems = await readRows(client, 'demo-fixture-read-catering-items', `
    SELECT entry.tenant_id, entry.id, entry.name, entry.description, entry.active,
      entry.sort_order, entry.price_minor, entry.currency,
      ARRAY(SELECT site_id FROM catering_item_site_applicability relation
        WHERE relation.tenant_id = entry.tenant_id AND relation.item_id = entry.id ORDER BY site_id) AS site_ids
    FROM catering_items entry ORDER BY entry.tenant_id, entry.id
  `);
  const cateringPackages = await readRows(client, 'demo-fixture-read-catering-packages', `
    SELECT entry.tenant_id, entry.id, entry.name, entry.description, entry.active,
      entry.sort_order, entry.price_minor, entry.currency,
      ARRAY(SELECT site_id FROM catering_package_site_applicability relation
        WHERE relation.tenant_id = entry.tenant_id AND relation.package_id = entry.id ORDER BY site_id) AS site_ids,
      ARRAY(SELECT item_id FROM catering_package_items relation
        WHERE relation.tenant_id = entry.tenant_id AND relation.package_id = entry.id ORDER BY item_id) AS item_ids,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', variant.id, 'name', variant.name, 'description', variant.description,
        'active', variant.active, 'order', variant.sort_order,
        'price', jsonb_build_object('amountMinor', variant.price_minor, 'currency', variant.currency)
      ) ORDER BY variant.id), '[]'::jsonb)
       FROM catering_package_variants variant
       WHERE variant.tenant_id = entry.tenant_id AND variant.package_id = entry.id) AS variants
    FROM catering_packages entry ORDER BY entry.tenant_id, entry.id
  `);
  const requests = await readRows(client, 'demo-fixture-read-requests', `
    SELECT request.tenant_id, request.id, request.requester_user_id, request.room_id,
           request.status, request.starts_at, request.ends_at,
           request.internal_participants, request.external_participants,
           request.schema_version, request.request_snapshot,
           request.current_revision_sequence, revision.record AS revision_record
    FROM requests request
    LEFT JOIN request_revisions revision ON revision.tenant_id = request.tenant_id
      AND revision.request_id = request.id
      AND revision.revision_sequence = request.current_revision_sequence
    ORDER BY request.tenant_id, request.id
  `);
  for (const request of requests) {
    const snapshot = request.request_snapshot;
    if (safeInteger(request.schema_version) !== 3
      || !snapshot || snapshot.schemaVersion !== 3
      || !request.current_revision_sequence
      || !request.revision_record
      || semanticChecksum(request.revision_record.details) !== semanticChecksum(snapshot.details)
      || semanticChecksum(request.revision_record.pricing) !== semanticChecksum(snapshot.pricing)) {
      throw new Error('DEMO_FIXTURE_REQUEST_REVISION_DIVERGED');
    }
  }
  const providers = await readRows(client, 'demo-fixture-read-providers', `
    SELECT simulation.tenant_id, simulation.provider,
           binding.id AS identity_binding_id,
           integration.id AS integration_id,
           integration.provider_reference AS provider_tenant_reference,
           integration.status AS connection_state,
           integration.places_permission_status,
           integration.calendars_permission_status,
           COALESCE(health.status, 'unknown') AS health,
           simulation.scenario,
           mapping.room_id,
           mapping.external_room_id,
           mapping.resource_address
    FROM demo_provider_simulations AS simulation
    JOIN tenant_identity_bindings AS binding
      ON binding.tenant_id = simulation.tenant_id
     AND binding.provider = 'microsoft_entra'
     AND binding.status = 'active'
    JOIN integrations AS integration
      ON integration.tenant_id = simulation.tenant_id
     AND integration.provider = 'microsoft365'
    LEFT JOIN microsoft365_room_mappings AS mapping
      ON mapping.tenant_id = integration.tenant_id
     AND mapping.integration_id = integration.id
     AND mapping.provider_status = 'active'
    LEFT JOIN microsoft365_capability_health AS health
      ON health.tenant_id = integration.tenant_id
     AND health.integration_id = integration.id
     AND health.capability = 'free_busy'
    ORDER BY simulation.tenant_id
  `);
  const customers = await readRows(client, 'demo-fixture-read-customer-personas', `
    SELECT reference.context_key, reference.tenant_id, reference.persona,
           reference.subject_id AS user_id, reference.provider,
           reference.provider_subject_reference, app_user.security_version,
           COALESCE(array_agg(role.role ORDER BY role.role)
             FILTER (WHERE role.role IS NOT NULL), ARRAY[]::text[]) AS elevated_roles
    FROM demo_persona_references AS reference
    JOIN users AS app_user
      ON app_user.tenant_id = reference.tenant_id AND app_user.id = reference.subject_id
    LEFT JOIN tenant_user_roles AS role
      ON role.tenant_id = app_user.tenant_id AND role.user_id = app_user.id
    WHERE reference.surface = 'customer'
    GROUP BY reference.context_key, reference.tenant_id, reference.persona,
             reference.subject_id, reference.provider,
             reference.provider_subject_reference, app_user.security_version
    ORDER BY reference.context_key
  `);
  const platformPersonas = await readRows(client, 'demo-fixture-read-platform-personas', `
    SELECT reference.persona, reference.subject_id AS operator_id,
           reference.provider, reference.provider_tenant_reference,
           reference.provider_subject_reference, reference.assurance_level,
           reference.authentication_context, operator.roles, operator.security_version,
           operator.scope_mode,
           COALESCE(array_agg(scope.tenant_id ORDER BY scope.tenant_id)
             FILTER (WHERE scope.tenant_id IS NOT NULL), ARRAY[]::uuid[]) AS tenant_ids
    FROM demo_persona_references AS reference
    JOIN platform_operators AS operator ON operator.id = reference.subject_id
    LEFT JOIN platform_operator_tenant_scopes AS scope ON scope.operator_id = operator.id
    WHERE reference.surface = 'platform'
    GROUP BY reference.persona, reference.subject_id, reference.provider,
             reference.provider_tenant_reference, reference.provider_subject_reference,
             reference.assurance_level, reference.authentication_context,
             operator.roles, operator.security_version, operator.scope_mode
    ORDER BY reference.persona
  `);
  const deployments = await readRows(client, 'demo-fixture-read-platform-deployment', `
    SELECT id, environment, deployment_reference, schema_current_version,
           required_dependencies_state, optional_dependencies_state
    FROM platform_runtime_deployments
    WHERE record_state = 'approved'
    ORDER BY deployment_reference
  `);
  const metering = await readRows(client, 'demo-fixture-read-platform-metering', `
    SELECT tenant_id, period_start, requests_created
    FROM platform_metering_periods
    ORDER BY tenant_id, period_start
  `);

  const tenantState = tenants.map((tenant) => ({
    id: tenant.id,
    displayName: tenant.display_name,
    lifecycleStatus: tenant.status,
    lifecycleRevision: safeInteger(tenant.lifecycle_revision),
    settings: {
      organization: { name: tenant.legal_name, countryCode: tenant.country_code },
      locations: locations
        .filter(({ tenant_id: tenantId }) => tenantId === tenant.id)
        .map((location) => ({
          id: location.id,
          name: location.name,
          timeZone: location.time_zone,
          guestInformation: location.guest_information,
          rooms: rooms
            .filter(({ tenant_id: tenantId, site_id: siteId }) => (
              tenantId === tenant.id && siteId === location.id
            ))
            .map((room) => ({
              id: room.id,
              name: room.name,
              capacity: safeInteger(room.capacity),
              priceMinor: room.price_minor === null ? null : safeInteger(room.price_minor),
              description: room.details.description,
              floor: room.details.floor,
              equipment: room.details.equipment,
              accessibility: room.details.accessibility,
            })),
        })),
      catalogue: {
        services: services
          .filter(({ tenant_id: tenantId }) => tenantId === tenant.id)
          .map(({ id }) => id),
        currency: tenant.default_currency,
        equipment: equipment.filter((entry) => entry.tenant_id === tenant.id).map((entry) => ({
          id: entry.id, name: entry.name, description: entry.description, active: entry.active,
          order: safeInteger(entry.sort_order),
          price: { amountMinor: safeInteger(entry.price_minor), currency: entry.currency },
          siteIds: entry.site_ids, roomIds: entry.room_ids,
        })),
        cateringItems: cateringItems.filter((entry) => entry.tenant_id === tenant.id).map((entry) => ({
          id: entry.id, name: entry.name, description: entry.description, active: entry.active,
          order: safeInteger(entry.sort_order),
          price: { amountMinor: safeInteger(entry.price_minor), currency: entry.currency },
          siteIds: entry.site_ids, roomIds: [],
        })),
        cateringPackages: cateringPackages.filter((entry) => entry.tenant_id === tenant.id).map((entry) => ({
          id: entry.id, name: entry.name, description: entry.description, active: entry.active,
          order: safeInteger(entry.sort_order),
          price: { amountMinor: safeInteger(entry.price_minor), currency: entry.currency },
          siteIds: entry.site_ids, roomIds: [], itemIds: entry.item_ids,
          variants: entry.variants.map((variant) => ({ ...variant,
            order: safeInteger(variant.order),
            price: { amountMinor: safeInteger(variant.price.amountMinor), currency: variant.price.currency },
          })),
        })),
      },
    },
    catalogueMedia: catalogueMediaAssets.filter((entry) => entry.tenant_id === tenant.id)
      .map((entry) => ({
        id: entry.id,
        assetKey: entry.owner_kind === 'room_plan'
          ? entry.owner_id.startsWith('northwind-berlin-room-')
            ? `northwind-room-${String(Number(entry.owner_id.slice('northwind-berlin-room-'.length))).padStart(2, '0')}`
            : entry.owner_id
          : entry.owner_id,
        ownerKind: entry.owner_kind, ownerId: entry.owner_id,
        sha256: entry.content_sha256.toString('hex'),
        byteLength: safeInteger(entry.byte_length),
        contentType: entry.content_type, altText: entry.alt_text,
      })),
    roomMedia: mediaAssets.filter((entry) => entry.tenant_id === tenant.id).map((entry) => ({
      id: entry.id, roomId: entry.room_id,
      sha256: entry.content_sha256.toString('hex'),
      byteLength: safeInteger(entry.byte_length),
      width: safeInteger(entry.width), height: safeInteger(entry.height),
    })),
    costCenters: costCenters.filter((entry) => entry.tenant_id === tenant.id).map((entry) => ({
      id: entry.id, code: entry.code, name: entry.name, active: entry.active,
    })),
    requests: requests
      .filter(({ tenant_id: tenantId }) => tenantId === tenant.id)
      .map((request) => ({
        id: request.id,
        requesterUserId: request.requester_user_id,
        roomId: request.room_id,
        status: request.status,
        startsAt: iso(request.starts_at),
        endsAt: iso(request.ends_at),
        internalParticipants: safeInteger(request.internal_participants),
        externalParticipants: safeInteger(request.external_participants),
        title: request.request_snapshot.details.title,
        equipmentIds: request.request_snapshot.details.equipmentIds,
        cateringPackageId: request.request_snapshot.details.catering.packageSelection?.packageId ?? null,
        costCenterId: request.request_snapshot.allocations.entries[0]?.costCenterId ?? null,
        description: request.request_snapshot.details.specialRequirements,
      })),
    providerSimulation: (() => {
      const provider = providers.find(({ tenant_id: tenantId }) => tenantId === tenant.id);
      return {
        provider: provider.provider,
        identityBindingId: provider.identity_binding_id,
        integrationId: provider.integration_id,
        providerTenantReference: provider.provider_tenant_reference,
        connectionState: provider.connection_state,
        placesPermission: provider.places_permission_status,
        calendarsPermission: provider.calendars_permission_status,
        health: provider.health,
        scenario: provider.scenario,
        roomMappings: providers
          .filter(({ tenant_id: tenantId, room_id: roomId }) => (
            tenantId === tenant.id && roomId !== null
          ))
          .map((mapping) => ({
            roomId: mapping.room_id,
            externalRoomId: mapping.external_room_id,
            resourceAddress: mapping.resource_address,
          })),
      };
    })(),
  }));

  return {
    schemaVersion: DEMO_RUNTIME_SCHEMA_VERSION,
    seedVersion: DEMO_SEED_VERSION,
    fixedClock: iso(tenants[0].created_at),
    tenants: tenantState,
    customerPersonas: customers.map((persona) => {
      const snapshot = tenantAuthorizationSnapshot(['employee', ...persona.elevated_roles]);
      return {
        tenantId: persona.tenant_id,
        persona: persona.persona,
        userId: persona.user_id,
        securityVersion: safeInteger(persona.security_version),
        roles: snapshot.roles,
        permissions: snapshot.permissions,
        providerIdentity: {
          provider: persona.provider,
          reference: persona.provider_subject_reference,
        },
      };
    }),
    platform: {
      personas: platformPersonas.map((persona) => ({
        persona: persona.persona,
        operatorId: persona.operator_id,
        securityVersion: safeInteger(persona.security_version),
        roles: [...persona.roles],
        tenantIds: [...persona.tenant_ids],
        targetScope: {
          mode: persona.scope_mode,
          securityVersion: safeInteger(persona.security_version),
        },
        providerIdentity: {
          provider: persona.provider,
          tenantReference: persona.provider_tenant_reference,
          subjectReference: persona.provider_subject_reference,
        },
        assurance: {
          level: persona.assurance_level,
          authenticationContext: persona.authentication_context,
        },
      })),
      deployment: {
        id: deployments[0].id,
        environment: deployments[0].environment,
        deploymentReference: deployments[0].deployment_reference,
        schemaVersion: safeInteger(deployments[0].schema_current_version),
        requiredDependenciesState: deployments[0].required_dependencies_state,
        optionalDependenciesState: deployments[0].optional_dependencies_state,
      },
      metering: metering.map((period) => ({
        tenantId: period.tenant_id,
        period: iso(period.period_start).slice(0, 7),
        requestCount: safeInteger(period.requests_created),
      })),
    },
  };
}

export function createDemoFixtureStatePersistence() {
  return Object.freeze({
    seedBusinessState: seedDemoBusinessState,
    readSemanticState: readDemoSemanticState,
  });
}
