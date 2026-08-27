const INTERNAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const IMMUTABLE_TABLES = Object.freeze([
  'tenant_cost_allocation_revisions',
  'tenant_booking_policy_revisions',
  'tenant_catalogue_revisions',
  'tenant_organization_revisions',
]);

const MUTABLE_TABLES = Object.freeze([
  'tenant_cost_centers',
  'tenant_cost_allocation_configuration',
  'tenant_booking_policy_configuration',
  'tenant_organization_settings',
]);

function requireTenantIds(tenantIds) {
  if (
    !Array.isArray(tenantIds)
    || tenantIds.length < 1
    || tenantIds.some((tenantId) => typeof tenantId !== 'string' || !INTERNAL_UUID.test(tenantId))
  ) {
    throw new TypeError('TEST_TENANT_IDS_INVALID');
  }
  return Object.freeze([...new Set(tenantIds.map((tenantId) => tenantId.toLowerCase()))]);
}

async function relationExists(pool, table) {
  const result = await pool.query('SELECT to_regclass($1) IS NOT NULL AS exists', [`public.${table}`]);
  return result.rows[0]?.exists === true;
}

async function deleteImmutableRows(pool, table, tenantIds) {
  if (!await relationExists(pool, table)) return;
  await pool.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
  try {
    await pool.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [tenantIds]);
  } finally {
    await pool.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
  }
}

export async function removeSaas2TenantAdministrationFixtures(pool, tenantIds) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');
  const scopedTenantIds = requireTenantIds(tenantIds);
  for (const table of IMMUTABLE_TABLES) {
    await deleteImmutableRows(pool, table, scopedTenantIds);
  }
  for (const table of MUTABLE_TABLES) {
    if (await relationExists(pool, table)) {
      await pool.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1::uuid[])`, [scopedTenantIds]);
    }
  }
}
