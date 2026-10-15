# Private Operations provider usage

The optional Operations-only `GET /api/v1/platform/demo/provider-usage` exposes a
minimized owner snapshot. It is separate from synthetic Tenant metering and from
Production operator identity. Customer and Production entrypoints do not load it.

`DEMO_PROVIDER_USAGE_SNAPSHOT` is absent by default. When present it requires the
validated password access mode and a closed, bounded JSON schema. Never commit
actual account usage, identifiers, credentials or recipient details. Its exact
shape is `{schemaVersion: 1, plan: "launch_v3", referenceObservedAt: <UTC ISO>,
finops: <evaluateFinopsReport input>}`. Only one `database_transfer` measurement,
bytes, the dated published 500,000,000,000-byte Launch model and no cost tariffs
are currently supported. Unknown configuration, fields and models fail closed.

The existing FinOps engine remains the sole forecast/threshold/anomaly policy.
The published reference is neither an account spending cap nor proof that the
project consumption window matches invoice accounting. Costs remain unknown.
Render monthly totals and GitHub billing usage remain explicitly unknown.
The UI labels collection as a stored operator snapshot, displays its observation
time/window/reference date, and marks it stale after 24 hours or window expiry.
Reloading does not call provider APIs. No automated collector or email transport
is configured by this feature; delivery is explicitly `not_configured`.

Authorization is an explicit owner-scope read under the temporary shared password:
the gate holds authenticated request objects in a private WeakSet, strips the
Authorization header, and exposes only `hasPrivateReadAccess(request)`. Public
mode, health bypasses, arbitrary objects, browser headers and simulated Demo roles
cannot grant this capability. This shared-owner policy does not grant business
Principal/session/role authority and is not suitable for multi-user Production.
Both access and traffic gates run before provider handling. Disabled or unauthorized
provider handling conceals the snapshot with 404; unauthenticated perimeter traffic
receives 401. GET only, no query/body, safe errors, no-store and the existing
security headers apply. No account selectors, outbound calls, writes, SQL or
quotas are introduced. The snapshot never enters static frontend artifacts.

Tests cover policy reuse, malformed/private startup configuration, source unknowns,
staleness, positive password reads, forged/public/health authority, query/body and
method rejection, gate ordering, and absence of database access. Architecture
guards preserve the entrypoint/composition/transport/capability boundaries.

Published model source (checked 2026-10-14):
https://neon.com/blog/more-data-transfer-on-paid-plans

## Optional daily connector feed

[Daily private Operations metrics](DAILY-LIVE-METRICS.md) defines the default-OFF
private-object feed. When enabled, it supplies both views without daily redeploys.
The legacy environment snapshots above remain rollout fallback; their original
contracts and limitations still apply. Daily Demo stock is not Pilot outcomes.
