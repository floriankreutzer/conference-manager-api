import { DEMO_DATABASE_SENTINEL_KEY, DEMO_RUNTIME_ADVISORY_LOCK } from '../../demo/runtime-contract.js';

function sequence(value, length) {
  return Array.isArray(value) && value.length === length && value.every((item, index) => Number(item) === index + 1);
}

async function state(client, expected) {
  const result = await client.query({
    text: `SELECT sentinel_key, runtime_schema_version, database_name::text, customer_role::text,
      platform_role::text, reset_role::text, current_database() AS actual_database, current_user::text AS actual_role,
      (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'schema_migrations') AS canonical_owner,
      (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'demo_schema_migrations') AS demo_owner,
      (SELECT array_agg(version ORDER BY version) FROM schema_migrations) AS canonical_versions,
      (SELECT array_agg(version ORDER BY version) FROM demo_schema_migrations) AS demo_versions,
      (SELECT count(*)::text FROM tenants) AS tenants,
      (SELECT count(*)::text FROM requests) AS requests,
      (SELECT count(*)::text FROM audit_events) AS tenant_audit,
      (SELECT count(*)::text FROM request_revisions) AS request_revisions,
      (SELECT count(*)::text FROM platform_audit_events) AS platform_audit
      FROM demo_database_sentinel WHERE singleton = true`,
  });
  const row = result.rows[0];
  if (result.rowCount !== 1 || row.sentinel_key !== DEMO_DATABASE_SENTINEL_KEY || Number(row.runtime_schema_version) !== 1
    || row.database_name !== expected.database || row.actual_database !== expected.database
    || row.actual_role !== expected.migration || row.canonical_owner !== expected.migration || row.demo_owner !== expected.migration
    || row.customer_role !== expected.customer || row.platform_role !== expected.platform || row.reset_role !== expected.reset
    || ![44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75]
      .some((version) => sequence(row.canonical_versions, version))
    || ![9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33]
      .some((version) => sequence(row.demo_versions, version))
    || (row.canonical_versions.length < 73 && row.demo_versions.length > 32)
    || (row.canonical_versions.length < 72 && row.demo_versions.length > 31)
    || (row.canonical_versions.length < 70 && row.demo_versions.length > 30)
    || (row.canonical_versions.length < 69 && row.demo_versions.length > 29)
    || (row.canonical_versions.length < 66 && row.demo_versions.length > 28)
    || (row.canonical_versions.length === 44 && row.demo_versions.length !== 9)
    || (row.canonical_versions.length === 45 && row.demo_versions.length > 11)
    || (row.canonical_versions.length === 46 && row.demo_versions.length > 12)
    || (row.canonical_versions.length === 47 && row.demo_versions.length > 13)
    || (row.canonical_versions.length === 48 && row.demo_versions.length > 14)
    || (row.canonical_versions.length === 49 && row.demo_versions.length > 15)
    || (row.canonical_versions.length === 50 && row.demo_versions.length > 16)
    || (row.canonical_versions.length <= 62 && row.demo_versions.length > 27)
    || (row.canonical_versions.length === 60 && row.demo_versions.length > 26)
    || (row.canonical_versions.length === 59 && row.demo_versions.length > 25)
    || (row.canonical_versions.length === 58 && row.demo_versions.length > 24)
    || (row.canonical_versions.length === 57 && row.demo_versions.length > 23)
    || (row.canonical_versions.length === 56 && row.demo_versions.length > 22)
    || (row.canonical_versions.length === 55 && row.demo_versions.length > 21)
    || (row.canonical_versions.length === 54 && row.demo_versions.length > 20)
    || (row.canonical_versions.length === 53 && row.demo_versions.length > 19)
    || (row.canonical_versions.length === 52 && row.demo_versions.length > 18)
    || (row.canonical_versions.length === 51 && row.demo_versions.length > 17)) {
    throw new Error('DEMO_METRICS_MIGRATION_PRECONDITIONS_FAILED');
  }
  return Object.freeze({ canonicalVersion: row.canonical_versions.length, demoVersion: row.demo_versions.length,
    retained: [row.tenants, row.requests, row.tenant_audit, row.request_revisions, row.platform_audit] });
}

// A session-level exclusive gate spans the existing separately transactional migration runners.
// Runtime requests and resets already use this same server-owned advisory-lock identity.
export async function withDemoMetricsMigrationGate(pool, expected, upgrade) {
  if (typeof upgrade !== 'function' || !/^conference_manager_demo_[a-z0-9_]{1,48}$/.test(expected?.database)
    || ![expected.customer, expected.platform, expected.reset, expected.migration]
      .every((role) => typeof role === 'string' && /^[a-z][a-z0-9_]{2,62}$/.test(role))
    || new Set([expected.customer, expected.platform, expected.reset, expected.migration]).size !== 4) {
    throw new TypeError('DEMO_METRICS_MIGRATION_CONFIGURATION_INVALID');
  }
  const client = await pool.connect(); let locked = false;
  try {
    await client.query("SET lock_timeout = '10s'");
    await client.query("SET statement_timeout = '30s'");
    await client.query('SELECT pg_advisory_lock($1)', [DEMO_RUNTIME_ADVISORY_LOCK]); locked = true;
    const before = await state(client, expected);
    await upgrade();
    const after = await state(client, expected);
    if (after.canonicalVersion !== 75 || after.demoVersion !== 33
      || after.retained.some((count, index) => count !== before.retained[index])) {
      throw new Error('DEMO_METRICS_MIGRATION_READBACK_FAILED');
    }
    return Object.freeze({ canonicalVersion: after.canonicalVersion, demoVersion: after.demoVersion,
      resetPerformed: false, retainedCountsMatch: true });
  } finally {
    try { if (locked) await client.query('SELECT pg_advisory_unlock($1)', [DEMO_RUNTIME_ADVISORY_LOCK]); }
    finally { client.release(); }
  }
}
