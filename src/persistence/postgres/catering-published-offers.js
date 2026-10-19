import { isInternalUuid } from '../../domain/identifiers.js';
import { createCateringPublishedOfferIndex } from '../../domain/catering-published-offers.js';
import { normalizeCateringConfiguration } from '../../integrations/catering-configuration.js';

const MODES=['catalogue','availability','order','update','cancel','status'];
function invalid() { throw new TypeError('CATERING_PUBLISHED_OFFER_READ_INVALID'); }
function revision(value) {
  const number=Number(value); if (!Number.isSafeInteger(number) || number<1 || number>=Number.MAX_SAFE_INTEGER) invalid(); return number;
}

// Same-client read only: the caller must hold a stable snapshot or the Tenant
// authority lock used by trusted request composition. Never opens a new pool read.
export async function readCateringPublishedOffersWithClient(client,{tenantId,catalogueRevision=null,registry}={}) {
  if (typeof client?.query !== 'function' || typeof registry?.get !== 'function' || !isInternalUuid(tenantId)
    || (catalogueRevision !== null && (!Number.isSafeInteger(catalogueRevision)
      || catalogueRevision<1 || catalogueRevision>=Number.MAX_SAFE_INTEGER))) invalid();
  const tenant=tenantId.toLowerCase();
  const current=await client.query({name:'catering-published-offers-current-catalogue',
    text:`SELECT catalogue.snapshot FROM tenants tenant JOIN tenant_catalogue_revisions catalogue
      ON catalogue.tenant_id=tenant.id AND catalogue.revision=tenant.catalog_revision
      WHERE tenant.id=$1 AND tenant.status='active' AND ($2::bigint IS NULL OR tenant.catalog_revision=$2)`,
    values:[tenant,catalogueRevision]});
  if (current.rowCount !== 1) invalid();
  const assignments=await client.query({name:'catering-published-offers-current-owners',
    text:`SELECT entry.kind,entry.entry_id,entry.integration_id FROM catering_catalogue_assignment_heads head
      JOIN catering_catalogue_assignment_entries entry ON entry.tenant_id=head.tenant_id AND entry.revision=head.revision
      WHERE head.tenant_id=$1 ORDER BY entry.kind,entry.entry_id LIMIT 401`,values:[tenant]});
  if (assignments.rows.length>400) invalid();
  const publications=await client.query({name:'catering-published-offers-current-publications',
    text:`WITH current_owners AS (
      SELECT entry.kind,entry.entry_id,entry.integration_id FROM catering_catalogue_assignment_heads head
      JOIN catering_catalogue_assignment_entries entry ON entry.tenant_id=head.tenant_id AND entry.revision=head.revision
      WHERE head.tenant_id=$1
    ) SELECT head.integration_id,head.publication_revision,review.catalogue_revision,review.source_revision,
      integration.provider,integration.status,source.provider_id AS source_provider,configuration.tenant_id,
      configuration.initial_order_mode,configuration.catalogue_mode,configuration.availability_mode,configuration.order_mode,
      configuration.update_mode,configuration.cancel_mode,configuration.status_mode,
      scoped.bindings,jsonb_build_object('services','[]'::jsonb,'equipment','[]'::jsonb,'roomPrices','[]'::jsonb,
        'cateringItems',coalesce((SELECT jsonb_agg(entry ORDER BY entry->>'id' COLLATE "C")
          FROM jsonb_array_elements(catalogue.snapshot->'cateringItems') entry
          WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(scoped.bindings) binding
            WHERE binding->>'kind'='item' AND binding->>'entryId'=entry->>'id')),'[]'::jsonb),
        'cateringPackages',coalesce((SELECT jsonb_agg(entry ORDER BY entry->>'id' COLLATE "C")
          FROM jsonb_array_elements(catalogue.snapshot->'cateringPackages') entry
          WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(scoped.bindings) binding
            WHERE binding->>'kind'='package' AND binding->>'entryId'=entry->>'id')),'[]'::jsonb)) AS published_catalogue
      FROM catering_catalogue_publication_heads head
      JOIN catering_catalogue_reviews review ON review.tenant_id=head.tenant_id AND review.integration_id=head.integration_id
        AND review.review_revision=head.review_revision AND review.publication_revision=head.publication_revision
      JOIN tenant_catalogue_revisions catalogue ON catalogue.tenant_id=review.tenant_id AND catalogue.revision=review.catalogue_revision
      JOIN catering_provider_catalogue_revisions source ON source.tenant_id=review.tenant_id
        AND source.integration_id=review.integration_id AND source.revision=review.source_revision
      JOIN integrations integration ON integration.tenant_id=head.tenant_id AND integration.id=head.integration_id
      JOIN catering_integration_configurations configuration
        ON configuration.tenant_id=head.tenant_id AND configuration.integration_id=head.integration_id
      CROSS JOIN LATERAL (SELECT coalesce(jsonb_agg(binding
        ORDER BY binding->>'kind' COLLATE "C",binding->>'entryId' COLLATE "C"),'[]'::jsonb) AS bindings
        FROM jsonb_array_elements(review.bindings) binding WHERE EXISTS (
          SELECT 1 FROM current_owners owner WHERE owner.integration_id=head.integration_id
            AND owner.kind=binding->>'kind' AND owner.entry_id=binding->>'entryId')
        AND (binding->>'kind'<>'package' OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(catalogue.snapshot->'cateringPackages') package
          CROSS JOIN LATERAL jsonb_array_elements_text(package->'itemIds') component(id)
          WHERE package->>'id'=binding->>'entryId' AND NOT EXISTS (
            SELECT 1 FROM current_owners owner WHERE owner.integration_id=head.integration_id
              AND owner.kind='item' AND owner.entry_id=component.id)))) scoped
      WHERE head.tenant_id=$1 AND jsonb_array_length(scoped.bindings)>0
      ORDER BY head.integration_id LIMIT 401`,values:[tenant]});
  if (publications.rows.length>400 || publications.rows.reduce((sum,row)=>{
    if (!Array.isArray(row.bindings)) invalid(); return sum+row.bindings.length;
  },0)>400) invalid();
  return createCateringPublishedOfferIndex(publications.rows.map(row=>{
    if (row.tenant_id !== tenant || row.provider !== row.source_provider) invalid();
    const configuration=normalizeCateringConfiguration({initialOrderMode:row.initial_order_mode,
      capabilities:Object.fromEntries(MODES.map(mode=>[`catering.${mode}`,row[`${mode}_mode`]]))},registry.get(row.provider));
    return {tenantId:tenant,integrationId:row.integration_id,publicationRevision:revision(row.publication_revision),
      catalogueRevision:revision(row.catalogue_revision),sourceRevision:revision(row.source_revision),
      connectionAvailable:['configured','active'].includes(row.status),
      catalogueEnabled:configuration.capabilities['catering.catalogue'] !== 'unsupported',
      catalogue:row.published_catalogue,bindings:row.bindings};
  }),{tenantId:tenant,catalogue:current.rows[0].snapshot,assignments:assignments.rows.map(row=>({
    kind:row.kind,entryId:row.entry_id,integrationId:row.integration_id,
  }))});
}

// Called only with the trusted normalized request/change snapshot under the
// existing Tenant authority lock; no historic snapshot or order is rewritten.
export async function cateringSnapshotRemainsPublishedWithClient(client,{tenantId,snapshot,roomId,registry}={}) {
  if (typeof client?.query !== 'function' || !isInternalUuid(tenantId)
    || typeof roomId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(roomId)) invalid();
  if (snapshot === null) return true;
  const catering=snapshot?.details?.catering;
  if (!catering || !Array.isArray(catering.itemQuantities)) invalid();
  if (catering.itemQuantities.length === 0 && catering.packageSelection === null) return true;
  const room=await client.query({name:'catering-published-offers-current-room',
    text:`SELECT room.site_id FROM rooms room JOIN sites site ON site.tenant_id=room.tenant_id AND site.id=room.site_id
      WHERE room.tenant_id=$1 AND room.id=$2 AND room.active=TRUE AND site.active=TRUE`,values:[tenantId.toLowerCase(),roomId]});
  if (room.rowCount !== 1) return false;
  const publication=await readCateringPublishedOffersWithClient(client,{tenantId,registry});
  return publication.allowsSelection({siteId:room.rows[0].site_id,roomId,
    itemIds:catering.itemQuantities.map(entry=>entry.itemId),packageSelection:catering.packageSelection});
}

// Booking-change completion holds a Tenant SHARE lock. Configuration updates
// also use Tenant SHARE, so fence the currently assigned connection/configuration
// rows before the final read. All other publication/ownership writers need the
// conflicting Tenant UPDATE lock. Keep Tenant -> integration/configuration order.
export async function lockCateringPublishedOfferAuthorityWithClient(client,tenantId) {
  if (typeof client?.query !== 'function' || !isInternalUuid(tenantId)) invalid();
  const rows=await client.query({name:'catering-published-offers-authority-lock',
    text:`SELECT integration.id FROM integrations integration JOIN catering_integration_configurations configuration
      ON configuration.tenant_id=integration.tenant_id AND configuration.integration_id=integration.id
      WHERE integration.tenant_id=$1 AND EXISTS (
        SELECT 1 FROM catering_catalogue_assignment_heads head JOIN catering_catalogue_assignment_entries entry
          ON entry.tenant_id=head.tenant_id AND entry.revision=head.revision
        WHERE head.tenant_id=integration.tenant_id AND entry.integration_id=integration.id)
      ORDER BY integration.id FOR SHARE OF integration,configuration`,values:[tenantId.toLowerCase()]});
  if (rows.rows.length>400) invalid();
}
