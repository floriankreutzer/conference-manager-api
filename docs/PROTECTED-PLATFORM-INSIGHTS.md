# Protected Platform insights

The active owned protected Platform root exposes two bodyless, same-origin GETs:

- `/api/v1/platform/insights/providers`
- `/api/v1/platform/insights/product-delivery`

Both require a current application-passkey or Microsoft MFA Platform principal, `platform:runtime:read`
and global target scope. Provider subscription aggregates additionally require the
Platform Security Admin role. A Customer identity, an allowlisted operator, a stale
session, another authentication context or missing permission cannot read a source.
Setup mode registers neither endpoint. Existing HTTP host/origin/rate/header/body
bounds, minimized errors and the protected execution lease remain authoritative.
These reads do not grant a role or issue an operation proof.

Optional private `PROTECTED_PLATFORM_PROVIDER_USAGE_SNAPSHOT` and
`PROTECTED_PLATFORM_PRODUCT_DELIVERY_SNAPSHOT` contain compiled aggregate JSON,
at most 24000 UTF-8 bytes each. They contain no provider credential, account
identifier, Tenant content or browser-selected source. Unknown fields and malformed
or inconsistent observations fail startup. Provider reports reuse the existing
shared FinOps projection and distinguish the published reference model from an
account limit or invoice. Product accepts only the production operator-extract
schema and expires retained observations after 30 days. Missing Product collection
returns explicit unknown metrics, never invented zero events; missing Provider
collection returns a protected 503 source-unavailable response.

The protected wire identity is `application_passkey`; the separate closed Demo
retains `shared_owner_password`, its own perimeter and its existing routes. Shared
report presentation and FinOps calculations are reused without importing a Demo
runtime into the protected process. No migration, new dependency, outbound request,
credential collection or scheduled provider polling is introduced.

Product runtime collection is attached through the separately qualified offline
collector below. The protected process does not import the Demo runtime, its reset
custody, object feed or Operations source writers. Source completeness is an
operational acceptance criterion, not inferred from a visible menu or CI result.

## Source readiness and remaining acceptance (QA-09)

`node scripts/check-protected-insight-readiness.mjs` validates the configured private
aggregates without network access or database writes. Its output includes source
availability, freshness and missing metric IDs/reasons; no metric values or account,
Tenant or credential identifiers are printed. Exit 2 means incomplete collection;
exit 1 means malformed input. For a runtime Product snapshot, supply the same
`PROTECTED_OBSERVATION_SECURITY_EPOCH` used to collect it. The diagnostic cannot
certify source groups that have not been attached.

| Source | Implemented path | Remaining acceptance |
| --- | --- | --- |
| Product | Offline bounded audit/revision collector, epoch-bound private snapshot and protected v2 bundle | Execute a qualified collection, install the aggregate and verify the matching frontend readback. Partial retained history remains partial. |
| Delivery | Existing strict operator-extract compiler and private stored report | Actual sealed deployment, change classification and recovery receipts for each agreed component/period. CI success is not deployment evidence. |
| Feedback | Existing protected registry projection and private stored report | Operate the registry for the agreed window; empty/new input does not establish historical completeness. |
| Metering | Authoritative gauges, event ledger and audited period reconciliation | Wire and qualify committed event producers and reconcile authorized periods. Missing counters now remain null even when SQL COUNT returns zero. No raw Tenant privilege was added to Platform. |
| Provider usage | Existing private Neon snapshot and reference-model projection | Qualified Render, GitHub and Resend account observations. A tariff or Neon report cannot establish another vendor's actual usage or invoice. |

Frontend #428 retains QA-09 and QA-10 until their agreed acceptance is demonstrated.
Frontend #316 retains actual Pilot outcome/feedback acceptance. Development, CI and
synthetic INT activity are never substituted for real Pilot outcomes. A missing
business observation does not create a new Pilot-start gate.

## Verified protected Product collection (QA-09 implementation)

`node scripts/collect-protected-product.mjs` now reads actual retained Product
sources through the existing separately authenticated offline database owner.
It accepts no command-line arguments, URLs, Tenant selectors or browser authority.
The existing `PLATFORM_PASSKEY_OFFLINE_DATABASE_URL`, `PLATFORM_PASSKEY_OFFLINE_ROLE`
and `PLATFORM_DATABASE_URL` binding must identify the same database and distinct
owner/runtime roles. Supply the existing `PROTECTED_OBSERVATION_SECURITY_EPOCH`,
`PROTECTED_TENANT_AUDIT_HMAC_SECRET`, `PROTECTED_PLATFORM_AUDIT_HMAC_SECRET`, and the
explicit `PROTECTED_PRODUCT_DATA_PROFILE` (`synthetic` or `real`). This collector
is deliberately qualified only for INT; it does not report INT activity as Pilot
production outcomes.

Set `PROTECTED_PRODUCT_OUTPUT_PATH` to a new file in an absolute, canonical,
operator-owned directory with mode 0700. The command creates a new mode-0600 file
without following symlinks or overwriting any previous observation. It prints only
a fixed success/failure code. Keep that file private; do not attach it or raw audit
records to issues, CI artifacts or logs. No database row, grant, event or audit
history is changed by collection.

The collector acquires the existing INT shared epoch lease on a separate max1
owner pool before beginning its max1 READ ONLY REPEATABLE READ transaction. Both
pools use the same validated offline database binding. The lease remains held
until the snapshot is fully consumed; a reset cannot commit between the first
snapshot and a later lock. No pool size, database resource, grant or timeout is
increased. The eight-second work deadline includes lease acquisition.
Inside that snapshot it verifies the exact canonical migration ledger and offline
table owner. It selects current registered customers of only the
chosen profile, verifies complete retained Tenant chains and the active Platform
segment/genesis/checkpoint chain, then reads only minimized Request revision facts.
Limits are 100 customers, 2,000 retained audit rows, 2,000 revision facts and eight
seconds of database work. Missing/incorrect keys, foreign epoch, corrupt evidence,
capacity limits or reset contention refuse publication. No unverified legacy
Platform prefix is included. Coverage starts no earlier than the current epoch,
segment and selected customer registrations; missing clocks stay explicit.

The resulting aggregate can be installed as the private
`PROTECTED_PLATFORM_PRODUCT_RUNTIME_SNAPSHOT` configuration through the existing
deployment process. Startup validates its exact contract and current epoch digest.
No runtime database privilege is added. The optional bodyless GET
`/api/v1/platform/insights/product-delivery?schemaVersion=2` returns a closed bundle
of the independently clocked stored Delivery/Feedback report and Product snapshot.
Queryless v1 stays unchanged. The frontend must be deployed after this API. Reads
never reset collection time; after 24 hours Product is stale and after 30 days it
is unavailable. Authentication, global scope and runtime-read checks remain intact.

The new collector/source port is executable implementation, not evidence that a
live collection or deployment has occurred. Delivery, Feedback and provider usage
still require their actual separately qualified receipts/registries/account
sources. Metering additionally needs committed event producers and an authorized
period reconciliation. Their absence cannot be declared “not applicable” without
a business decision. The QA issue remains open until all agreed sources satisfy
that acceptance, even when Product collection and contract tests pass.
