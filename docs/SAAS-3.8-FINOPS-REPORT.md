# Offline FinOps evidence

## Boundary

`finops-report.js` extends the existing billing-window budget owner with new-threshold signals,
candidate rate anomalies, independent metered cost components and a script-free aggregate HTML
dashboard. No runtime route, credentials, paid collector, quota change or message delivery is added.
The CLI accepts only a regular file up to 64 KiB and emits fixed safe errors for invalid input.

```bash
node scripts/finops-report.mjs /path/to/validated-finops.json
node scripts/finops-report.mjs /path/to/validated-finops.json --html
```

The exact schema has `schemaVersion: 1`, `current`, `history` and `rates`. Current and each of at most
32 historical observations use the existing transfer-budget schema. Window, sources, units and
limits must match; timestamps increase by at least 60 seconds and cumulative counters cannot fall.
Reset/missing counters and changed quotas must start a new reviewed evidence series. Unknown sources
are omitted, never reported as zero. Rate entries contain exactly source, currency (USD/EUR),
nonnegative integer priceMicrosPerUnit, positive unitSize, nonnegative included amount, canonical
rateObservedAt no later than the observation, and fixed provenance. Provenance is neon_published,
render_published, github_published or operator_contract. The input has no arbitrary URL or account,
Tenant, User, Request, email or credential dimension.

New budget signals compare the current crossed 50/70/85/95 percent levels with the latest previous
observation; repeated unchanged thresholds do not repeat a new-crossing signal. After seven prior
comparable intervals, a candidate anomaly is a current interval rate above three times the median,
with a minimum material rate of one million bytes/day or 60 CI seconds/day. Before that, the state is
`insufficient_baseline`, not healthy. This initial policy is explicit and testable; calibrate against
representative collected traffic before treating it as an operational SLO.

Metered components use exact integer-microcurrency arithmetic and the supplied allowance/rate.
They exclude fixed fees, compute, storage, taxes, currency conversion and tiered pricing. The linear
window forecast remains an estimate. No total adds overlapping provider boundaries or currencies.
For a shared project allowance, aggregate its covered products once using the provider's billing
boundary; do not give each product a separate copy of the shared allowance. Missing rates remain
unknown. Report generation is not delivery: wire a reviewed collector to the existing approved
operator alert channel before claiming live alerts. Do not send account evidence publicly.

## October 7 project checkpoint

The retained non-secret input `evidence/saas38-neon-transfer-checkpoint-20261007.json` was created
from an independently read Neon project record: Launch v3, PostgreSQL18, Frankfurt, provider
consumption window starting October 3 and ending November 1. Its observation timestamp records
collection; it is not an invoice finalization timestamp. The older October 7 approximately 17:23
checkpoint reported 7,381,127,204 bytes. Two point observations are not an anomaly baseline, and the
older rounded observation time is not inserted as an exact machine timestamp.

The current [Neon plans](https://neon.com/docs/introduction/plans) documentation lists 500 GB public
network transfer per Launch project/month, shared across Postgres, Object Storage and Functions,
then USD 0.10/GB. Its [June 1 update](https://neon.com/blog/more-data-transfer-on-paid-plans)
explicitly replaced the old 100 GB paid allowance. The example uses decimal billion-byte GB as an
explicit conversion assumption. Its 500 GB budget is a dated published-plan model, not an observed
configured hard cap or spending-limit change. The project record's `data_transfer_bytes` is retained
as provider-defined project transfer, not relabeled invoice-aligned `public_network_transfer_bytes`.
Invoice-aligned v2 ingestion, complete product attribution, billing units and actual configured limits
remain to be independently verified before invoice or zero-overage guarantees.

[Render bandwidth](https://render.com/docs/outbound-bandwidth) is workspace-scoped. Current published
Hobby allowance is 5 GB, while legacy plans can differ; do not silently reuse the historical 100 GB
figure or assume the existing workspace has migrated. Workspace-specific reads require its confirmed
identity. No actual Render usage/quota or complete monthly application-egress cost is claimed here.

## Acceptance and operating runbook

1. Ingest complete provider totals and approved stdout aggregation for both surfaces, with dated
   window/unit/plan provenance; retain unknown coverage instead of inventing zero usage.
2. Verify rate units, shared allowance scope and plan generation before preparing validated input.
3. Run JSON and HTML outputs. Restrict operational evidence to approved operators.
4. Exercise 50/70/85/95 transitions, repeated-signal suppression, incomplete baseline, anomaly,
   missing source/rate, counter reset and collector/delivery failure in the chosen alert system.
5. Investigate actual rate contributors before reducing avoidable Demo/CI traffic. Never disable
   required tests, raise spend/quota, change provider topology or claim recovery automatically.

Native tests verify these evaluator boundaries and safe HTML/CLI output. A generated offline dashboard
does not prove a deployed collector/dashboard, alert delivery, production benchmark or invoice.
Those operational acceptance items remain open in #263 and the SaaS 3.8 release gate.
