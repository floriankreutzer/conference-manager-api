# Platform Runtime and Deployment Status

## Authority and scope

Root `AGENTS.md`, `docs/CODING-STANDARDS.md` and `docs/OBSERVABILITY.md` are authoritative. This
document defines the protected application-layer projection introduced for SaaS 3 issue #102. It
also defines its minimized PostgreSQL read model and audited repository adapter. The Platform HTTP
route, control-plane presentation and real deployed-environment population remain separate
integration/evidence surfaces.

The existing public health endpoints remain unchanged. In particular,
`GET /api/v1/health/status` continues to expose only aggregate health plus bounded API build
metadata. It must not expose dependency topology, database versions, Tenant routing or deployment
evidence.

## Protected runtime projection

`createPlatformRuntimeStatusService` exposes two application use cases:

- `listApprovedDeployments({ operatorContext })` lists only records supplied by the approved deployment
  owner;
- `getServingDeploymentForTenant({ operatorContext, tenantId })` resolves one internal Tenant through the
  server-side routing owner.

Both require the dedicated `platform:runtime:read` permission. Tenant correlation additionally
requires a separate Tenant-target authorization decision before repository access. The Tenant
lookup accepts no environment or deployment selector, preventing a browser from choosing the
correlation result.

Authorization-policy and target-policy denials become `PlatformOperationDeniedError`, so the HTTP
boundary returns its established 403 contract rather than misclassifying denial as an internal
failure. Each successful list or Tenant lookup appends `platform.runtime.read` through the separate
Platform audit repository in the same PostgreSQL transaction as the read. Tenant lookup evidence is
bound to the exact target Tenant, including an explicit `unknown` mapping result.

Customer Principals and Tenant roles are not Platform Principals and cannot use this service.

## Source and ownership

The PostgreSQL tables are a materialized, read-only-to-the-application observation model, not a
browser- or operator-mutable deployment authority. There is no Platform HTTP mutation method. The
sole permitted writer is the protected deployment reconciliation process owned by the approved
topology: it derives records from protected deployment configuration, observed frontend and API
build metadata, the existing API health owner, exact PostgreSQL schema readiness, the authoritative
Tenant-routing topology and approved evidence references. Provisioning that writer and its values is
blocked on issue #113; SQL entered by an operator or browser payload is not an acceptable substitute.

`platform_runtime_deployments` identifies one approved environment/deployment observation;
`platform_runtime_tenant_mappings` is only a materialized copy of the routing owner's mapping. A
deployment cannot be superseded while a Tenant mapping references it, mapping identity cannot be
rewritten, and only approved deployments can be mapped. Superseded observations are retained for at
least 24 months. Migration rollback refuses to drop any runtime or metering data.

The service validates correlation across the declared environment and deployment reference for:

- frontend build metadata;
- API build metadata;
- database schema state;
- aggregate required and optional dependency state.

An environment or deployment disagreement is an explicit mismatch. The service never accepts
runtime values from the browser or Tenant application.

## Closed repository DTO

Each repository record contains exactly:

- environment: `development`, `test`, `pilot` or `production`;
- deployment reference and deployment UTC time;
- expected and observed frontend version/build ID;
- expected and observed API version/build ID;
- expected and current database schema version;
- aggregate required and optional dependency state;
- observation UTC time;
- approved release, change, rollback and runbook references.

Every component also carries its source environment and deployment reference so the application
service can detect joins across different deployments. Identifiers are bounded. Evidence fields are
opaque approved references, not arbitrary URLs. A later HTTP/UI adapter must resolve them through an
allowlisted evidence owner rather than turning repository text into a navigation target.

The closed DTO rejects unexpected keys. Hosts, ports, connection strings, environment-variable
dumps, credentials, raw provider failures, internal dependency names and infrastructure-console
URLs are outside the contract and cause validation failure rather than disclosure.

## State model

Component and schema metadata states are:

- `current`: expected and observed identifiers match the same deployment;
- `mismatch`: build, version, schema, environment or deployment correlation differs;
- `unknown`: required metadata is explicitly `null`.

Freshness is independent:

- `fresh`: the server observation is within the configured maximum age;
- `stale`: the observation is older than that age;
- `unknown`: the observation is missing or in the future relative to the server clock.

Aggregate dependency state reuses the current health semantics:

- required dependencies: `ready`, `not_ready` or `unknown`;
- optional dependencies: `ready`, `degraded` or `unknown`.

The protected projection produces `ready`, `degraded`, `not_ready`, `mismatch`, `stale` or `unknown`
as its overall state. Missing, future, stale or mismatched metadata never appears healthy. Fixed
reason codes preserve simultaneous findings for incident correlation without exposing raw failures.

Severity is deterministic when findings overlap: a known required-dependency `not_ready` wins over
all metadata findings; a known build/schema/deployment `mismatch` wins over staleness or unknown
secondary data; `stale` wins over unknown; `unknown` wins over optional degradation; then
`degraded` and `ready`. The projection retains every applicable reason code even when one state has
display precedence. This prevents a missing optional observation from masking a known core outage or
known deployment mismatch.

If an authorized Tenant has no serving-deployment mapping, the result is explicitly
`correlationState: unknown` with `runtime: null`. A repository result for a different Tenant fails
closed as a scope mismatch.

## Operational use

The projection provides enough bounded context to answer:

- which approved frontend and API build is expected and observed;
- which deployment reference and time owns the observation;
- whether the expected database schema matches the current schema;
- whether core dependencies are ready or optional dependencies are degraded;
- whether metadata is fresh, missing, stale or internally inconsistent;
- which approved release/change/rollback/runbook evidence should be consulted.

It does not execute rollback, expose infrastructure-console access or establish a new deployment
mutation authority. Recovery remains a separately authorized, step-up and audited workflow.

## Application ports

`createPlatformRuntimeStatusService` requires:

- `repository.listApprovedDeployments`: a bounded list derived from approved server-side sources;
- `repository.findServingDeploymentByTenantId`: authoritative Tenant-to-deployment resolution;
- `authorizationPolicy.authorize`: dedicated Platform runtime-read enforcement;
- `tenantTargetPolicy.authorize`: independent Tenant-target scope enforcement;
- `auditService.createEvent`: trusted `platform.runtime.read` evidence;
- a server clock and bounded freshness threshold.

`createPostgresPlatformRuntimeStatusRepository` additionally requires the separate Platform audit
repository. Its freshness default is five minutes; configuration is bounded to one second through
24 hours in whole-second increments.

## Verification and remaining integration

`tests/platform-runtime-status.test.js` covers the dedicated canonical permission, 403-compatible
customer and target denial, absence of deployment selectors, cross-Tenant mapping failure,
ready/degraded/not-ready transitions and combined severity precedence, build/schema/environment/
deployment mismatches, stale/missing/future observations, strict disclosure rejection, bounded
evidence references, read audit intent and immutable output. The PostgreSQL suite covers minimized
fleet/Tenant reads, target-key isolation, audit rollback, evidence-reference constraints, routing
immutability and supersession guards.

Remaining integration and external evidence:

- protected Platform HTTP and accessible control-plane UI integration;
- the #113-owned protected deployment reconciler/configuration that populates expected and observed
  frontend/API builds, schema, health, routing and approved evidence references;
- authorization tests through the isolated Platform session boundary;
- Demo fixtures and normal/rollback runbook integration;
- deployed-environment evidence for real build, schema, routing and rollback correlation.

The final item depends on an approved and provisioned production topology and is external acceptance
evidence; repository unit tests cannot self-approve it.
