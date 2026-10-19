// Shared catalogue-write guard. Keep Tenant -> User -> Session lock order.
export async function lockCateringCatalogueManager(client, input) {
  const tenant = await client.query({
    name: 'catering-assignment-tenant-lock', text: "SELECT id FROM tenants WHERE id=$1 AND status='active' FOR UPDATE",
    values: [input.tenantId],
  });
  if (tenant.rowCount !== 1) return false;
  const user = await client.query({
    name: 'catering-assignment-user-lock',
    text: 'SELECT id FROM users WHERE tenant_id=$1 AND id=$2 AND active=true AND security_version=$3 FOR SHARE',
    values: [input.tenantId, input.actorUserId, input.expectedSecurityVersion],
  });
  if (user.rowCount !== 1) return false;
  const session = await client.query({
    name: 'catering-assignment-session-lock',
    text: `SELECT id FROM sessions WHERE tenant_id=$1 AND user_id=$2 AND id=$3 AND principal_version=$4
      AND revoked_at IS NULL AND expires_at>clock_timestamp() AND roles @> ARRAY['conference_manager']::text[]
      AND permissions @> ARRAY['tenant:catalogue:manage']::text[] FOR SHARE`,
    values: [input.tenantId, input.actorUserId, input.sessionId, input.expectedSecurityVersion],
  });
  return session.rowCount === 1;
}
