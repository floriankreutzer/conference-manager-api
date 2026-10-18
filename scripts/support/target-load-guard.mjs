import { createHash, timingSafeEqual } from 'node:crypto';

export const LOAD_MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;

function valid(value) {
  if (!value) throw new Error('LOAD_TARGET_SCOPE_INVALID');
}

export function loadTargetScope(values, now = Date.now()) {
  try {
    const { runId, createdAt, expiresAt, releaseSha, surface, databaseUrl, observerToken, storageBucket,
      expectedDatabaseHost, serviceName } = values;
    valid(typeof runId === 'string' && /^[a-f0-9]{16}$/.test(runId));
    valid(['customer', 'platform', 'setup'].includes(surface));
    valid(typeof releaseSha === 'string' && /^[a-f0-9]{40}$/.test(releaseSha));
    valid(typeof createdAt === 'string' && typeof expiresAt === 'string');
    const start = Date.parse(createdAt); const end = Date.parse(expiresAt);
    valid(Number.isSafeInteger(now) && Number.isFinite(start) && Number.isFinite(end)
      && new Date(start).toISOString() === createdAt && new Date(end).toISOString() === expiresAt
      && start <= now && now < end && end - start > 0 && end - start <= LOAD_MAX_LIFETIME_MS);
    valid(typeof observerToken === 'string' && /^[A-Za-z0-9_-]{43}$/.test(observerToken));
    valid(storageBucket === `saas38-load-${runId}`);
    // The operator supplies the independently read provider endpoint in private configuration.
    // Provider account/project identifiers never belong in the public source tree.
    valid(typeof expectedDatabaseHost === 'string'
      && /^ep-[a-z0-9-]+\.c-[0-9]+\.eu-central-1\.aws\.neon\.tech$/.test(expectedDatabaseHost));
    valid(surface === 'setup' ? serviceName === undefined
      : serviceName === `cm-saas38-load-${runId}-${surface}`);
    const url = new URL(databaseUrl);
    valid(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === expectedDatabaseHost
      && (url.port === '' || url.port === '5432') && !url.hash && url.password
      && url.pathname === `/saas38_load_${runId}`
      && url.username === `saas38_load_${runId}_${surface}`
      && url.searchParams.size === 1 && url.searchParams.get('sslmode') === 'verify-full');
    return Object.freeze({ runId, createdAt, expiresAt, expiresMs: end, releaseSha, surface,
      databaseName: url.pathname.slice(1), databaseUser: url.username, storageBucket,
      databaseUrl, observerToken });
  } catch { throw new Error('LOAD_TARGET_SCOPE_INVALID'); }
}

export function loadTargetOrigin(value, runId, surface) {
  try {
    const url = new URL(value);
    valid(['customer', 'platform'].includes(surface) && /^[a-f0-9]{16}$/.test(runId)
      && url.protocol === 'https:' && url.origin === value && !url.username && !url.password
      && url.hostname === `cm-saas38-load-${runId}-${surface}.onrender.com`);
    return url.origin;
  } catch { throw new Error('LOAD_TARGET_ORIGIN_INVALID'); }
}

export function loadObserverAuthorized(header, token) {
  if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header)
    || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  return timingSafeEqual(createHash('sha256').update(header.slice(7)).digest(), createHash('sha256').update(token).digest());
}

async function verifyLoadDatabase(pool, scope, { allowEmpty, clock }) {
  function lifetime() {
    const now = clock();
    valid(Number.isSafeInteger(now) && now >= Date.parse(scope.createdAt) && now < scope.expiresMs);
  }
  async function query(sql) {
    lifetime();
    const result = await pool.query(sql);
    lifetime();
    return result;
  }
  const identity = await query(`SELECT pg_catalog.current_database() AS database,current_user AS actor,
    pg_catalog.current_setting('server_version_num')::int AS version`);
  const row = identity.rows[0];
  valid(row?.database === scope.databaseName && row.actor === scope.databaseUser && row.version >= 180000 && row.version < 190000);
  const rights = await query(`SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls,rolreplication,
    EXISTS(SELECT 1 FROM pg_catalog.pg_roles managed WHERE managed.rolname='neon_superuser'
      AND pg_catalog.pg_has_role(current_user,managed.oid,'MEMBER')) AS managed_superuser,
    EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members membership
      WHERE membership.member=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)) AS role_membership
    FROM pg_catalog.pg_roles WHERE rolname=current_user`);
  valid(rights.rowCount === 1
    && ['rolsuper', 'rolcreaterole', 'rolcreatedb', 'rolbypassrls', 'rolreplication', 'managed_superuser', 'role_membership']
    .every(key => rights.rows[0][key] === false));
  const marker = await query("SELECT pg_catalog.to_regclass('public.saas38_load_scope') AS marker");
  if (marker.rows[0]?.marker === null && allowEmpty) {
    valid(scope.surface === 'setup');
    const objects = await query(`SELECT pg_catalog.count(*)::int AS count FROM pg_catalog.pg_depend
      WHERE refclassid='pg_catalog.pg_namespace'::pg_catalog.regclass
        AND refobjid='public'::pg_catalog.regnamespace`);
    valid(objects.rows[0].count === 0); return;
  }
  valid(typeof marker.rows[0]?.marker === 'string');
  const authority = await query(`SELECT
    pg_catalog.pg_has_role(current_user,database.datdba,'MEMBER') AS database_owner,
    pg_catalog.pg_has_role(current_user,namespace.nspowner,'MEMBER') AS schema_owner,
    pg_catalog.pg_has_role(current_user,marker.relowner,'MEMBER') AS marker_owner,
    pg_catalog.has_database_privilege(current_user,database.oid,'CREATE') AS database_create,
    pg_catalog.has_schema_privilege(current_user,namespace.oid,'CREATE') AS schema_create,
    pg_catalog.has_table_privilege(current_user,marker.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS marker_mutation,
    pg_catalog.has_any_column_privilege(current_user,marker.oid,'INSERT,UPDATE,REFERENCES') AS marker_column_mutation
    FROM pg_catalog.pg_database database CROSS JOIN pg_catalog.pg_namespace namespace
    JOIN pg_catalog.pg_class marker ON marker.relnamespace=namespace.oid
      AND marker.relname='saas38_load_scope' AND marker.relkind='r'
    WHERE database.datname=pg_catalog.current_database() AND namespace.nspname='public'`);
  valid(authority.rowCount === 1
    && ['database_owner', 'schema_owner', 'marker_owner', 'database_create', 'schema_create', 'marker_mutation', 'marker_column_mutation']
      .every(key => typeof authority.rows[0][key] === 'boolean' && (scope.surface === 'setup' || authority.rows[0][key] === false)));
  const target = await query('SELECT run_id,release_sha,created_at,expires_at FROM public.saas38_load_scope');
  valid(target.rowCount === 1 && target.rows[0].run_id === scope.runId && target.rows[0].release_sha === scope.releaseSha
    && target.rows[0].created_at.toISOString() === scope.createdAt && target.rows[0].expires_at.toISOString() === scope.expiresAt);
}

// Fixed safe error: PostgreSQL failures may contain private connection or schema details.
export async function assertLoadDatabase(pool, scope, { allowEmpty = false, clock = Date.now } = {}) {
  try { await verifyLoadDatabase(pool, scope, { allowEmpty, clock }); }
  catch { throw new Error('LOAD_TARGET_SCOPE_INVALID'); }
}
