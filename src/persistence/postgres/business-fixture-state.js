import { normalizeRequest } from '../../domain/request.js';
import { appendRequestRevisionWithClient,resolveCurrentRequestCompositionWithClient } from './request-repository.js';
import { forEachFixtureMediaBatch,publishFixtureMedia } from './business-fixture-media.js';

// Prevalidated fixed business data only. The caller owns transaction, Tenant/User
// provisioning, current operator/proof authority, provider simulation and audits.
// Existing prepared statement/error names retain the legacy Demo compatibility.
function displayName(id) {
  return id.split('_').map(word=>`${word[0].toUpperCase()}${word.slice(1)}`).join(' ');
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

export async function seedTenantBusinessFixtureState({ client,fixture,mediaObjects=null,
  roomMediaBytes,catalogueMediaBytes,mediaCreatorForTenant,writeCatalogueMedia,
}={}) {
  if (!client || typeof client.query!=='function' || !fixture || !Array.isArray(fixture.tenants)
    || [roomMediaBytes,catalogueMediaBytes,mediaCreatorForTenant,writeCatalogueMedia].some(port=>typeof port!=='function')) {
    throw new TypeError('BUSINESS_FIXTURE_PORTS_REQUIRED');
  }
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
    await forEachFixtureMediaBatch(tenant.roomMedia, async (media) => {
      const bytes = await roomMediaBytes(media,tenant.id);
      const creator = mediaCreatorForTenant(tenant.id);
      if (!creator) throw new Error('DEMO_FIXTURE_MEDIA_CREATOR_INVALID');
      const key = await publishFixtureMedia(client, tenant.id, media, 'room', bytes, mediaObjects);
      await client.query({
        name: 'demo-fixture-insert-room-media',
        text: `INSERT INTO tenant_room_media_assets (
          tenant_id, id, room_id, bytes, content_type, byte_length,
          width, height, content_sha256, created_at, created_by_user_id, object_key
        ) VALUES ($1, $2, $3, $4, 'image/webp', $5, $6, $7, $8, $9, $10, $11)`,
        values: [tenant.id, media.id, media.roomId, mediaObjects ? null : bytes, media.byteLength,
          media.width, media.height, Buffer.from(media.sha256, 'hex'), fixture.fixedClock, creator.userId, key],
      });
    });
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
    await forEachFixtureMediaBatch(tenant.catalogueMedia, async (media) => {
      const bytes = await catalogueMediaBytes(media,tenant.id);
      const creator = mediaCreatorForTenant(tenant.id);
      if (!creator) throw new Error('DEMO_FIXTURE_CATALOGUE_MEDIA_CREATOR_INVALID');
      const key = await publishFixtureMedia(client, tenant.id, media, 'catalogue', bytes, mediaObjects);
      await writeCatalogueMedia(client,{ tenantId: tenant.id,media,bytes,objectKey: key,
        createdAt: fixture.fixedClock,createdByUserId: creator.userId });
    });
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
            variantId: tenant.settings.catalogue.cateringPackages.find(item=>item.id===request.cateringPackageId)?.variants[0]?.id,
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

