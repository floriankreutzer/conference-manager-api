# Scoped Catering connection setup

Tracking: `floriankreutzer/conference-manager#232`. This default-off follow-up adds setup and listing
to the configuration runtime; it does not establish provider verification, credential custody,
health, delivery, ordering entitlement or Manager approval.

GET `/api/v1/integrations/catering` lists only the authenticated Tenant's configured connections,
together with the source-registered Catering providers and their supported modes. Pages contain at
most 20 connections in internal UUID order. The only optional query is one `afterIntegrationId`
internal UUID; it is a scoped position, never object/Tenant authority. The next cursor is the final
returned UUID only when another record exists. Unknown, duplicate or malformed queries fail closed.
Repository rows and page ordering/scope are validated before projection. Credentials, private
provider references and session/actor fields are absent from results.

POST on the same path requires the ordinary Customer session, HMAC CSRF and Tenant Admin integration
permission. The exact JSON command is schemaVersion=1, commandId (UUID), providerId and configuration.
Provider selection can reference only the fixed source registry; it cannot register an adapter,
endpoint or capability. Technical support cannot be upgraded by the command. The server generates
the Integration UUID and derives Tenant, actor, session, security version, timestamp, initial revision
zero-to-one and minimized audit evidence. Request bytes remain capped at 8192. Collection responses
are capped at 65536 bytes or a stricter runtime limit; instance responses remain capped at 16384.

The PostgreSQL transaction revalidates and locks the available Tenant, active User/security version
and exact live session before creating a configured Integration, initial configuration/history and
success audit. Its status `configured` describes saved setup only. The provider reference is an
internal, server-constructed setup receipt scoped to Tenant, provider, actor and commandId. It is
not an external account or verification reference and is never projected. No migration is needed;
the existing Tenant-composite Integration and configuration/history constraints apply.

Repeating the same command scope and normalized configuration returns the original revision-one
receipt, even if the current configuration has since changed. It creates neither another connection
nor another success audit. Concurrent identical submissions serialize at the unique Integration
receipt. Reusing the command scope with different configuration returns a conflict. The browser
must refresh current state after an acknowledged setup/replay; a replay is not permission to
replace newer configuration. A different commandId intentionally creates another connection.
Unknown transaction/audit failure is never acknowledged as success. Failed audit rolls back the
Integration as well as configuration/history. The existing internal initialize port remains for an
independently established Integration; it is separate from create.

The only current runtime descriptor is explicit manual_catering. No network/API supplier is
implicitly admitted, and manual registration does not implement manual order delivery. Default-off
rollout, Demo rejection, no Production fallback, existing seed/checksum and all permanent browser
and database gates remain unchanged. Tenant Admin alone cannot approve business orders; Manager
alone cannot administer technical connections.

Native/application/HTTP tests cover closed setup intent, server-generated IDs, scope/role/session
denials, malformed or upgraded providers, safe bounded pages and corrupted repository outcomes.
Real PostgreSQL tests cover concurrent command replay, changed-command conflict, audit rollback of
new Integration rows, revoked writers, stable 20-record pagination and foreign-Tenant isolation.
Test definitions and synthetic ports are not live database/deployed/browser acceptance evidence.
Admin UI, credential and health workflows, durable dispatch and external provider qualification
remain required follow-up work.
