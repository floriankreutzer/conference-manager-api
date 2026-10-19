# Catering configuration HTTP component

Tracking: `floriankreutzer/conference-manager#232`. The Customer runtime registers this module only when
`CATERING_CONFIGURATION_ENABLED=true`. It defaults off and is not a released external API or evidence
of an active provider. Unknown/empty/non-boolean environment values fail startup. Server-owned
`featureFlags` accepts only its exact boolean schema; a browser cannot activate it. Missing PostgreSQL
or audit dependencies fail startup when enabled. Demo activation is explicitly rejected.

The bounded route-module port is GET/PUT
`/api/v1/integrations/catering/{internal-integration-uuid}/configuration`.
The path selects an object, never a Tenant. Customer principal/session and Tenant guards derive
scope independently; the application service owns Tenant Admin integration authorization and
repository scope. PUT uses the existing principal guard's CSRF-required path and accepts exactly
schemaVersion, expectedRevision and configuration. The nested configuration retains its closed
registered capability/mode schema. Credentials, health, provider/Tenant overrides and approval are
not writable fields. The repository rechecks live session/authority inside the commit transaction.

Queries, GET bodies, unsupported methods, malformed/non-object JSON and unknown fields fail closed.
The port clips the runtime request bound to 8192 bytes and response bound to 16384 bytes, retaining
stricter configured limits. Byte counts include multibyte UTF-8. Existing content-type, encoding and
JSON validators are reused; compressed bodies are unsupported. Responses are bounded JSON with no
raw repository/private credential-reference projection, and success is not emitted before the size
check. Missing dependencies fail unavailable, unmatched paths are not claimed and errors propagate
through the established safe HTTP error boundary.

Component tests invoke the real configuration service/authorization policy behind deterministic
guard/repository fixtures. Runtime HTTP tests additionally use the actual opaque-cookie session
service, HMAC CSRF verification, Tenant guard, authorization policy and PostgreSQL read adapter over
a synthetic pool. They verify absent/revoked cookies, Manager-only and foreign-Tenant denial, absent,
incorrect and other-session CSRF tokens, foreign origin, safe projection, and default-off HTTP 404.
The pool/session repository fixtures are not PostgreSQL transaction or deployed acceptance evidence;
real database transaction tests belong to the persistence component and mandatory CI.

The only runtime registration is source-defined `manual_catering`, with six explicit manual modes.
This descriptor neither delivers a manual order nor claims an API adapter. Unknown or Demo providers
are never substituted. Existing integrations/configurations are not created, backfilled or activated.
This endpoint edits only already-authorized initialized configuration. It grants no ordering,
approval, credential, entitlement or provider-network authority. Disabling the flag removes the
route without modifying persisted rows/history. No jobs, timers or outbound calls are started.

Admin setup/list/create UI, actual credential custody/lifecycle/health, manual delivery, qualified
API adapters, current source OpenAPI and release-bound publication remain required follow-up work.
No external Developer documentation is published by this default-off component.
