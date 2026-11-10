# CO-85 — Observe the verified 10 November INT release

The fixed recurring-observer selection and frontend validator/checkout now target
API source `15b4f45ccd834548344e3859ef39996a2f885ece` and frontend
`28a864ea6b1d4f5ae0e0066a072f6012e059358d`. Configuration Main
`2ec37ddaa0223e12636f2815ff5883a118ef7543` and the future qualified observer Main
are separate source identities; neither is substituted for the deployed runtime.

## Deployment prerequisite

API PR409's exact two-service Blueprint update reached Live at 18:48 UTC on
10 November. Selection deployment references and completion times come from the
actual provider receipts. ISO timestamps use the existing millisecond precision
contract; the provider returned finer fractional precision. Manifest digests were
reproduced by two independent builds of the exact runtime/frontend pair.

Independent public HTTP checks from 18:49 to 18:59 UTC matched all 315 Customer
files (2,334,767 bytes) and 197 Platform files (1,524,705 bytes) against those
sealed builds: direct HTTP 200, exact bytes, measured length, SHA-256 and content
type. Both origins reported the selected deployment identities and ready status.
Chunked transfer without Content-Length was valid framing, not a file-length
exception. Source qualification, build inputs, rollback and configuration are in
[the configuration record](https://github.com/floriankreutzer/conference-manager-api/blob/2ec37ddaa0223e12636f2815ff5883a118ef7543/docs/QA-20261110-SAAS1-CONFIGURATION.md).

This selection is expected deployment metadata. It does not fabricate an
observation timestamp, database write, rollback execution or Product Acceptance.
Previous dated evidence in `PROTECTED-RUNTIME-OBSERVATION.md` remains historical.

## Controlled activation and acceptance

1. Require the observer candidate's normal review and all native checks, then
   separate merged Main CI, source inventory/attestation and secret checks.
2. Verify current Main and selection again; set the existing qualified-SHA
   variable only to that independently qualified observer Main.
3. Retain `CM_INT_OBSERVER_SCHEDULE_ENABLED=false`. Do not change private
   execution permissions, provider plans, credentials, database migrations,
   operational hours, evidence age limits or collection bounds.
4. Execute one normal owner dispatch on that Main. The existing collector must
   validate current database migration/custody, source identities, both manifests,
   all external bytes and health before its transactional write.
5. Retain the native receipt and independently read the resulting Runtime
   projection. Only actual success establishes new persisted observations.

The regression test first rejected the old runtime selection; a new negative
case proves the previous frontend is refused by the new fixed validator. Existing
foreign-source, malformed input, origin, credential, event, clock, age and workflow
boundary tests remain active. Native execution and readback outcomes belong in
CO-85; source updates alone do not close operational acceptance.
