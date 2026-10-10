import { validateNeonStorageConfig } from '../../src/media/neon-object-storage.js';

export const RECOVERY_ROOT = 'br-rapid-morning-b1a704p9';
export const RECOVERY_SNAPSHOT = 'snap-fragrant-cell-b1oh6t1r';
export const RECOVERY_MANIFEST = '0d4cece4b98b531c346830164c383a2c6c8a8a324f8990b3c7d50e0f3e4fd39f';
const PRESERVED_BRANCHES = new Set([RECOVERY_ROOT, 'br-summer-rice-b1f8voyp',
  'br-sweet-smoke-b1w5vtbq', 'br-falling-glade-b17oqqiv', 'br-twilight-tree-b18xtqg3']);
export const RECOVERY_ROLES = Object.freeze({
  DEMO_CUSTOMER_DATABASE_URL: 'cm_demo_customer', DEMO_PLATFORM_DATABASE_URL: 'cm_demo_platform',
  DEMO_RESET_DATABASE_URL: 'cm_demo_reset', DEMO_MIGRATION_DATABASE_URL: 'cm_demo_migration',
});

// The owner binds these protected repository variables to independently inspected
// provider metadata. No workflow input can choose a branch or destination.
export function loadNeonRecoveryConfig(env) {
  if (env.NODE_ENV !== 'test' || env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REF !== 'refs/heads/main'
    || !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')
    || !/^br-[a-z0-9-]{5,80}$/.test(env.NEON_RECOVERY_BRANCH || '')
    || PRESERVED_BRANCHES.has(env.NEON_RECOVERY_BRANCH)
    || !/^ep-[a-z0-9-]{5,80}\.c-5\.eu-central-1\.aws\.neon\.tech$/.test(env.NEON_RECOVERY_HOST || '')
    || env.NEON_RECOVERY_HOST === 'ep-solitary-thunder-b1ydpuiq.c-5.eu-central-1.aws.neon.tech'
    || env.DEMO_DATABASE_SSL !== 'verify-full') throw new Error('NEON_RECOVERY_CONTEXT_INVALID');
  const databases = [];
  for (const [key, role] of Object.entries(RECOVERY_ROLES)) {
    if (env[key] === undefined) continue;
    let url;
    try { url = new URL(env[key]); } catch { throw new Error('NEON_RECOVERY_DATABASE_INVALID'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== env.NEON_RECOVERY_HOST
      || (url.port && url.port !== '5432') || url.pathname !== '/conference_manager_demo_shared'
      || url.username !== role || !url.password || url.search || url.hash) {
      throw new Error('NEON_RECOVERY_DATABASE_INVALID');
    }
    databases.push(Object.freeze({ key, role, url: env[key] }));
  }
  if (!databases.length || new Set(databases.map(({ url }) => new URL(url).password)).size !== databases.length) {
    throw new Error('NEON_RECOVERY_DATABASE_INVALID');
  }
  const storage = validateNeonStorageConfig({
    endpoint: `https://${env.NEON_RECOVERY_BRANCH}.storage.c-5.eu-central-1.aws.neon.tech`,
    region: 'eu-central-1', bucket: 'conference-manager-media',
    accessKeyId: env.NEON_RECOVERY_ACCESS_KEY_ID, secretAccessKey: env.NEON_RECOVERY_SECRET_ACCESS_KEY,
  });
  return Object.freeze({ branch: env.NEON_RECOVERY_BRANCH, databases: Object.freeze(databases), storage });
}

// This constant view is installed ONLY on the independently verified disposable child.
// A table would violate the unchanged Demo reset application-table inventory.
// A wrong endpoint or missing marker fails before SDK allocation or mutations.
// It guards operator mistakes; it is not authority against a malicious DB owner.
export async function assertNeonRecoveryIdentity(client, role, branch, now = Date.now()) {
  const identity = await client.query('SELECT current_user AS role, current_database() AS database');
  if (identity.rows[0]?.role !== role || identity.rows[0]?.database !== 'conference_manager_demo_shared') {
    throw new Error('NEON_RECOVERY_IDENTITY_INVALID');
  }
  const relation = await client.query(`SELECT relation.relkind AS kind,
    pg_catalog.pg_get_userbyid(relation.relowner) AS owner
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public' AND relation.relname = 'neon_recovery_acceptance'`);
  if (relation.rows.length !== 1 || relation.rows[0]?.kind !== 'v'
    || relation.rows[0]?.owner !== RECOVERY_ROLES.DEMO_MIGRATION_DATABASE_URL) {
    throw new Error('NEON_RECOVERY_MARKER_INVALID');
  }
  const marker = await client.query(`SELECT branch_id, source_branch_id, snapshot_id, object_manifest_sha256,
    created_at, expires_at FROM public.neon_recovery_acceptance WHERE singleton = true`);
  const row = marker.rows[0];
  const created = new Date(row?.created_at).getTime();
  const expires = new Date(row?.expires_at).getTime();
  if (marker.rows.length !== 1 || row.branch_id !== branch || PRESERVED_BRANCHES.has(branch)
    || row.source_branch_id !== RECOVERY_ROOT || row.snapshot_id !== RECOVERY_SNAPSHOT
    || row.object_manifest_sha256 !== RECOVERY_MANIFEST || !Number.isFinite(created) || !Number.isFinite(expires)
    || created > now || now >= expires || expires <= created || expires - created > 60 * 60_000) {
    throw new Error('NEON_RECOVERY_MARKER_INVALID');
  }
  return expires;
}
