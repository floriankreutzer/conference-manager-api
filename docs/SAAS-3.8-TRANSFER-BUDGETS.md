# SaaS 3.8 transfer measurement and budget foundation

Tracking: frontend roadmap #262 and work package #263. Root `AGENTS.md` and
`docs/CODING-STANDARDS.md` remain mandatory. This package implements response-size
instrumentation and an offline budget evaluator; it does not complete the entire milestone.

## Measurement responsibilities

| Evidence | Source | Meaning and limits |
| --- | --- | --- |
| Framed API/static body bytes by fixed route | structured application `metric_sample` events | bodies handed to Node transport; not billed egress |
| Database transfer total | actual database provider's billing-window usage | provider-defined transfer; do not infer from HTTP bytes |
| Application egress total | actual hosting provider's billing-window usage | provider-defined egress including its metered paths |
| Object-storage egress total | chosen storage provider, after separate selection | unavailable until a provider exists |
| CI runtime | actual CI usage export in seconds | runner-minute billing factors are outside this evaluator |

Collect all instances and both surfaces centrally using the existing operator telemetry collector.
Metric dimensions must stay bounded and exclude personal data, Tenant/User/Request IDs and secrets.
Do not add the three byte sources: their metering boundaries can overlap. Do not derive actual EUR
cost from bytes without dated provider rates, units, region, included allowances and billing rules.
No new collector subscription or paid usage is authorized by this package.

## Reproducible offline report

Run `node scripts/transfer-budget.mjs /path/to/validated-usage.json`.
The script reads a regular file of at most 16 KiB, validates an exact versioned schema and emits
only the accepted aggregate fields. Invalid inputs fail nonzero with one fixed safe error code.
It performs no network calls, database queries, notifications, account changes or traffic blocking.
Keep operational exports outside source control if they contain account details or real quotas.

An input contains `schemaVersion: 1`, UTC ISO timestamps `periodStart`, `periodEnd`, `observedAt`
and one to four `measurements`. The billing window must be positive and at most 32 days;
observation is after its start and no later than its end. Each measurement contains exactly
`source`, `unit`, `used` and `limit`. Sources and units are:

- `database_transfer`, `application_egress`, `object_storage_egress`: `bytes`;
- `ci_runtime`: `seconds`.

Amounts are non-negative safe integers; a positive configured limit is mandatory. Duplicate sources,
unknown fields/dimensions, wrong units, impossible dates and unsafe forecast arithmetic fail closed.
Use the actual provider billing period, not an assumed calendar month. Omit unknown sources; never
replace missing usage with zero. A numeric limit is an operator input, not a quota fetched or changed
by the script. A zero-additional-spend policy is distinct from the provider's positive included quota.

For each source, the report returns actual utilization and every crossed 50/70/85/95 percent threshold,
actual exhaustion, and a separately labeled linear end-of-window projection. The projection assumes
uniform consumption and is not a capacity promise, workload benchmark or anomaly detector. Near the
start of a window it may be unstable; compare successive actual snapshots before taking action.

## Runbook

1. Record the actual provider billing window, collection timestamp, units, aggregate usage and included
   quota. Keep provider-identifying/credential-bearing export fields outside evaluator input.
2. Run the offline report and retain the accepted totals with provenance in restricted operational evidence.
3. At 50/70 percent, inspect the largest fixed-route payload and background-work contributors.
4. At 85/95 percent or projected exhaustion, prioritize avoidable Demo/CI consumption and assign an
   operator decision before the actual quota is exhausted. Never silently disable safety checks,
   customer access or integrity gates, and never raise spending limits automatically.
5. If samples are missing, partial or the collector is unavailable, report unknown coverage; neither
   an empty process snapshot nor a successful health probe proves that monthly usage is zero.

This implementation emits report signals only. Automated alert delivery, a deployed dashboard,
anomaly baselines, provider ingestion and actual monthly cost attribution remain unverified.
Notify/alert wiring requires the existing approved operator system; no external messages are sent here.

## Remaining milestone work and decisions

- #263: collect actual provider totals and baseline; establish operator alert/dashboard and anomaly
  evidence without additional spend. The offline report and payload instrumentation are only foundations.
- #264: select a durable object-storage provider/account, region and private delivery contract;
  implement migration/backfill/recovery before removing PostgreSQL media bytes. Current private media
  authority/retention from ADR-012 remains mandatory until a reviewed migration supersedes it.
- #265: use measured route contributors to prioritize conditional reads, compression and pagination;
  preserve authorization before 304/cache reuse and current mutation invalidation.
- #266: compare polling costs with transactional event/outbox processing, including retries and recovery.
- #267: preserve fail-closed dependency/schema/identity gates while reducing recurring work; never
  describe startup-only integrity checking as equivalent to continuous mutation-authority checking.
- #268: current CI already provisions isolated PostgreSQL and runs the permanent three-customer/browser
  contract. Audit remaining public Hosted acceptance calls rather than creating a duplicate test database.
- #269: define reproducible 100/1,000/10,000 active-user workload assumptions and retained measurements;
  forecasts from this evaluator are not evidence that those loads have been tested.
- #270: remain open until the chosen implementations and actual runtime/provider evidence pass.

No provider migration, additional spend, plan/quota change or security/test-gate exception is implicit.
All three canonical Demo customers, both reset cycles and immutable cross-repository bindings remain
required before promotion of relevant runtime changes.

## Verification

`tests/response-payload.test.js`, `tests/observability.test.js`,
`tests/platform-http-security.test.js` and `tests/transfer-budget.test.js` cover transport completion,
UTF-8 byte equality, fixed dimensions, bodyless responses, aborts, sink isolation, budget thresholds,
independent units/windows, malformed/secret-bearing inputs and overflow. Run the repository's full
`npm run check`, `npm run audit`, PostgreSQL and immutable paired browser/CI gates after final changes.
Record actually executed results separately from pending operational/provider acceptance.
