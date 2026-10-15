# Daily private Operations metrics

This extension supplies daily connector observations to **Provider & Usage** and
**Product & Delivery**. It is a Demo Operations feed, not Production analytics or
billing reconciliation. The existing FinOps and Product/DORA compilers remain the
only owners of their calculations. A code merge does not prove collection or rollout.

## Data flow and security

An authorized connector task reads the already approved provider resources, computes
only the fixed aggregates below, validates its report, and uploads one JSON object to
the existing private Neon bucket `conference-manager-media`, fixed key
`operations/metrics/daily-v1.json`. It must not list/read/write Tenant media, upload raw
source responses, create resources, alter quotas or change provider credentials.
Use a short-lived presigned upload for this exact key; never publish its URL or body.
The daily upload does not redeploy Render. Initial activation is a separate deployment.

`DEMO_LIVE_METRICS_ENABLED=true` is the optional, default-OFF server boundary. It
requires owner-password mode and a separate branch-bound read-only storage credential.
Use `DEMO_LIVE_METRICS_BRANCH_ID`, `DEMO_LIVE_METRICS_ACCESS_KEY_ID` and
`DEMO_LIVE_METRICS_SECRET_ACCESS_KEY`; the existing strict Neon/database/TLS/role
validator is reused on an isolated map. These settings never change
`DEMO_MEDIA_STORAGE` or the PostgreSQL media custody. Never reuse a write credential. Configuration rejects aliases against every
configured Customer/reset media credential value, even when media itself uses Neon.
Only the Demo Operations entrypoint imports the concrete read-only S3 adapter.
Customer and Production entrypoints cannot load it. Existing media custody, reset,
Tenant, session, CSRF and audit contracts are unchanged. The new prefix is outside
canonical Tenant media keys and must remain outside media reset/purge inventories.

`GET /api/v1/platform/demo/live-metrics` runs the existing request-bound owner and
traffic gates before storage. No selectors, query, body or mutation methods are
accepted. Disabled/unauthorized handling is concealed (404); perimeter authentication
still returns 401. Errors return a minimized 503. The route never queries SQL or
provider APIs and applies existing private no-store/security headers.

The S3 read permits exactly the named bucket/key, no redirects or retries, one
socket/read, a five-second total deadline, JSON MIME and at most 48,000 bytes with
strict UTF-8/length verification. Reports have closed fields/dimensions; resource,
Tenant, actor, recipient and account identities are rejected. The HTTP response is
bounded to 64,000 bytes. Browser modules receive no provider credentials or URLs.

Concurrent reads coalesce. Successful reads cache five minutes; failures retry after
one minute and retain only the last validated report with `last_good`. Neither a
failure nor an HTTP refresh advances its observation clock. Daily freshness expires
at 24 hours; reports expire at 30 days. Future/rollback clocks are rejected. There is
no claim of cryptographic authenticity: private connector custody is the trust boundary.

## Closed source contract

Validate before upload, with protected local files and `umask 077`:

```sh
node scripts/compile-daily-live-metrics.mjs < protected-daily-input.json > protected-daily-report.json
```

The compiler bounds stdin to 48,000 bytes, rejects arguments and future/day-old new
uploads, and prints no rejected input. Input is exactly `schemaVersion: 1`,
`environment: "demo"`, `observedAt`, `measurements`, `providerSnapshot` and
`productSnapshot`. The latter two reuse the existing provider/Product aggregate
contracts; the provider snapshot may be null. Never insert raw Product events here.
The wire adds evaluation/freshness/source state and the two existing wire projections.

Measurements contain all fixed IDs in registry order, each with exactly `id`,
`value`, `observedAt`, `periodStart`, `periodEnd`, `sampleAt`. Missing data has null
value and all null clocks. A known value requires a genuine observation clock within 24 hours of report collection.
Hourly/CI windows must be exactly the completed UTC-hour-aligned 24 hours preceding
the source observation. Retained-today counts start at that observation day’s UTC
midnight and end at the actual observation; a prior-day observation cannot be
labelled today in a newer report. Provider/project windows must contain the source
observation and remain bounded to 32 days; daily Resend resets use the UTC day.
All clocks are exact UTC ISO milliseconds. Counts/bytes are safe nonnegative integers;
MB permits finite nonnegative decimals. No arbitrary labels are supported.

| IDs | Source and meaning | Completeness limits |
| --- | --- | --- |
| neon_transfer | Neon project `data_transfer_bytes`, actual consumption start/end | Project window, not invoice total/cap; reuse dated published Launch model only when the observed plan matches |
| render_customer_bandwidth / render_operations_bandwidth | Latest available `bandwidth_usage` point, provider MB, queried over last completed 24 hours at 3600-second resolution | Do not sum sparse samples into daily/monthly billing totals; omit ambiguous latest points |
| render_customer_memory / render_operations_memory | Latest available `memory_usage` point in bytes | One provider sample, not period peak; discard instance/resource labels |
| resend_daily_sent / resend_daily_limit | Actual email sends/limit from usage endpoint, UTC day/reset boundary | Null unlimited/missing limits; no mail/recipient reads |
| resend_monthly_sent / resend_monthly_limit | Actual email sends/limit and supplied monthly reset | If start is not supplied, retain null start and show reset only; never invent a 30-day window |
| github_ci_total / github_ci_failed | Complete Actions run pagination for the three approved repositories over the last completed UTC-hour-aligned 24 hours; failure conclusion only | Counts include workflow runs, not developers, deployments, invoice minutes or costs; incomplete pagination makes both unknown |
| tenants / requests | Current COUNT(*) from Demo tables | Actual retained state including seed, not Pilot adoption or newly created business outcomes |
| requests_updated / request_revisions / diagnostic_events | Counts since current UTC midnight using updated_at / captured_at / occurred_at | Only retained current state; reset/purge can erase history; no historical completeness or successful business-outcome claim |

For hourly samples, `periodStart/End` identify the **query** window and `sampleAt`
identifies the actual selected point. Reject wrong units, out-of-window/future points
and conflicting ties. `observedAt` is collection time, not the provider sample time.
State counts have no period/sample. Provider reset-only windows retain null start.
Known zero is allowed only from a complete explicit source result; missing is never zero.

The database collector is one read-only SELECT returning only the five counts and a
UTC database observation clock; no record IDs, content or identities leave Neon.
Use the existing Demo database/default branch resolved from approved source configuration.
No SQL executes in the browser or new HTTP route.

## Product and delivery interpretation

Daily Demo stock remains separate from Product Outcomes and structured Pilot Feedback.
Do not set `productComplete` from count queries, diagnostic totals, seed or partial
unverified audit reads. Real audit extraction must preserve complete-chain verification.
Submission starts, abandonment, decision duration, recovery outcomes and feedback stay
unknown until their trusted, complete source exists.

The Customer Demo Render deployment history is the API series only: paginate through
all 28 complete UTC days; include actual live/superseded deployments, exclude failed
build/update attempts, and deduplicate by immutable deployment ID. Mark API complete
only after covering the lower boundary. Application/website remain incomplete unless
independently collected for their own target. Do not count the Operations service as a
second API target. Keep outcome/rework unknown, changes empty and failure/recovery null
unless independently verified. Deployment frequency can then be known while the other
DORA measures remain unknown. Provider Live does not establish healthy business readiness.

The connector task must preserve the existing private warning ledger, pending delivery
and idempotency rules. A portal update does not itself send mail or close release gates.
If collection/upload fails, retain the old object and report the limitation; never replace
it with fabricated zeros or refresh old source clocks. Public evidence uses synthetic
fixtures only. Initial manual upload, scheduled-task configuration and an actually
executed scheduled collection are three separate evidence claims.

## Browser compatibility and acceptance

Both adapters prefer this fixed bounded GET. An unavailable endpoint permits the old
saved-snapshot endpoint during rollout; the UI explicitly labels that unavailable live
feed. A malformed successful live response fails closed instead of silently downgrading.
The browser validates/renders only, reuses existing locale/date/number utilities and
semantic definition lists, and introduces no persistence or provider transport.
Existing independent snapshot clocks/retention policies continue to apply.

The paired immutable-API CI compares a real reader-generated synthetic wire fixture,
fixed measurement contracts and frontend normalization. Native tests cover security,
coalescing, stale/last-good/expiry, clocks, MIME/size/encoding, malformed source and CLI
bounds. Chromium/WebKit tests exercise real UI rendering, unknown outcomes, keyboard,
locales and reflow, alongside unchanged permanent three-customer/two-reset acceptance.

The served frontend and permanent acceptance contract retain independent immutable
lockfiles. API CI installs each checkout's own browser engines before executing it;
a tooling update must not leave the permanent progression/reset case unable to launch.
Neither the accepted contract pin nor any scenario assertion is changed for this.
