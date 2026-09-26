# Shared Server-Backed Demo Runtime

## Authority and scope

This document is the backend deployment and operations contract for the SaaS 3.5 Shared Demo Runtime. It implements the accepted cross-repository decision in `conference-manager/docs/ADR-010-SHARED-SERVER-BACKED-DEMO-RUNTIME.md`.

The Demo is a real server-backed product runtime with deterministic simulated identities, data and Microsoft 365 outcomes. It is not Production, a Production fallback, a browser-owned data store, external acceptance evidence or proof of a live Microsoft integration.

The runtime has two independently started API processes:

- `src/demo/customer-main.js` composes the customer API and customer Demo control routes;
- `src/demo/platform-main.js` composes the Platform API and Platform Demo control routes.

Both processes use the canonical application, authorization and PostgreSQL adapters. They connect with different database principals to one isolated PostgreSQL database. This one database is the authoritative state observed by both browser surfaces, so a customer mutation is visible to an authorized Platform read and a Platform mutation is visible to the affected customer flow.

## Runtime topology

```text
Customer Demo browser
  -> dedicated HTTPS origin
     -> customer Demo process
        -> customer Demo PostgreSQL role
           -> one isolated Demo database

Platform Demo browser
  -> separate dedicated HTTPS origin
     -> Platform Demo process
        -> Platform Demo PostgreSQL role
           -> the same isolated Demo database

Reset/seed command or authorized Platform reset route
  -> reset-only PostgreSQL role
     -> the same isolated Demo database

Demo schema commands
  -> migration-owner PostgreSQL role
     -> the same isolated Demo database
```

The customer and Platform origins, session cookies, CSRF secrets, session secrets and database credentials are distinct. Neither browser surface can reuse the other surface's cookie as authority. The database name must match `conference_manager_demo_*`; a Production database name or target is rejected before reset.

## Production and Demo isolation

Production entrypoints remain `src/index.js` and `src/platform-main.js`. They must not import `src/demo/`, register Demo control routes, instantiate Demo personas or select the deterministic provider. Authentication, provider, database or configuration failure in Production must fail closed and must never activate Demo behavior.

The Demo entrypoints are separate composition roots and require all of the following before they start:

- `NODE_ENV=demo` for a deployed Demo, or `NODE_ENV=test` for isolated automated tests;
- `DEMO_RUNTIME=shared-postgres-v1`;
- the exact source-defined `DEMO_SEED_VERSION`;
- separate customer and Platform HTTPS origins;
- four distinct database URLs, roles and passwords pointing to the same host, port and Demo database;
- distinct customer session, customer CSRF, Platform session and Platform CSRF secrets, plus one
  dedicated Tenant-audit HMAC secret shared only where both processes access the same Tenant audit
  chain;
- certificate- and hostname-verifying database TLS for a deployed Demo.

`loadDemoConfig` rejects Pilot/Production mode, aliased origins, database principals, passwords or
secrets, mismatched database targets, administrative database role names, real-provider variables,
and conflicting normal database/origin/session/Platform configuration, including the Production
`AUDIT_HMAC_SECRET`. Real Entra, Microsoft Graph,
customer or Production credentials must not be present in the Demo process environment.

`DEMO_TENANT_AUDIT_HMAC_SECRET` is deliberately common to customer Tenant-audit writes/reads and
Platform operations that append or verify that same Tenant audit chain. The Platform control-plane
audit HMAC and signed-cursor secrets remain a different domain derived from the Platform session
secret. The shared Tenant-audit key must be unique from every other Demo secret and database
password; it is not a general cross-process session or authorization secret.

The Demo uses `src/demo/provider/microsoft365-client.js`, which implements the provider-neutral Microsoft 365 contract without a network transport. The source-defined scenarios produce deterministic success, transient conflict and degraded-provider behavior. Its room inventory is derived from every fixture room mapping, so healthy discovery and mapping journeys return the same rooms that the canonical seed persists. Inputs and outputs retain the production provider contract's positive validation and bounded shapes. Demo consent URLs remain on the configured Demo origin and never target Microsoft.

## PostgreSQL roles and schema

Provision four purpose-specific login roles with unique credentials:

| Role purpose | Allowed responsibility | Prohibited responsibility |
| --- | --- | --- |
| Customer runtime | Canonical customer reads and mutations plus the customer Demo persona view | Platform identity/control-plane authority, Demo reset, schema ownership |
| Platform runtime | Canonical Platform reads and mutations plus Platform persona/provider simulation views | Customer session authority, Demo reset, schema ownership |
| Reset/seed | Verified destructive reset and deterministic seed over the fixed Demo table inventory | Normal browser request handling, schema ownership, use against a non-Demo database |
| Migration owner | Canonical and Demo migration DDL/ledger ownership for this isolated database | Normal browser request handling or reset execution |

The deployed database first receives the canonical Production schema migrations `001` through `038`. The Demo overlay is a separate checksum-protected migration stream under `demo-migrations/`; its current schema version is `004`. The overlay adds only the Demo sentinel, deterministic provider/persona references, immutable-sentinel protection, views and least-privilege role grants. Migration `002` grants both runtime roles read-only access to the Demo migration ledger solely for Demo-overlay readiness verification. Migration `003` grants those same runtime roles read-only access to the canonical `schema_migrations` ledger solely because the existing normal PostgreSQL schema-readiness check verifies the canonical version there. Migration `004` grants only `INSERT` and `TRUNCATE` on the canonical `request_attribution_migration_state` table to the reset role so reset can reinitialize that singleton after truncation; customer and Platform runtime roles receive no access. No overlay grants ledger write, schema ownership, migration or broader application authority, and the runtime does not auto-migrate at startup.

Before either HTTP listener starts, its runtime verifies the connected database and role against the
immutable sentinel, the exact Demo overlay ledger `1..4`, and its complete persona seed. Platform
also verifies the provider-simulation Tenant inventory. The same check remains in normal readiness;
missing, stale or mismatched state therefore fails closed both before serving and while running.
The normal readiness chain additionally verifies connectivity and the exact canonical schema version
through read-only access to `schema_migrations`; both Customer and Platform runtime roles must pass
that check before a deployment is considered ready.

The Demo migration runner refuses a missing, gapped or non-exact canonical migration ledger. A future canonical migration therefore requires an explicit Demo inventory, grant, reset and fixture review before the Demo schema version can advance.

## Deterministic seed and reset contract

`src/demo/fixture.js` is the source of the deterministic baseline. It contains bounded synthetic Tenants, customer personas, Platform personas, settings, Requests, provider scenarios, deployment inventory and metering facts. It contains no real customer identifiers, provider tokens, credentials or Production references.

The seed descriptor contains:

- runtime schema version `1`;
- seed version `saas-3.6-shared-demo-v5`;
- a domain-separated SHA-256 semantic checksum over canonicalized fixture meaning.

Reset is destructive by design and is allowed only in the isolated Demo database. Before truncation, the reset repository verifies all of the following:

- the immutable Demo sentinel and sentinel key;
- the current database name and expected reset role;
- distinct recorded customer, Platform and reset roles;
- the complete canonical migration sequence `1..38`;
- the exact expected table inventory;
- the source fixture's calculated domain-separated semantic checksum.

Every normal customer or Platform request executes under a transaction-scoped shared Demo advisory lock. Reset acquires the matching transaction-scoped exclusive advisory lock inside the same `SERIALIZABLE` transaction that performs the complete truncate, seed, Demo provider/persona insertion and semantic readback. PostgreSQL releases these transaction locks automatically on commit or rollback; there is no separate session-level reset lock/unlock lifecycle. A transaction-lock acquisition or transaction-completion failure, sentinel mismatch, schema drift, table drift, seed failure or checksum mismatch fails the operation; partial state cannot commit. The post-seed semantic projection must reproduce the source checksum before success is returned.

Fixture business timestamps remain fixed for reproducible semantic checksums. Operational Platform
projection freshness is different: each seed/reset reads PostgreSQL `clock_timestamp()` inside the
reset transaction and uses that reset-time instant as the projection observation time, so a later
reset cannot immediately produce stale readiness projections.

An authenticated HTTP reset also revalidates its exact internal Platform session, operator and
security version after acquiring the exclusive transaction lock and before destructive SQL. A second request
that authorized concurrently cannot continue after the first reset revoked all sessions. Reset
does not restart PostgreSQL sequences: generated audit and operational identifiers remain
monotonic, and the reset role does not require sequence ownership or migration-owner membership.

The reset service returns only `seedVersion` and `checksum`. The CLI wraps that descriptor in a
bounded completion envelope; the HTTP reset route adds its server request ID. Reset truncates all
customer and Platform sessions. The authorized Platform reset route therefore also clears the
caller's Platform cookie; every browser must establish a new Demo session after reset.

Platform process startup refreshes the canonical Platform projections under the shared gate before
accepting traffic. The HTTP reset path performs the same bounded projection refresh after the
authoritative reset commits and before reporting success. If that post-reset refresh fails, the HTTP
operation fails and Platform readiness must not be claimed; restart or retry the canonical refresh
rather than editing projection rows. It does not undo or conceal the already verified reset commit.

Do not bypass a failed reset with direct SQL, disabled triggers, a Production credential or a manually edited checksum. Stop both Demo processes, preserve the bounded error code, correct the configuration/schema mismatch, and recreate the isolated Demo database when integrity cannot be established.

## Demo sessions, personas and CSRF

The browser may request a named Demo persona only as bounded demonstration intent. It cannot submit roles, permissions, User/operator IDs, security versions, Tenant lifecycle state, target scope, assurance timestamps or provider identity.

Customer control routes:

| Method and path | Contract |
| --- | --- |
| `GET /api/v1/demo/session` | Reuse a recognized valid customer Demo session or issue the server-defined default Employee session. |
| `GET /api/v1/demo/tenants` | Return the bounded synthetic Tenant directory only after customer session authentication. |
| `PUT /api/v1/demo/session/context` | Require customer session authentication and CSRF, then rotate to an exact server-known Tenant/persona pair. |

Platform control routes:

| Method and path | Contract |
| --- | --- |
| `GET /api/v1/platform/demo/session` | Reuse a recognized valid Platform Demo session or issue the server-defined support-reader session. |
| `PUT /api/v1/platform/demo/session/persona` | Require Platform session authentication and CSRF, then rotate to an exact server-known Platform persona. |
| `POST /api/v1/platform/demo/reset` | Require Platform session authentication, CSRF, exact `{ "confirm": true }`, and fresh step-up `platform:recovery:execute` authorization; reset and clear the Platform session. |

Persona and Tenant values are positively validated and matched against source-defined server mappings. A missing mapping is rejected; it never creates an ad hoc identity. Session issue uses the canonical PostgreSQL session repositories. A persona switch issues the new session and revokes the old one; if old-session revocation fails, the new session is revoked and the switch fails. The two establish routes deliberately issue their documented defaults when no cookie exists; protected routes reject absence, and malformed, expired, revoked or security-version-stale session state fails through the canonical session boundary.

A default is issued only when the matching Demo cookie is genuinely absent. A presented malformed,
duplicated, expired, revoked or unknown Customer or Platform Demo cookie fails closed and is never
silently replaced by a new default session.

Customer roles remain `employee`, `conference_manager` and `tenant_admin`; customer permissions are derived from the canonical Tenant authorization policy. `dual_role` is a Demo persona label that deterministically composes the `employee`, `conference_manager` and `tenant_admin` roles through that policy; it is not a stored fourth customer role. Platform personas use the canonical Platform role/permission policy and server-owned target scope. A customer session never authorizes Platform routes, a Platform session never becomes a Tenant Principal, and choosing a different Demo Tenant creates a new server-issued customer Principal instead of using the submitted Tenant ID directly on business queries.

## Deployment and initial seed

Provisioning order is mandatory:

1. create a dedicated empty PostgreSQL database whose name matches `conference_manager_demo_*`;
2. create the four distinct purpose-specific Demo roles and store their credentials in protected deployment configuration;
3. apply canonical migrations `001..038` with the reviewed database migration identity;
4. remove normal `DATABASE_URL`, `PUBLIC_ORIGIN`, session/CSRF, `PLATFORM_*` and real-provider variables from the Demo command environment;
5. supply the complete `DEMO_*` configuration and run `npm run demo:db:migrate`;
6. run `npm run demo:db:reset -- --confirm-seed-version=saas-3.6-shared-demo-v5` to install and verify the initial deterministic seed;
7. start `npm run start:demo:customer` and `npm run start:demo:platform` as separate processes;
8. route the customer and Platform HTTPS origins only to their matching process;
9. verify both readiness endpoints, both session endpoints, a customer persona/Tenant switch, a denied Platform operation, a shared-state journey and one deterministic provider-degradation journey;
10. run an authorized reset, verify the returned seed descriptor, re-establish both sessions and confirm the baseline checksum is unchanged.

The Customer process receives only its Customer database URL and Customer session/CSRF secrets.
The Platform process receives its Platform database URL plus the reset URL used exclusively by its
authenticated reset component; it does not receive Customer or migration-owner credentials.
Migration and initial-reset commands receive their additional purpose-specific credentials only
for their bounded command lifetime. Surface-specific loaders reject excess database credentials.

The commands are intentionally separate:

```bash
npm run demo:db:migrate
npm run demo:db:reset -- --confirm-seed-version=saas-3.6-shared-demo-v5
npm run start:demo:customer
npm run start:demo:platform
```

`npm run demo:db:reset -- --confirm-seed-version=saas-3.6-shared-demo-v5` is the only supported
initial seed and reseed operation. `npm run demo:db:rollback` rolls back only the latest Demo
overlay migration and is not a routine populated-environment recovery mechanism. The foundation
down migration fails closed while Demo persona/provider state is in use. Prefer replacement of the
isolated Demo database over destructive manual cleanup.

## Required configuration

| Variable | Requirement |
| --- | --- |
| `NODE_ENV` | `demo` for deployment; `test` only for isolated tests |
| `DEMO_RUNTIME` | Exact `shared-postgres-v1` |
| `DEMO_SEED_VERSION` | Exact `saas-3.6-shared-demo-v5` |
| `DEMO_CUSTOMER_ORIGIN` | Exact dedicated HTTPS origin |
| `DEMO_PLATFORM_ORIGIN` | Different exact dedicated HTTPS origin |
| `DEMO_CUSTOMER_DATABASE_URL` | Customer role; isolated shared Demo target |
| `DEMO_PLATFORM_DATABASE_URL` | Platform role; same target, different role/password |
| `DEMO_RESET_DATABASE_URL` | Reset role; same target, different role/password |
| `DEMO_MIGRATION_DATABASE_URL` | Migration owner; same target, different role/password |
| `DEMO_DATABASE_SSL` | `verify-full` in deployed Demo; `disable` permitted only in Test |
| `DEMO_RATE_LIMIT_MAX` | Optional bounded per-process request capacity (`1`–`10000`); default `120`; isolated full-journey CI uses `1000` |
| `DEMO_CUSTOMER_SESSION_SECRET` | Protected unique secret, at least 32 bytes |
| `DEMO_CUSTOMER_CSRF_SECRET` | Protected unique secret, at least 32 bytes |
| `DEMO_PLATFORM_SESSION_SECRET` | Protected unique secret, at least 32 bytes |
| `DEMO_PLATFORM_CSRF_SECRET` | Protected unique secret, at least 32 bytes |
| `DEMO_TENANT_AUDIT_HMAC_SECRET` | Protected stable key shared by customer and Platform only for per-Tenant audit chains, at least 32 bytes |

Do not place any of these values in source, documentation examples, browser configuration, logs, audit metadata, screenshots, issue comments or test evidence.

The Shared Demo CI provisioner registers every generated database password, complete connection
string, session/CSRF secret and audit-HMAC key with the GitHub Actions masking boundary before
database work or `GITHUB_ENV` propagation. Environment command-file output accepts only canonical
uppercase names and non-empty single-line values.

## Operations and evidence

For each deployed Demo candidate, record:

- backend and frontend commit/artifact identifiers;
- canonical schema version `38` and Demo overlay version `4`;
- seed version and semantic checksum returned by reset;
- customer and Platform origin identities without credentials;
- the browser/integration test run covering cross-process shared state;
- deterministic success, conflict and degradation scenarios;
- negative persona, CSRF, role, target-scope and cross-Tenant results;
- confirmation that real provider/Production configuration was absent.

Demo evidence proves only the deterministic simulated runtime behavior exercised. It does not satisfy Production Entra, Microsoft Graph, Exchange Application RBAC, edge, backup/restore, DAST, penetration-test, security-owner or customer acceptance requirements.

## Retired trusted CLI

The former process-local Tenant-operator CLI, invitation-artifact helper and trusted source-marker authorization model are retired and must not be reintroduced for Demo convenience. Normal Platform operations use authenticated Platform HTTP. The separately governed, dual-control, grant-bound Production recovery fallback remains an exceptional operational control and is not Demo identity or reset authority.

## Equipment composition rollout

Migration 035 adds exact Request composition v3 Equipment constraints to the existing Request,
revision and booking-change JSON snapshots. Existing v1/v2 data is not rewritten. Create,
resubmit, transition, history and confirmed-change paths support the accepted nested version,
while the outer response envelopes remain unchanged. Equipment is resolved using existing
Tenant-composite Catalogue tables, charged once and included in allocation.

The `saas-3.6-shared-demo-v5` reset fixture contains distinct priced Northwind/Contoso Equipment
and verifies those identity, price and applicability facts during semantic readback. Demo overlay
004 supplies only the reset privilege required by canonical attribution migration 036. Apply
canonical migrations first, apply Demo overlays 001 through 004, reset/reseed Demo, deploy both API
processes at one compatible SHA, verify Catalogue pages and then pin/deploy the updated frontend.
Down 035 refuses once any v3 snapshot/proposal/history exists; use a compatible binary or a forward
fix. Production never activates Demo authority.
