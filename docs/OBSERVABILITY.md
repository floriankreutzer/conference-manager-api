# Production Observability

## Authority and scope

Root `AGENTS.md` is authoritative. This document defines the production observability boundary introduced by SaaS 0 issue #55.

Observability is operational evidence, not an authorization source. The browser cannot influence Tenant identity, user identity, roles, permissions, provider references, metric labels, health dependency classification or support build metadata.

## Correlation

Every HTTP request receives a server-generated UUID in `X-Request-Id`. The same value is used as the correlation ID passed into supported application/audit/integration flows.

Correlation IDs are operational identifiers only. They are not credentials and must never grant access.

Operational request logs contain the correlation ID and a fixed route key, not the dynamic URL path. This prevents Request IDs or other object identifiers embedded in routes from becoming ordinary log fields.

## Structured operational logs

Operational logs are newline-delimited JSON written to stdout for collection by the hosting platform.

Supported event classes include:

- `server_started` and shutdown lifecycle events;
- `request_completed` with request ID, HTTP method, fixed route key, status code and duration;
- `security_request_denied` with only authentication/authorization category;
- `unhandled_error` with error class name, never raw error message/stack;
- `health_evaluated` with aggregate `ready`, `degraded` or `not_ready` state;
- `metric_sample` generated only by the bounded metric registry.

Operational logs must not contain session cookies, session IDs, CSRF tokens, provider tokens, raw provider payloads, passwords, private keys, connection strings, Tenant IDs, User IDs, Request IDs from dynamic paths, provider references or unnecessary personal/business content.

Audit evidence remains separate from operational logging. See `docs/AUDIT.md`.

## Metrics

`src/observability/metrics.js` owns the low-cardinality metric registry. Each accepted observation updates an in-process snapshot and, in production composition, emits a structured `metric_sample` event to stdout. The platform log/telemetry collector is responsible for aggregation across application instances.

Current metrics are:

| Metric | Dimensions | Purpose |
| --- | --- | --- |
| `api_requests_total` | fixed route, bounded method, status class | API volume/error-rate |
| `api_request_duration_ms` | fixed route, bounded method, status class | API latency |
| `authentication_failures_total` | fixed reason | unauthenticated request trend |
| `authorization_denials_total` | fixed reason | denied authenticated access trend |
| `booking_operations_total` | fixed operation, outcome | booking use-case outcome |
| `integration_calls_total` | fixed operation, outcome, retryable | external calendar-call outcome |
| `integration_call_duration_ms` | fixed operation, outcome, retryable | external calendar-call latency |
| `dependency_health_observations_total` | health state, required flag | dependency health trend |

Tenant ID, User ID, Request ID, email, provider reference and provider-specific resource IDs are deliberately not valid metric dimensions. HTTP methods outside the server allowlist are normalized to `OTHER` before metrics are recorded.

The in-process snapshot is diagnostic state only and is not exposed as a browser API. This avoids publishing operational volumes or creating a second platform-operator authorization surface. The deployment telemetry collector consumes stdout metric samples instead.

## Health semantics

### Liveness

`GET /api/v1/health/live` answers whether the process can serve HTTP. It does not inspect dependencies.

### Readiness

`GET /api/v1/health/ready` evaluates only dependencies required for safe request processing, such as configured PostgreSQL connectivity and exact schema readiness. Any required dependency failure or timeout yields HTTP 503 `not_ready`.

### Aggregate operational status

`GET /api/v1/health/status` evaluates required readiness checks and optional degradation checks.

- `ready`: all required and optional checks are healthy;
- `degraded`: required checks are healthy but at least one optional provider/dependency is degraded;
- `not_ready`: at least one required dependency is unavailable or times out.

`degraded` remains HTTP 200 so an optional provider outage does not incorrectly remove a healthy API instance from service. `not_ready` returns HTTP 503.

The endpoint deliberately exposes no dependency names, hosts, connection strings, Tenant context, provider identifiers or failure details. It returns only aggregate status plus validated service version, build ID and environment.

## Support metadata

Pilot and Production require:

- `SERVICE_VERSION`: bounded release/application version identifier;
- `BUILD_ID`: bounded deployment/build identifier.

Values are restricted to 1-64 characters using alphanumeric, dot, underscore and hyphen characters. Development/Test use `0.1.0` and `local` defaults unless overridden.

These identifiers are support metadata only; they must never contain secrets, branch credentials, Tenant/customer names or personally identifying values.

## Provider degradation

External provider health is optional unless a specific deployment explicitly makes that provider mandatory for all safe API traffic. Provider degradation therefore must not automatically fail core API readiness.

Booking/integration code records fixed operation/outcome/retryability signals. Raw provider error messages, response bodies and provider references are not metric labels or operational log metadata.

Calendar cancellation reconciliation records a `cancel`/`failure` booking observation when the persisted-reference lookup or provider factory fails before a provider call can be observed. The correlated failure audit uses only the fixed `reference_lookup_unavailable` or `cancellation_factory_unavailable` reason code. Provider-call failures remain owned by the booking adapter so the orchestration layer does not double count them.

## Initial Pilot SLO candidates

These are initial operational targets for the Pilot, not contractual SLAs and not evidence that the values have already been achieved.

- API availability candidate: at least 99.5% successful server availability over a rolling 30-day Pilot window, excluding client-generated 4xx responses from the availability denominator.
- Core API latency candidate: p95 below 1 second over 10-minute windows for non-provider routes under expected Pilot load.
- Calendar integration latency candidate: p95 below 5 seconds over 10-minute windows, evaluated separately from core API latency.
- Readiness recovery candidate: required-dependency `not_ready` state should clear within 5 minutes after the underlying dependency is restored.

Before GA, targets must be recalibrated from measured Pilot traffic and agreed operational/service commitments.

## Initial alert candidates

Recommended Pilot alerts:

- core API 5xx ratio above 2% for 5 minutes with at least 20 requests;
- core API p95 latency above 1 second for 10 minutes;
- two consecutive `not_ready` health evaluations;
- `degraded` state sustained for 5 minutes;
- integration failure ratio above 10% for 10 minutes with at least 10 provider calls;
- sustained authentication-failure or authorization-denial rates materially above the established Pilot baseline;
- missing expected `server_started`/metric telemetry from an otherwise registered instance.

Authentication/authorization anomaly thresholds must be baseline-driven rather than using Tenant/User labels, preserving both privacy and bounded cardinality.

## Multi-instance limitation and aggregation

Counters in one Node.js process are not themselves a cluster-wide source of truth. Production aggregation relies on the deployment telemetry collector consuming structured stdout events from every instance. Alerting and SLO calculations must therefore operate in the centralized telemetry platform, not by reading one process snapshot.

## Verification

#55 requires tests for:

- log redaction and fixed route keys;
- metrics cardinality/label rejection;
- request/auth/authz signal generation;
- booking/integration signal generation;
- required-dependency readiness failure;
- optional dependency degradation without readiness failure;
- timeout handling;
- safe aggregate health output;
- Pilot/Production build-metadata validation.

`npm run check:observability` additionally prevents reintroducing dynamic/sensitive dimensions or dynamic request-path logging.
