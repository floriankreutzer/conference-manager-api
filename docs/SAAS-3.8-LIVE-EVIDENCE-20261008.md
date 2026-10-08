# SaaS 3.8 live observations — 8 October 2026

These observations extend the implementation checkpoint. They do not attest private-media cutover,
an invoice, production business capacity or completion of the milestone. No runtime configuration,
plan, quota, compute endpoint, deployment or object backfill was changed for these observations.

## Private provider probe

The existing isolated Frankfurt storage branch `saas38-private-object-acceptance-20261007` has no
database compute. Its inherited `conference-manager-media` bucket is private. A provider-presigned
PUT returned 200 for a 57-byte synthetic text object. Presigned GET returned 200 and identical bytes;
unsigned GET of the existing object returned 403. SHA-256:
`ba128237e1a85e020c63f61e037d9fa9cbc26cb266993e9b945efe4ccc33c926`.
Only this probe was deleted; an independent listing of its prefix returned no objects. This is not
proof of physical purge, application image authorization, credential scope or paired restore.

Two temporary branch-scoped SDK credentials (read/write and read-only) were explicitly revoked.
Inventory independently confirmed their revocation at 16:00:54Z and 16:01:13Z respectively. Their
secret values and signed URLs are excluded from evidence and repository files. Provider-created
default credentials were not retrieved or modified.

The accepted adapter was exercised with `token_id` as access key ID and the issued S3 secret as
secret access key. Default transport failed DNS with EAI_AGAIN, exposed as the adapter's stable
unavailable code. Diagnostic Node proxy transport also timed out; anonymous proxy prewarming
aborted. These failures establish an execution-environment limitation, not successful runtime
provider authentication. The application's one-second connection/five-second operation bounds were
not weakened. Successful Python proxy access does not attest the production Node transport.

## Both-surface response accounting

Collection covers 14:44:00Z–15:31:00Z and the exact deployed API
`c9f1e45565c268768c1b814b610bf5cab6b8650a`. It includes Hosted acceptance, security scanning and
other concurrent traffic, so it is not an isolated business workload. All 44 log pages were read
to `hasMore=false`: 21,940 unique payload events, zero duplicates and zero invalid samples.
Dimensions contain only the existing fixed route names. Raw logs and instance identifiers are not
published. Counts refer to emitted framed-body metric samples, not unique end-user requests.

| Surface / fixed contributor | Samples | Framed response body bytes |
| --- | ---: | ---: |
| Customer, all routes | 20,890 | 84,081,048 |
| Platform, all routes | 1,050 | 2,662,891 |
| Customer `demo_customer_media` | 493 | 38,802,512 |
| Customer `tenant_room_media` | 136 | 9,341,954 |
| Customer `application_requests` | 655 | 14,850,564 |
| Customer `demo_customer_static` | 12,951 | 10,741,717 |
| Customer `application_catalog` | 2,733 | 5,752,592 |

Body bytes are handed to Node transport. They exclude transport overhead and are neither billed
egress nor attributable monthly costs. Media accounts for 48,144,466 Customer body bytes in this
mixed window; this justifies prioritizing real private-media acceptance, not a projected savings claim.

Render's same-window metric response contains one bandwidth point at 15:00Z per surface: Customer
56.46391 and Platform 1.0684357, each with literal provider unit `mb`. Their aggregation interval and
invoice alignment were not established; no byte conversion or sum with application bodies is made.
HTTP request-count and latency series are empty, so coverage is unknown. Observed memory snapshots
range from 85,319,680 to 244,125,700 bytes for Customer and 63,115,264 to 88,023,040 for Platform.
These sampled extrema are not capacity, leak, peak, p95 or SLO evidence. No live collector or alert
delivery is claimed. The existing session-only PostgreSQL benchmark remains separately scoped.

## Remaining execution plan and decision boundary

1. Reuse the existing isolated Frankfurt branch and private bucket. Do not test migration, corruption
   or restore against production. Provision the smallest isolated PostgreSQL compute only after a
   new owner compute-budget decision; use explicit suspension and cleanup, not an assumed hard cap.
2. Run the exact accepted Node adapter in a network-enabled, permitted execution environment. Verify
   real put/get/remove, read-only write denial, revoked-key denial and branch isolation. Preserve
   deadlines, bounded concurrency, private bucket and credential exclusions.
3. Initialize exact schema 44/overlay 9 using separate protected maintenance/reset identities; seed
   the unchanged canonical three-customer checksum. Keep all production settings untouched.
4. Execute bounded room and catalogue copy batches, re-run for idempotency, and keep PostgreSQL
   bytes. Verify attachment/history, digest/length, missing/corrupt objects, unauthorized cross-Tenant
   requests and rollback without fallback. Retain durable object custody and the 30-day orphan rule.
5. Exercise an actual isolated coordinated database/object restore; verify exact revisions and both
   complete three-customer/two-reset Chromium/WebKit journeys. Bind a real retained evidence digest.
   Do not execute production purge or activate private runtime media before these gates pass.
6. Revoke temporary keys, suspend/remove only newly authorized test compute, and independently
   verify cleanup. Keep historical failures and unknown coverage visible.

Suggested decision: authorize a separate small test budget for temporary isolated compute and any
required execution capacity. A proposed EUR 5 budget is an operator stop threshold, not a provider
hard cap or guaranteed invoice maximum. Current pricing, currency conversion, available included
capacity and visibility of accrued charges must be checked before starting; stop if the authorized
budget cannot be controlled. No plan upgrade, production topology migration or additional spending
limit is part of that proposal. Full cost ingestion, alert delivery and representative cold/warm
business load remain separate open work packages.
