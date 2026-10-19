// Internal SQL write shared by the two explicitly authorized issuance ports.
// The grant INSERT trigger independently enforces offline-owner or live strong
// session authority. This function does not generate or authorize a grant.
export async function insertPlatformPasskeyEnrollmentGrant(client, record, issuerRole) {
  const result = await client.query({ name: 'platform-passkey-enrollment-grant-insert',
    text: `WITH database_time AS (SELECT clock_timestamp() AS now)
      INSERT INTO platform_passkey_enrollment_grants
        (id,operator_id,operator_security_version,environment,security_epoch,provider,
          provider_tenant_reference,provider_subject_reference,kind,approval_reference,issuer_role,
          issued_from_session_id,token_hash,correlation_id,created_at,expires_at)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now,now + ($15 * INTERVAL '1 second')
        FROM database_time RETURNING created_at,expires_at`,
    values: [record.id,record.operatorId,record.operatorSecurityVersion,record.environment,record.securityEpoch,
      record.providerIdentity.provider,record.providerIdentity.tenantReference,record.providerIdentity.subjectReference,
      record.kind,record.approvalReference,issuerRole,record.issuedFromSessionId,
      record.tokenHash,record.correlationId,record.ttlSeconds] });
  if (result.rowCount !== 1) throw new Error('PLATFORM_PASSKEY_GRANT_PERSISTENCE_FAILED');
  return result.rows[0];
}
