# Booking Integration Review Notes

This short-lived review note records the intended #54 review scope while the pull request is Draft. It must be removed before merge.

- Existing Employee/Manager Request workflow semantics remain unchanged.
- No public browser calendar-provider endpoint is introduced.
- No Microsoft Graph SDK/type or outbound URL is present in application/domain contracts.
- Provider operations require server authorization, active Tenant binding and entitlement.
- Calendar create uses a server-derived deterministic idempotency key.
- Provider-specific references remain opaque and Tenant-bound in PostgreSQL.
- Provider errors are normalized before reaching application callers or audit metadata.
- External provider success and local transaction success are not falsely described as distributed atomicity.
