const SAAS3_TABLES = Object.freeze([
  'platform_projection_outbox',
  'platform_runtime_tenant_mappings',
  'platform_runtime_deployments',
  'platform_quota_operation_receipts',
  'platform_operational_quotas',
  'platform_metering_period_revisions',
  'platform_metering_periods',
  'platform_metering_events',
  'platform_microsoft_reconsent_handoffs',
  'platform_recovery_contexts',
  'platform_diagnostic_events',
  'microsoft365_room_discovery_observations',
  'platform_microsoft_fleet_capabilities',
  'platform_microsoft_fleet_snapshots',
  'platform_tenant_readiness_evidence',
  'platform_tenant_readiness_snapshots',
  'platform_entitlement_change_history',
  'platform_entitlement_package_revisions',
  'platform_entitlement_packages',
  'platform_operation_receipts',
  'platform_audit_checkpoints',
  'platform_audit_events',
  'platform_audit_chain_state',
  'platform_operator_change_alert_outbox',
  'platform_security_alert_outbox',
  'platform_break_glass_alert_outbox',
  'platform_break_glass_grants',
  'platform_oidc_auth_transactions',
  'platform_sessions',
  'platform_operator_tenant_scopes',
  'platform_operators',
]);

export async function clearSaas3TestState(pool) {
  const result = await pool.query(
    `SELECT table_name
     FROM information_schema.tables
     WHERE table_schema = current_schema()
       AND table_name = ANY($1::text[])`,
    [SAAS3_TABLES],
  );
  const existing = new Set(result.rows.map(({ table_name: tableName }) => tableName));
  const tables = SAAS3_TABLES.filter((table) => existing.has(table));
  if (!tables.length) return;
  await pool.query(`TRUNCATE ${tables.map((table) => `"${table}"`).join(', ')} RESTART IDENTITY CASCADE`);
  if (existing.has('platform_audit_chain_state')) {
    await pool.query('INSERT INTO platform_audit_chain_state (singleton) VALUES (true)');
  }
}
