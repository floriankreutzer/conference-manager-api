# SaaS 3.8 live observations — 8 October 2026

These observations extend the implementation checkpoint. They do not attest private-media cutover,
an invoice, production business capacity or completion of the milestone. Production runtime, plan,
quota and deployment were unchanged. Temporary isolated compute, a protected operator Function,
backfill and coordinated restore were executed after the owner accepted the separate EUR 5 test
budget on 8 October. That budget is an operator stop threshold, not a provider-enforced hard cap.

## Historical presigned and local-network probes

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
secret access key. The earlier local default transport failed DNS with EAI_AGAIN, exposed as the adapter's stable
unavailable code. Diagnostic Node proxy transport also timed out; anonymous proxy prewarming
aborted. These failures establish an execution-environment limitation, not successful runtime
provider authentication in that environment. The application's one-second connection/five-second
operation bounds were not weakened. These historical failures remain failures; the successful
Frankfurt Function default-transport test below is separate evidence.

## Actual adapter and bounded PostgreSQL backfill

The accepted API source is `c9f1e45565c268768c1b814b610bf5cab6b8650a`.
A temporary operator Function on the existing isolated Frankfurt branch ran its actual
`neon-object-storage`, `object-storage-contract`, PostgreSQL media-object/backfill repositories and
canonical/Demo migrators. The locked S3 SDK is 3.1147.0; the provider runtime reported Node v24.16.0.
The Node 24 runtime is an isolated test environment, not a change to the accepted Node 22 CI baseline.
Default Node SDK transport was used without proxy injection, weaker TLS or relaxed deadlines.

The operator Function required a constant-time SHA-256 check of a separate bearer secret before
accessing any dependency, enforced an expiry, accepted only POST on fixed phase paths with empty
bodies, fixed the branch/endpoint/database/maintenance-role allowlist and bounded concurrent work.
Function deployments 1–8 include historical failed setup attempts, not eight successful test runs.
The migration URL originally contained a pooled hostname and failed scope validation. Correcting
only that isolated URL to its known direct endpoint made the accepted migrators pass. All SQL used
`cm_demo_migration`, database `conference_manager_demo_shared`, verified TLS and bounded pools.
No migration credential was added to Render or to an application runtime.

Source SHA-256: `37a26924a9d19db49e6f8695092c57ada08b124d6d44605f87b029959a39c784`.
Bundled ESM SHA-256: `5330f9631901eaa827b79441544d29dbb5e69021bfcb1381450a1eb25c9a4761`.
The exact non-secret operator source is retained in
[evidence/SAAS-3.8-PROVIDER-PROBE-20261008.txt](evidence/SAAS-3.8-PROVIDER-PROBE-20261008.txt).
It is historical transport/test code, not a supported public application endpoint. Bundle tooling
was the existing esbuild 0.28.2 binary; no application dependency or lockfile changed. The ZIP held
`index.mjs`, canonical `migrations/*.sql` and `demo-migrations/*.sql`. Secrets and signed URLs are
excluded. Re-execution requires newly issued isolated credentials and a new protected deployment;
the recorded endpoints and Function have been deleted.

A 68-byte synthetic PNG passed actual adapter PUT, exact GET, read-only credential write denial,
REMOVE and missing-object detection. Its digest is
`6ee689b99722065a75fafda42552fe2678df723b5de041c6c83165ae727e90b9`.
The adapter translated denied writes to its stable `MEDIA_STORAGE_UNAVAILABLE` code; no specific
HTTP status or provider reason is claimed for that SDK denial.

The original isolated branch and the separate restored root both reached canonical 44 / overlay 9,
independently read back from their actual migration ledgers. The original branch advanced from
42 / 7; the restored root already inherited 44 / 9 from the accepted production database snapshot.
Both independently completed the same bounded copy sequence:

| Kind / batch | Assets | Verified bytes |
| --- | ---: | ---: |
| Room 1 | 10 | 1,982,346 |
| Room 2 | 1 | 188,352 |
| Catalogue 1 | 10 | 134,486 |
| Catalogue 2 | 10 | 2,383,158 |
| Catalogue 3 | 3 | 504,354 |
| Total | 34 | 5,192,696 |

Each batch used the accepted transaction/inventory logic, a maximum of ten assets and existing
bounds. Copy re-runs returned `inspected=0`, `changed=0`, `hasMore=false` for both kinds. All 34
objects were then independently read through the actual adapter and checked against retained
PostgreSQL bytes, metadata, length, digest and immutable keys. Ordered inventory SHA-256:
`bd04b011bdb23c13a6f2d98f4a77840bd47682fa395ba4422230b3da41fdbfbd`.
PostgreSQL blobs were retained; no purge, authority change or runtime cutover occurred.

## Actual paired database/object restore and rollback

Neon rejected a manual snapshot of the child branch with HTTP 400: snapshots require a root branch.
This failure is retained. A read-only production-root snapshot was restored with `finalize=false`
to a separate test root. Production was never replaced or finalized. Restore initially allocated
an endpoint with provider default maximum 8 CU and disabled auto-suspend; it was promptly restricted
to fixed 0.25 CU and 300-second suspension. This transient default is not described as fixed 0.25 CU
for the entire endpoint lifetime. The initial root snapshot full size was 51,748,864 bytes.

| Artifact | Identity | Role |
| --- | --- | --- |
| Production read-only snapshot | `snap-round-dust-b1zwvqyy` | Initial isolated root source |
| Isolated root | `br-sweet-smoke-b1w5vtbq` | Copied and verified 34 objects plus retained blobs |
| Root capability snapshot | `snap-hidden-leaf-b1mh13zu` | Confirms root-only snapshot operation |
| Separate storage backup branch | `br-twilight-tree-b18xtqg3` | Independently listed all 34 inherited objects, no compute |
| Paired database snapshot | `snap-polished-lake-b1efethw` | Database captured after verified copy |
| Unfinalized paired restore | `br-nameless-night-b1g4g3ep` | Restored database plus separately restored provider objects |

All three new snapshots were configured to expire at **2026-10-08T18:30:00Z** and independently
listed with that expiry. The pre-existing September 28 snapshot was not changed. Crucially, both
restored roots initially had **no storage buckets**: a database snapshot alone did not restore
private media. A private destination bucket was explicitly created on each own test root.

The paired restore read image objects from the separate backup branch using a read-only credential,
then wrote/read-verified them on the new restore root in five bounded ten-asset-or-smaller batches.
It selected only database metadata for restoration; no PostgreSQL image bytes were selected or used
as a restore fallback. The five batches matched the counts/bytes above. Final verification compared
all 34 restored objects to the retained original database bytes and reproduced the exact ordered
inventory digest. Independent SQL read-back confirmed 11 Room and 23 Catalogue pointers and blobs.
This proves a coordinated snapshot/object-backup restore primitive, not the complete application
three-customer/reset acceptance, attachment/history authorization or production disaster recovery.

On the own isolated root, deliberately missing and same-length corrupted objects produced
`MEDIA_STORAGE_OBJECT_MISSING` and `MEDIA_STORAGE_INTEGRITY_FAILED` respectively. The accepted
rollback repository refused to clear the missing object's pointer. The original bytes were restored
in `finally`, and full 34-object verification returned the original inventory digest.

On the paired restore root, five actual rollback batches changed 10 + 1 Room and 10 + 10 + 3
Catalogue pointers. Both subsequent rollback runs returned zero changes and `hasMore=false`.
Independent SQL confirmed **zero object pointers and all 34 PostgreSQL blobs retained**. Objects
and durable custody/inventory were not purged. This verifies the repository downgrade path; it does
not attest a browser-visible production rollback or physical object erasure.

## Cleanup, retained data and budget boundary

After successful object operations, the restore writer was revoked; an actual default-SDK PUT
using that same key was denied with `MEDIA_STORAGE_UNAVAILABLE`. An unsigned positive data-plane
PUT is not claimed. Credential inventory independently confirmed all seven newly issued scoped
credentials were revoked:

| Own test credential | Revoked at, UTC |
| --- | --- |
| Function write | 2026-10-08 16:54:42 |
| Function read | 2026-10-08 16:54:49 |
| Root write | 2026-10-08 16:55:06 |
| Root read | 2026-10-08 16:55:13 |
| Restore write | 2026-10-08 16:52:22 |
| Restore read | 2026-10-08 16:55:21 |
| Backup read | 2026-10-08 16:55:28 |

The operator Function `saas38acceptance` was deleted and `list_functions` independently returned
an empty list. All three newly allocated endpoints (`ep-plain-firefly-b1sogv2a`,
`ep-holy-sunset-b1lulgle`, `ep-summer-recipe-b19cx5e5`) were suspended and deleted. Independent
compute lists are empty for all four isolated test/backup branches. The synthetic probe prefix was
also independently empty. Provider-created default credentials were not retrieved, revoked or
changed; deleting an endpoint does not revoke database roles or provider defaults. No secret values
are retained in this evidence.

The original test branch and the three newly created data/backup/restore branches remain, preserving
image custody and reviewable database state. There are now **11 project branches**, with original
`production` still the default. The current published Launch tariff includes ten branches; an extra
branch is $1.50/month prorated hourly. Thus test compute/Function execution is stopped, but retained
branches/storage are **not a zero-cost cleanup claim**. No automatic branch deletion, retention
expiry or provider-enforced EUR cap was configured. Retained evidence needs an explicit lifecycle
and billing review before it can consume the remaining operator test budget. Actual invoice-aligned
incremental cost is not available from these tools; no final EUR invoice or hard spending guarantee
is claimed. Additional paid execution is paused rather than treating the approved budget as unlimited.

## Neon Free-plan announcement and current project

The official October 2 announcement
[Neon Free plan: 1 GB per project](https://neon.com/blog/neon-free-plan-1-gb-per-project)
raises Free PostgreSQL storage from 0.5 GB to 1 GB/project, automatically for existing Free projects.
The announcement retains 100 projects, 100 CU-hours/month/project, ten branches and six hours of
instant restore, plus 5 GB object storage/project and the stated Functions allowances.

Independent project read-back after cleanup still reports **`launch_v3`**, Frankfurt, PostgreSQL 18,
about 52 MB synthetic PostgreSQL storage. This announcement does not automatically change that
subscription or produce Launch savings. Storage alone fitting below 1 GB is insufficient to justify
a downgrade: compute, egress, branch count, restore horizon and the organization's other projects
must be evaluated. Current official [pricing](https://neon.com/pricing) / `pricing.md` documentation
makes the subscription an organization-level decision, not an independent per-project Free toggle.
No downgrade, new organization, project migration, quota or production topology change was made.

After cleanup, the provider project record reports 8,531,204,081 `data_transfer_bytes` over its
2026-10-03T11:49:06Z–2026-11-01T00:00:00Z consumption period. This cumulative mixed-project counter
is not invoice-aligned v2 coverage or isolated test attribution. The documented Free network quota
is 5 GB/project/month; coverage must be reconciled before claiming this workload fits that quota.
Published Launch rates are $0.106/CU-hour (fixed 0.25 CU = $0.0265/active hour), object storage
$0.023/GB-month and Functions $0.10 active / $0.025 waiting Capacity-hour. These are dated modeling
inputs, not an observed invoice. Separate future Free development/CI projects could benefit from
this announcement, subject to an organization/authority/retention decision.

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

## Remaining execution and acceptance gates

1. Run the unchanged immutable full Customer/Platform browser acceptance against actual private
   provider media: Northwind, Contoso, Fabrikam, shared role/Tenant/CSRF journeys and two canonical
   reset cycles in both Chromium and WebKit. Verify attached/historical images and conditional
   revalidation under real application authorization. Existing PG Hosted or private-fixture CI
   success does not substitute. Cross-branch credential denial also remains unexecuted.
2. The current workspace still fails direct Node provider DNS. The successful operator Function
   exercised maintenance/storage ports, not Customer/Platform applications. WebKit 2359 downloaded
   successfully from the official Microsoft fallback, but launch failed host dependency validation
   (`libgles2`). Normal apt installation failed filesystem permissions; extraction into scratch did
   not make the unchanged Playwright validation pass. No browser test ran; no dependency/security
   gate or browser assertion was skipped to manufacture success. An isolated application runner
   with provider connectivity, required browser dependencies and protected per-role credentials is
   needed. The current toolset does not expose GitHub workflow dispatch or protected-secret writes.
3. Preserve the canonical seed version/checksum and both runtime role/origin boundaries. Do not
   activate production private media or purge retained database bytes before complete private-provider
   acceptance, recovery, attachment/history and credential-isolation gates pass.
4. Reconcile retained branch/storage lifecycle and attributable invoice coverage under the accepted
   EUR 5 operator threshold. No additional budget approval is being requested or assumed here.
5. Actual cost ingestion, dashboard/alert delivery, worker operational behavior and representative
   cold/warm business load remain separate open work packages. Do not close the roadmap or release
   gate based only on this provider primitive or response-body accounting.
