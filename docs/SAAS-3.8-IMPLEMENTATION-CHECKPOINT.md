# SaaS 3.8 implementation checkpoint

This document binds accepted implementation evidence and remaining operational gates. It is not a
production release, hosted cutover, restore attestation, full benchmark or roadmap-closure claim.
Root `AGENTS.md`, the engineering standards and the permanent three-customer invariant remain
mandatory. Historical failed/cancelled checks remain failed/cancelled; successful successor runs
are recorded separately.

## Accepted source

### Current reconciliation — 9 October 2026

The earlier checkpoints below are historical. Current accepted API main is
`356459004dbede11cc3cd17a93d4e6cf515d410b` (PR #132); frontend main is
`ee541cdb1f2c9c5605421a6f48968ac773fd05f9` (PR #285). The immutable served frontend
remains `5d5102b4f9842ec704ff26441ebe96719324ddb0`; API CI uses acceptance source
`6228a827502b2cb59c8b9c50adebb9ad6431fe8b`. API CI `37936151197` passed quality,
real PostgreSQL integration and all four complete browser/storage rows. Frontend #285 CI
`37940128261` passed after a targeted shared-journey rerun; the first WebKit shared CSV
failure remains recorded rather than being relabeled. Hosted DAST `37940128221` passed.

Render workspace `tea-daa8bkpf2nfc739hdddg` was explicitly confirmed. Both existing Free
Frankfurt services were deliberately deployed from the accepted API ref with auto-deploy off.
Protected migration run `37792057793` established canonical schema 44 / Demo overlay 9.
Hosted Demo Acceptance #497, run `37946740113`, attempt 1, succeeded on current frontend
main. Its downloaded evidence artifact `11625658932` verifies both build identities before
and after the complete shared-role and three-customer Chromium/WebKit journeys, two reset
cycles, repeatable cleanup and the unchanged semantic checksum. See
[deployment evidence](HOSTED-DEMO-DEPLOYMENT-EVIDENCE.md#accepted-saas-38-hosted-baseline--9-october-2026).

Current provider observations supersede the earlier empty-inventory/network-only checkpoint:
production object inventory is empty; the isolated acceptance and backup branches each contain
34 private objects. Credential-free signed byte downloads are now possible. The unchanged
production S3 adapter's real-provider test still failed with `MEDIA_STORAGE_UNAVAILABLE` in
this execution environment; its temporary acceptance-branch credential was revoked immediately.
A separate SDK diagnostic with the same bounded connection/request timeouts and an explicitly
injected environment-proxy agent returned `TimeoutError`; its read-only credential was revoked.
All 34 backup objects were downloaded and independently checked against the SHA-256 key suffix
and listed byte length: 5,192,696 bytes, no mismatches. This establishes stored object integrity,
not comparison to authoritative database metadata. A separate curl SigV4 test on the isolated
acceptance branch uploaded and re-uploaded one unique test object (HTTP 200), downloaded exact
matching bytes (200), rejected anonymous access (403) and rejected the same branch credential
on production (403). Exact test-object deletion succeeded; a signed subsequent read returned
404. Credential revocation succeeded and a subsequent signed request returned 403. No default
credentials were retrieved. These provider-level results do not attest SDK publication,
application authorization, coordinated database/object restore or production cutover. PostgreSQL media remains
authoritative and retained; no production object publication or blob purge was performed.

The 9 October Neon project observation reports 8,992,098,511 project-defined transfer bytes
within `2026-10-03T11:49:06Z` to `2026-11-01T00:00:00Z`, on existing Launch v3 Frankfurt.
This is not an invoice or independently verified hard quota. Both-surface Render application
payload logs were paginated completely for `2026-10-09T14:47:54Z` to `15:40:00Z`:
21,992 unique payload records total 84,456,624 HTTP body bytes. This observation interval
extends beyond the hosted job and includes ordinary service traffic; it is not a pure test
cost attribution. Provider bandwidth samples report 72.474754 and 65.53743 in provider unit
`mb`; HTTP-count/latency metrics returned no points, which is unavailable evidence rather
than zero. These overlapping provider/application boundaries must not be summed into billed
egress. Invoice coverage, durable collection/alert delivery and representative business-load
capacity remain separate open gates.

### Earlier foundation checkpoint

Private object metadata/publication/backfill and deterministic external-object reset integration
are accepted through API #119–123. Frontend #281 isolates routine hosted acceptance from public
Demo traffic; frontend #282 strengthens private conditional-image acceptance. API #124 and #125
add authenticated private revalidation and bounded static compression/fingerprints. API #126 adds
transactional source invalidation, durable projection intent, bounded retries/poison retention,
optional empty notification hints and slow reconciliation. API #128 adds offline FinOps signals,
independent modeled cost components and safe aggregate JSON/HTML.

The exact API/frontend refs, six-job API CI matrix and dependency/secret gate results are retained
in the individual PRs. A successful matrix contains quality, real PostgreSQL and all four complete
Chromium/WebKit × PostgreSQL/private-object fixture combinations. Each browser row retains the
shared role/Tenant/CSRF journey, Northwind/Contoso/Fabrikam progression and two canonical resets.
No fixture-only or native result substitutes for these gates.

Browser-mirror recovery #130 is accepted at merge `7282780a5fb6c24138ddea6721db10793656e78b`.
Its exact candidate `887041de887d7e01898f0a70ebb12247dd8027ef` passed CI `37696743551`
(all six jobs), Secret Scan `37696743540` and Dependency Policy `37696743591`. Completed
WebKit logs confirm downloads from the official Ubuntu archive and full journey success.
Readiness #127 and session-load #129 are accepted after all six exact-head CI jobs, Secret Scan
and Dependency Policy passed. Their historical failures remain documented in the PR conversations.

| Scope | Exact tested head | CI / Secret Scan / Dependency Policy | Accepted merge |
| --- | --- | --- | --- |
| Readiness #127 | `b5fd43c168e083b33c9d1bc243ad2c877c026856` | `37696971249` / `37696971233` / `37696971239` | `a72993b6856d0f69660da09e682ebbe35c5bd440` |
| Session-load #129 | `e3f7f497a82ec9da039c422096d1e0906f446360` | `37697083181` / `37697083130` / `37697083143` | `6af8ed7b1a541badcc0171b906b8ecef185ad40c` |

Combined implementation main is `6af8ed7b1a541badcc0171b906b8ecef185ad40c`, source tree
`4ecdc37250fec378c9c236c1681d0c6b3f4c0bed`, before adding this documentation checkpoint.
Review submissions and inline threads were inspected and empty before each final merge.

The combined local source passed `npm run check`: 974 native tests, the live Customer HTTP DAST
smoke gate and 17 Platform HTTP security tests, without failures or skipped tests. This local
integration result does not replace required GitHub checks or hosted acceptance. The checkpoint
PR separately verifies the combined final source using the same configured complete CI matrix.

## Isolated load evidence

The real PostgreSQL integration job `113051833522`, CI run `37697083181`, passed on API commit
`e3f7f497a82ec9da039c422096d1e0906f446360`. The retained aggregate diagnostics used Node v22.23.3,
PostgreSQL 18.6, ten active synthetic Tenants, a ten-connection pool and sixteen concurrent HTTP
clients. Every actual session response verified exact User/Tenant/active state/canonical role.
External provider operations are rejected by the test-only injected port.

| Active Users / actual reads | Users per Tenant | p50 / p95 / p99 ms | Elapsed ms | SQL calls | HTTP body bytes | PG received / sent bytes |
| --- | ---: | --- | ---: | ---: | ---: | --- |
| 100 | 10 | 19.330 / 58.461 / 60.735 | 160.931 | 200 | 39,857 | 109,663 / 39,620 |
| 1,000 | 100 | 13.490 / 18.475 / 22.544 | 869.210 | 2,000 | 398,957 | 1,096,797 / 314,000 |
| 10,000 | 1,000 | 12.063 / 22.636 / 29.100 | 8,187.991 | 20,000 | 3,989,957 | 10,977,823 / 3,140,000 |

These are one-run warm session-read-only measurements on isolated loopback, not 10,000 concurrent
clients, business/booking capacity, provider invoice transfer, cold-start evidence or an SLO.
Connection warmup is excluded; prepared-query metadata and actual measured protocol bytes remain
included. Monthly scaling must state activity assumptions and keep independent boundaries separate;
the workload/topology evidence specification is in [Load Evidence](SAAS-3.8-LOAD-EVIDENCE.md).

## Provider and deployed-state boundaries

The observations in this section predate the current reconciliation above.

The independently read Neon Demo project record reports existing Launch v3 in Frankfurt. Earlier
runbook Free-plan wording describes the original topology, not an independently verified current
invoice or plan change performed by this work. The October 7 FinOps checkpoint records 7,991,773,109
provider-defined project transfer bytes. Published Launch allowance/rates and decimal-GB conversion
are dated modeling inputs, not observed configured hard quotas or invoice-aligned v2 counters.
Shared allowances cannot be copied independently to overlapping product totals.

The private `conference-manager-media` bucket exists. The isolated acceptance branch has no compute
endpoint. Authenticated SDK, proxy and credential-free presigned upload attempts failed through this
execution network; independent object inventory remains empty. Temporary scoped application keys
were revoked; provider-created default branch credentials were neither retrieved nor modified.
No authenticated provider roundtrip, coordinated restore, object backfill/purge or live cutover is
claimed. Isolated S3 fixtures prove application integration, not those provider properties.

The last independently retained hosted baseline is API `dccd86b3dc1eb208423407f104686aff347581ef`,
canonical schema 42 and Demo overlay 7. Repository merges do not establish new deployment identity.
The implementation expects canonical schema 44 / overlay 9 and retains the seed version
`saas-3.7-three-demo-customers-v1`, with semantic checksum
`7e22005f1e9689fbea4ccfc75084f5f3d224fe10e60a6af23c1cb600f2b70014`.
The served frontend is pinned to `5d5102b4f9842ec704ff26441ebe96719324ddb0` and the permanent
acceptance contract to `195d530cdc97f67512ef9b2d89831e0b1a0f27fb`.
Never deploy that runtime against the old schema or describe
the existing origins as upgraded without newly observed build metadata and hosted acceptance.

## Prepared release sequence and unresolved evidence

1. Bind the final accepted API/source tree, immutable served frontend and acceptance refs, required
   reviews and exact successful security/PostgreSQL/browser gates. Do not promote pending heads.
2. Confirm the actual Render workspace identity required by the Render tool before managing services.
   Reuse the existing two Free Frankfurt services, preserve separate origins/cookies/roles and
   `autoDeployTrigger: off`; do not provision new paid compute or change plans/quotas.
3. Verify current usage/allowance and protected migration/runtime/reset credentials without exposing
   them. Quiesce both services and apply reviewed canonical migrations through 044 and Demo overlays
   through 009 with the protected migration identity, then run the supported deterministic reset.
4. Deploy both existing services at the compatible exact accepted API ref. Fetch build-bound identity
   from both origins and verify readiness before the separately authorized hosted acceptance run.
5. Keep media in the existing PostgreSQL mode until real private-provider roundtrip, credential
   isolation, bounded copy, coordinated restore/rollback and full private-media customer/reset
   acceptance are verified. Retain blobs/custody; do not bypass purge or downgrade guards.
6. Verify actual invoice-aligned provider coverage, Render plan generation/usage, both-surface metric
   aggregation, alert delivery/dashboard and worker operational behavior. Offline reports and emitted
   aggregate telemetry do not establish deployed collection or delivered alerts.
7. Verify the representative business activity mix, cold/warm latency, object/CDN traffic, worker load,
   total attributable monthly costs and identical permitted topology comparisons before a separate
   provider migration decision. Session-only scaling does not complete that work package.

At that earlier checkpoint, workspace confirmation and provider data-plane access were missing;
the current reconciliation records their subsequent observed status. Neither missing evidence
is replaced by assumed consent or test-only evidence. Existing private-storage usage costs are authorized; unrelated plan/quota,
compute/runner capacity and provider migrations are not implicitly authorized.

## Roadmap integrity

#268 is closed after accepted isolation of routine CI. #263–267, #269 and #270 remain open until
their specific operational evidence is complete. Accepted code, pending runtime/provider evidence
and owner decisions must remain distinguishable. The release gate cannot be closed merely because
the foundation code or this document passes CI.
