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
