# SaaS 3.8 implementation checkpoint

This document binds accepted implementation evidence and remaining operational gates. It is not a
production release, hosted cutover, restore attestation, full benchmark or roadmap-closure claim.
Root `AGENTS.md`, the engineering standards and the permanent three-customer invariant remain
mandatory. Historical failed/cancelled checks remain failed/cancelled; successful successor runs
are recorded separately.

## Accepted source

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

The independently read Neon Demo project record reports existing Launch v3 in Frankfurt. Earlier
runbook Free-plan wording describes the original topology, not an independently verified current
invoice or plan change performed by this work. The October 7 FinOps checkpoint records 7,991,773,109
provider-defined project transfer bytes. Published Launch allowance/rates and decimal-GB conversion
are dated modeling inputs, not observed configured hard quotas or invoice-aligned v2 counters.
Shared allowances cannot be copied independently to overlapping product totals.

The private `conference-manager-media` bucket exists. The isolated acceptance branch has no compute
endpoint. On October 8 a provider-presigned PUT and GET succeeded with exact equality for a
57-byte synthetic object; unsigned access to that same existing object returned HTTP 403.
Its SHA-256 is `ba128237e1a85e020c63f61e037d9fa9cbc26cb266993e9b945efe4ccc33c926`.
The probe was deleted and its prefix independently listed empty. Deletion does not attest physical
retention expiry. Both temporary scoped SDK credentials were revoked and independently reread as
revoked. Default branch credentials were neither retrieved nor modified. Earlier failed attempts
remain failed: the production adapter's default Node transport still fails DNS, and diagnostic
proxy attempts time out. Presigned success is not SDK, credential-scope, restore or cutover acceptance.
See [the retained observations and remaining execution plan](SAAS-3.8-LIVE-EVIDENCE-20261008.md).

Both existing Free Frankfurt Render surfaces independently serve API
`c9f1e45565c268768c1b814b610bf5cab6b8650a`, canonical schema 44 and Demo overlay 9.
Protected initialization run `37792057793` succeeded, and the migration ledgers were independently
read back. Full Hosted acceptance `37794776976` succeeded: four cross-role journeys and both
complete three-customer/two-reset browser scenarios, with stable deployment identity and repeatable
cleanup recorded in artifact `11561275861`. Frontend #283 merged at
`5466dbe34b05af06e491eab563ac832cf3e0182f`; its exact candidate passed CI `37797402564`,
Secret Scan `37797407490`, Dependency Review `37797402731` and three-surface OWASP ZAP
`37797402697`. Historical failed runs remain failed. PostgreSQL media remains active.
The deployment retains the seed version
`saas-3.7-three-demo-customers-v1`, with semantic checksum
`7e22005f1e9689fbea4ccfc75084f5f3d224fe10e60a6af23c1cb600f2b70014`.
The served frontend is pinned to `5d5102b4f9842ec704ff26441ebe96719324ddb0` and the permanent
acceptance contract to `195d530cdc97f67512ef9b2d89831e0b1a0f27fb`.
Build metadata and readiness were verified before and after the successful Hosted run and after
the frontend merge; repository merge identity alone is not deployment evidence.

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

The Render workspace identity was confirmed and reused; both services retain automatic deployment
disabled. The PostgreSQL-mode release sequence is complete. Private-provider SDK/restore acceptance
remains blocked by default Node transport connectivity and the lack of an isolated database compute.
Existing private-storage usage costs are authorized; unrelated plan/quota, compute/runner capacity
and provider migrations are not implicitly authorized. The remaining operational gates above remain
open; neither presigned access nor fixture-only evidence substitutes for them.

## Roadmap integrity

#268 is closed after accepted isolation of routine CI. #263–267, #269 and #270 remain open until
their specific operational evidence is complete. Accepted code, pending runtime/provider evidence
and owner decisions must remain distinguishable. The release gate cannot be closed merely because
the foundation code or this document passes CI.
