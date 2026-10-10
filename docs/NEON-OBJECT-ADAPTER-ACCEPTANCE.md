# Manual real-Neon adapter acceptance

Tracking: frontend issue #264. This gate is a provider adapter probe, **not**
application authorization, coordinated database/object restore, browser/reset
acceptance, production backfill, cutover or permission to purge PostgreSQL bytes.

## Why this separate gate exists

The accepted four-row CI matrix uses an isolated S3 protocol fixture. Hosted #497
uses retained PostgreSQL media. Local direct DNS/SDK access returned EAI_AGAIN or
safe unavailability, while provider-level signed curl transfers succeeded. None
of those results proves the unchanged application's SDK works against Neon.

`Neon Object Adapter Acceptance` runs manually on accepted API `main` using Node 22
and the exact locked dependencies. It calls `createNeonObjectStorage` without a
client factory, custom transport, proxy, retry or deadline override. The only
allowed destination is the existing isolated branch `br-falling-glade-b17oqqiv`
and its private `conference-manager-media` bucket. No database compute, Function,
new service, bucket, production credential or tariff change is required.

## Protected setup and execution

1. Independently verify the named branch and private bucket before execution.
2. Select the acceptance branch in the Console before opening Create credential.
   Create a temporary credential **on that branch**, selecting **both**
   `storage:read` and `storage:write` explicitly.
   An ancestor/production credential is not acceptable. Neon scopes are branch-
   bound and cover descendants; they are not bucket-level isolation policies.
3. Set API repository Actions secrets `CM_NEON_ACCEPTANCE_ACCESS_KEY_ID` from the
   full `token_id`, and `CM_NEON_ACCEPTANCE_SECRET_ACCESS_KEY` from
   `s3_secret_access_key`. Do not use `token_id_short` or `api_token`, and do not
   paste credentials into conversation, workflow inputs, source or logs.
4. Run **Neon Object Adapter Acceptance** once on `main` after required PR gates
   pass. Inspect its exact source SHA and retained JSON artifact.
5. Revoke the temporary Neon credential immediately after the run, independently
   confirm `revoked_at`, and remove both temporary Actions secrets. Expiration
   alone is not provider-enforced revocation. Failed/cancelled runs require the
   same cleanup. Do not delete or reset the branch or its 34 retained objects.

The job has read-only GitHub permissions, pinned actions, no checkout credential
retention, no automatic trigger and no parallel cancellation. It installs locked
dependencies without lifecycle scripts and passes secrets only to the probe step.
It runs on the existing allowed GitHub capacity; this does not authorize a paid
runner, higher spending limit or unrelated provider compute.

## Evidence and failure semantics

Each invocation generates unique synthetic Tenant/asset UUIDs and a tiny fixed PNG.
It uploads through the unchanged adapter, independently compares exact returned
bytes, requires an anonymous HTTP 403, deletes only its exact synthetic key, and
requires the adapter's missing-object classification on readback before passing.
Even an ambiguous failed PUT triggers exact-key deletion. Unknown failures never
become a success. No user upload, canonical image or existing key is overwritten.

Bounded JSON retains source SHA, fixed isolated destination, synthetic key, byte
length/digest and fixed verification booleans. It excludes credentials, raw
provider errors, database connection data, URLs with signatures and user data.
An intent artifact is written exclusively before provider I/O, so the exact key
is retained even if the runner terminates before a final result. If cleanup fails,
this synthetic key is the operator's exact cleanup target. Recording failure
prevents provider I/O. A lost runner without a retrievable artifact remains an
unresolved custody check, not proof of an empty bucket. Preserve canonical custody.

Success unblocks the SDK-specific provider gate only. The full real-provider
application/paired recovery/three-customer/two-reset gates remain mandatory before
production switching or blob removal. Never replace or weaken the existing CI
matrix, hosted acceptance or restore-evidence digest requirement with this probe.

## Successful unchanged-SDK probe — 9 October 2026

Run `37976525762` succeeded on accepted main
`fb5703eb8752b109513b4b7d9ae01e9c6d34ac92`. The mandatory probe step exited zero:
exact-byte readback, anonymous HTTP 403, delete and missing-object classification
all passed. Its retained artifact is `11638562611` (30-day retention).
The branch-anchored temporary read/write credential was independently observed
revoked at `2026-10-09T18:56:29Z`. This supersedes the SDK-specific access blocker;
the earlier failed run `37974144848` remains failed historical evidence. Branch
and scopes both changed, so this does not isolate the earlier failure's cause.

## Real-provider application gate

`Neon Object Application Acceptance` is a manual main-only successor gate. It
reuses the existing full Customer/Platform compositions and the immutable shared
role/Tenant/CSRF and three-customer/two-reset journeys in Chromium and WebKit.
The fixed acceptance branch is the only real object destination; the unchanged
SDK uses normal transport and deadlines. PostgreSQL 18 and separate credentials
remain on the runner's fresh loopback database. Production database destinations
are rejected before provider allocation. Browser jobs run sequentially, sharing
the adapter-probe concurrency group to avoid conflicting operator executions.
The normal four-row mandatory CI remains unchanged.

The protected setup uses the same two temporary Actions secrets as above, with
both storage scopes anchored specifically to the acceptance branch. After its
required PR gates and merge, run `Neon Object Application Acceptance` once on
main. Revoke the temporary key and remove both secrets after BOTH browser jobs
complete, even on failure. Retain the full reports and exact source references.
Do not start while another acceptance operation owns the same branch.

Application writes use content-addressed keys and durable inventory in the
isolated runner database. An always-run bounded read-only export retains up to
10,000 inventory references, digests, lengths and registration dates before
runner disposal. Export failure fails the job; a hard runner termination can
still leave incomplete custody and requires provider inventory reconciliation. Canonical retained objects and the independent backup
branch must not be deleted. Scenario-created objects can outlive their metadata
when the runner disappears; this workflow does not authorize prefix deletion or
bypass the 30-day reference-aware retention policy. Preserve the branch for
inventory reconciliation. A failed job or unavailable report is not acceptance.

The first application run `37980396431` uses main
`a5ac741a7f9397023dfe5a8d3cdd7179766f48d7`. Its Chromium shared journey failed
at the reset HTTP request's unchanged 15-second deadline after the Business CSV
journey passed. The subsequent permanent progression step was not executed.
The always-run inventory export and browser report upload succeeded; Chromium
artifact `11640143770` retains that failed evidence. Serial provider publication
and semantic readback are the identified optimization target, not proof that a
candidate fix has passed real-provider acceptance. Every successor must retain
the complete unchanged journeys and pass both browser jobs before this gate closes.

### Successful complete application acceptance — 9 October 2026

After the bounded reset publication/readback correction in PR #136,
[run 37984079130](https://github.com/floriankreutzer/conference-manager-api/actions/runs/37984079130)
passed on API `6a42c22bd22dad05543c5c4eef893972c61b9d9b`. Both Chromium and WebKit
completed the unchanged shared role/Tenant/CSRF journey and the entire
Northwind/Contoso/Fabrikam progression with two canonical resets. The served
frontend remained `5d5102b4f9842ec704ff26441ebe96719324ddb0`; the full acceptance
contract remained `6228a827502b2cb59c8b9c50adebb9ad6431fe8b`. SDK transport, operation
deadlines, browser assertions and the separate four-row CI gate were unchanged.
The earlier failed application run above remains failed historical evidence.

| Browser | GitHub artifact | Archive bytes | Independently verified archive SHA-256 |
| --- | --- | ---: | --- |
| Chromium | `11643205381` | 622,290 | `6ec0147f8a735ccbcd35712c75fd9a735ea14839b78229d00cdfd4e68b5da8f9` |
| WebKit | `11644106258` | 611,364 | `feb36ec74843fb22847f0b44bd6960901a471093bff9e16c1397c39f41f5d395` |

Both complete archives were downloaded on 10 October and independently hashed;
each digest matches GitHub's artifact metadata. This resolves the earlier local
archive-download limitation. Each archive includes its seed binding, bounded
reference inventory and both complete HTML browser reports. The unchanged
original ZIPs are durably retained beyond their GitHub expiry on 8 November.
The embedded reports contain six passed cases, two explicitly skipped dedicated
200% zoom cases, no failures, no flaky results and no retries. The separate
headed zoom gate is not evidenced by these archives. See the
[archive verification record](evidence/saas38-application-acceptance-20261010.json).

Each archived inventory records 53 references, including all 34 canonical
objects. Their union contains 71 distinct references / 6,846,628 bytes, including
37 additional references / 1,653,932 bytes. These are run-bound database
inventories, separate from the post-run provider observation below; neither
inventory reconciliation nor application cleanup proves provider deletion.

The temporary acceptance-branch credential was independently confirmed revoked
at `2026-10-09T20:34:49Z`; removal of the two temporary Actions secret entries is
a separate repository-settings action, not implied by provider revocation.
The post-run provider inventory recorded in issue #264 was 73 objects / 6,846,776
bytes: 34 canonical objects / 5,192,696 bytes and 39 scenario/revision objects /
1,654,080 bytes. Preserve their reference-aware custody and 30-day retention;
neither a completed job nor archive download authorizes prefix deletion.

This successful gate establishes real-provider application/browser/reset
integration with runner-local PostgreSQL. The separate
[restored-pair acceptance](NEON-PAIRED-RECOVERY-ACCEPTANCE.md), real-provider
corruption/failed-rollback and retained-revision reads, production backfill/cutover,
blob purge, live alert delivery, representative business load and attributable
cost savings remain separate gates. Hosted Demo still uses PostgreSQL media.
