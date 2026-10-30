# Protected Platform insights

The active owned protected Platform root exposes two bodyless, same-origin GETs:

- `/api/v1/platform/insights/providers`
- `/api/v1/platform/insights/product-delivery`

Both require a current application-passkey Platform principal, `platform:runtime:read`
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

This initial protected port does not activate the Demo's daily object feed,
runtime Product extraction or Operations/Feedback source writers. Those sources
must receive separate protected custody, environment qualification and operational
acceptance before being attached. A visible menu and unknown report do not certify
live provider billing, runtime collection or delivery/feedback measurements.

## QA-09 source activation draft — 30 October 2026

The OPS review found zero available Product metrics and five unknown metering
values for each inspected INT customer. This is a confirmed collection gap, not
proof that the underlying values are zero or that arithmetic is incorrect.
The protected process intentionally does not attach the separate Demo extractors.
Frontend #428 retains this finding; actual Pilot source completeness and feedback
remain in frontend #316. The owner previously confirmed there were no real Pilot
users or business observations. Do not represent development, CI or synthetic INT
activity as real Pilot outcomes, or require those future observations before the
already established Pilot-start sequence.

The source implementation/activation work is **not complete**. The optional
operator diagnostic below makes that gap reviewable; it does not fill the reports,
grant access, certify a Pilot or introduce a new deployment/owner-approval gate.

### Inspect the existing private aggregate inputs

Run `node scripts/check-protected-insight-readiness.mjs` in the authorized operator
environment that already holds the two existing snapshot variables. Do not paste
those values into a shell argument, issue, PR, CI log or browser. The command uses
the existing closed validators and prints only availability, metric IDs/reasons,
freshness and collection blockers, never metric values, account or Tenant data.
It performs no network, database, write, credential discovery or provider action.
Exit 2 means collection remains incomplete; exit 1 means invalid input; exit 0 is
reserved for complete coverage. The current limited source contract cannot produce
complete overall coverage. Do not remove missing-source blockers to turn it green.

### Work required for the remaining sources

| Source | Existing owned implementation | Concrete remaining acceptance |
| --- | --- | --- |
| Product outcomes | `scripts/support/workflow-extractor.mjs`, authorized Tenant/Platform services, compiler and private snapshot reader | Bind an actual current authenticated principal, source instance, durable epoch read before/after and existing conditional private writer. Preserve bounded windows and partial coverage. No browser Tenant selector, constant epoch or Demo import into the protected process. Missing start/abandonment clocks remain unknown. |
| Delivery | Existing source classification and Product compiler | Supply actual sealed release/deployment and recovery receipts for each component and period. Keep unresolved recovery and missing classification explicit; CI success is not deployment evidence. |
| Feedback | Protected operator registry and minimized compiler projection | Operate the existing private registry during the authorized Pilot; retain raw feedback there. An empty or new registry does not establish historical completeness. |
| Metering | `createPlatformMeteringService`, event-source authority, ledger and explicit reconciliation | Wire committed authoritative producers and reconcile under the existing recovery/target/audit authority. Verify all five dimensions, period boundaries, duplicate delivery, partial sources and rollback. The protected Platform role currently reads only metering projections; do not add raw User/Room/event privileges merely to populate a dashboard. |
| Provider usage | Strict private Neon aggregate snapshot and reference-model projection | Attach separately qualified account sources for Render, GitHub and Resend with minimized credentials and current periods. A published tariff, fresh Neon snapshot or process telemetry cannot stand in for another provider's actual usage/invoice. |

For each activation, retain the real source/deployment identity, capture time,
coverage window, freshness limit and explicit collection result. Verify unknown
versus zero, stale versus current, and per-source failure independently. Publish
only the bounded minimized aggregate through the existing protected read contract.
No runtime grant, provider credential, scheduler or source-completeness flag is
changed by this draft. QA-09 remains open until source wiring and actual readback
are accepted; this diagnostic must not be cited as that acceptance.
