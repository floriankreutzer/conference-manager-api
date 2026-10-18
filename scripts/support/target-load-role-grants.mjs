import { withPostgresTransaction } from '../../src/persistence/postgres/transaction.js';
import { assertLoadDatabase, loadTargetScope } from './target-load-guard.mjs';

const CUSTOMER_TABLES = Object.freeze([
  'tenants', 'users', 'sites', 'rooms', 'services', 'catering_packages', 'catering_items',
  'integrations', 'requests', 'notifications', 'audit_events', 'sessions', 'tenant_entitlements',
  'booking_provider_references', 'oidc_auth_transactions', 'tenant_onboarding_invitations',
  'tenant_identity_bindings', 'tenant_claim_transactions', 'user_identity_bindings', 'tenant_user_roles',
  'microsoft365_consent_transactions', 'microsoft365_room_mappings', 'microsoft365_capability_health',
  'booking_change_requests', 'tenant_location_revisions', 'tenant_organization_settings', 'tenant_organization_revisions',
  'equipment', 'catering_package_variants', 'catering_package_items', 'service_site_applicability',
  'service_room_applicability', 'equipment_site_applicability', 'equipment_room_applicability',
  'catering_package_site_applicability', 'catering_package_room_applicability',
  'catering_item_site_applicability', 'catering_item_room_applicability', 'tenant_catalogue_revisions',
  'tenant_booking_policy_configuration', 'tenant_booking_policy_revisions', 'tenant_cost_allocation_configuration',
  'tenant_cost_centers', 'tenant_cost_allocation_revisions', 'request_v2_migration_state', 'tenant_room_prices',
  'request_revisions', 'tenant_bulk_transfer_receipts',
]);
const PLATFORM_SOURCE_TABLES = Object.freeze(['tenants', 'tenant_identity_bindings', 'tenant_onboarding_invitations',
  'integrations', 'tenant_entitlements', 'microsoft365_room_mappings', 'microsoft365_capability_health',
  'platform_sessions', 'platform_operators']);
const PLATFORM_PROJECTION_TABLES = Object.freeze(['platform_projection_outbox', 'platform_tenant_readiness_snapshots',
  'platform_microsoft_fleet_snapshots', 'platform_microsoft_fleet_capabilities']);

function valid(value) { if (!value) throw new Error('LOAD_ROLE_GRANTS_FAILED'); }
function identifier(value) { valid(typeof value === 'string' && /^[a-z][a-z0-9_]*$/.test(value)); return `"${value}"`; }

// Installer-only, exact synthetic target. Never changes role attributes, membership,
// ownership, existing provider projects or any normal deployment principal.
export async function grantTargetLoadRoles(pool, values, { clock = Date.now } = {}) {
  try {
    const scope = loadTargetScope(values, clock()); valid(scope.surface === 'setup');
    await assertLoadDatabase(pool, scope, { clock });
    const customer = `saas38_load_${scope.runId}_customer`; const platform = `saas38_load_${scope.runId}_platform`;
    const roles = [customer, platform];
    await withPostgresTransaction(pool, async client => {
      async function query(text, parameters) {
        loadTargetScope(values, clock());
        const result = await client.query(text, parameters);
        loadTargetScope(values, clock()); return result;
      }
      const rights = await query(`SELECT role.rolname,role.rolcanlogin,role.rolsuper,role.rolcreaterole,
        role.rolcreatedb,role.rolbypassrls,role.rolreplication,
        EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members membership WHERE membership.member=role.oid) AS member,
        EXISTS(SELECT 1 FROM pg_catalog.pg_roles managed WHERE managed.rolname='neon_superuser'
          AND pg_catalog.pg_has_role(role.oid,managed.oid,'MEMBER')) AS managed,
        EXISTS(SELECT 1 FROM pg_catalog.pg_database owned WHERE owned.datdba=role.oid) AS owns_database,
        EXISTS(SELECT 1 FROM pg_catalog.pg_namespace owned WHERE owned.nspowner=role.oid) AS owns_schema,
        EXISTS(SELECT 1 FROM pg_catalog.pg_class owned WHERE owned.relowner=role.oid) AS owns_relation,
        EXISTS(SELECT 1 FROM pg_catalog.pg_class relation
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
          WHERE namespace.nspname='public' AND relation.relkind IN ('r','p','v','m','f')
          AND (pg_catalog.has_table_privilege(role.oid,relation.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR pg_catalog.has_any_column_privilege(role.oid,relation.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) AS prior_table_rights,
        EXISTS(SELECT 1 FROM pg_catalog.pg_namespace namespace
          WHERE pg_catalog.has_schema_privilege(role.oid,namespace.oid,'CREATE')) AS schema_create
        FROM pg_catalog.pg_roles role WHERE role.rolname=ANY($1::text[])`, [roles]);
      valid(rights.rowCount === 2 && new Set(rights.rows.map(row => row.rolname)).size === 2);
      for (const row of rights.rows) valid(roles.includes(row.rolname) && row.rolcanlogin === true
        && ['rolsuper', 'rolcreaterole', 'rolcreatedb', 'rolbypassrls', 'rolreplication', 'member', 'managed',
          'owns_database', 'owns_schema', 'owns_relation', 'prior_table_rights', 'schema_create'].every(key => row[key] === false));
      const customerRole = identifier(customer); const platformRole = identifier(platform);
      await query(`REVOKE ALL ON DATABASE ${identifier(scope.databaseName)} FROM PUBLIC`);
      const databaseRights = await query(`SELECT pg_catalog.has_database_privilege(rolname,$2::text,'CREATE,TEMPORARY') AS elevated
        FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[])`, [roles, scope.databaseName]);
      valid(databaseRights.rowCount === 2 && databaseRights.rows.every(row => row.elevated === false));
      await query(`GRANT CONNECT ON DATABASE ${identifier(scope.databaseName)} TO ${customerRole},${platformRole}`);
      await query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
      await query(`GRANT USAGE ON SCHEMA public TO ${customerRole},${platformRole}`);
      for (const table of CUSTOMER_TABLES) {
        await query(`GRANT SELECT,INSERT,UPDATE,DELETE ON public.${identifier(table)} TO ${customerRole}`);
      }
      await query(`GRANT SELECT,INSERT ON public.tenant_room_media_assets,public.media_object_inventory TO ${customerRole}`);
      await query(`GRANT UPDATE(object_key) ON public.media_object_inventory TO ${customerRole}`);
      // Canonical audit projection triggers run with invoker privileges. Both
      // domains may append minimized diagnostics but must never read/edit them.
      await query(`GRANT INSERT ON public.platform_diagnostic_events TO ${customerRole},${platformRole}`);
      await query(`GRANT USAGE ON SEQUENCE public.platform_diagnostic_events_id_seq TO ${customerRole},${platformRole}`);
      const sequences = await query(`SELECT sequence.relname AS name FROM pg_catalog.pg_class sequence
        JOIN pg_catalog.pg_depend dependency ON dependency.objid=sequence.oid
          AND dependency.classid='pg_catalog.pg_class'::pg_catalog.regclass
          AND dependency.refclassid='pg_catalog.pg_class'::pg_catalog.regclass AND dependency.deptype IN ('a','i')
        JOIN pg_catalog.pg_class owner ON owner.oid=dependency.refobjid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid=sequence.relnamespace
        WHERE sequence.relkind='S' AND namespace.nspname='public' AND owner.relname=ANY($1::text[])`, [CUSTOMER_TABLES]);
      for (const row of sequences.rows) await query(`GRANT USAGE ON SEQUENCE public.${identifier(row.name)} TO ${customerRole}`);
      for (const table of ['schema_migrations', 'saas38_load_scope']) {
        await query(`GRANT SELECT ON public.${identifier(table)} TO ${customerRole},${platformRole}`);
      }
      for (const table of PLATFORM_SOURCE_TABLES) {
        await query(`GRANT SELECT ON public.${identifier(table)} TO ${platformRole}`);
      }
      await query(`GRANT SELECT,INSERT ON public.platform_audit_events,public.platform_audit_checkpoints TO ${platformRole}`);
      await query(`GRANT SELECT,UPDATE ON public.platform_audit_chain_state TO ${platformRole}`);
      await query(`GRANT UPDATE(id) ON public.tenants TO ${platformRole}`);
      for (const table of PLATFORM_PROJECTION_TABLES) {
        await query(`GRANT SELECT,INSERT,UPDATE,DELETE ON public.${identifier(table)} TO ${platformRole}`);
      }
    });
    loadTargetScope(values, clock());
  } catch { throw new Error('LOAD_ROLE_GRANTS_FAILED'); }
}
