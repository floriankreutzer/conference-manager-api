# Protected SaaS 2 room-change recovery configuration

Tracking: CO-299; overall acceptance remains in CO-320. This is a prepared
configuration, not passing qualification, provider application or acceptance.

## Immutable selection

| Input | Exact value |
| --- | --- |
| Published API source R | `4e64ba5d3f8fc94a38cc1af391897ce700d5faa4` |
| Protected frontend F | `2e452aff6e5d3db6f040065faece0146e1c6ec19` |
| API source PR | [433](https://github.com/floriankreutzer/conference-manager-api/pull/433), dependent on [432](https://github.com/floriankreutzer/conference-manager-api/pull/432) |
| Frontend PR | [491](https://github.com/floriankreutzer/conference-manager/pull/491) |
| Prepared frozen source branch | `release/int-20261123-4e64ba5` |
| Customer manifest SHA256 | `652c82a3a83a0fb9193b725715134093bec91c933d603ccda385e2e11ae686cf` |
| Platform manifest SHA256 | `d255ec1f24a74d3da66a1c8b1d5ff5da68cdb100a9e879df0498e37907ddc376` |

The branch must exist at R and be protected against updates, deletion and force
push without bypass before provider application. This record does not assert
that protection has already been installed. Never replace R with a later Main
or configuration commit. The protected Gitlink at R is exactly F.

## Independent build evidence

Two distinct clean API clones at published R, each with its own initialized
frontend checkout at F, executed the unmodified Render wrapper under Node 22.
Both used the existing INT origins and explicit synthetic, Microsoft, invitation
and owner-access flags. Both wrapper runs succeeded and produced identical
Customer and Platform manifest bytes. One initial incomplete local clone lacked
the new documentation blob; its first checkout/build failed before qualification.
The exact published blob was restored and its Git object hash verified before
the successful clean build. No source-cleanliness or artifact guard was disabled.

At `2026-11-23T22:48:03.970Z`, the independent API artifact reader verified all
four artifacts, including every file's bytes, digest, length, MIME type, full
inventory and source/profile binding. Each Customer artifact contains 315 files
and 2,339,625 bytes; each Platform artifact contains 197 files and 1,525,801 bytes.
All four checks rejected incorrect manifest digests and incorrect API bindings.
This proves reproducible source artifacts, not native browser or live acceptance.

## Required qualification and application

Keep the configuration unapplied until exact frontend/API/source candidate and
authentic-review gates, their required separate Main gates, and this
configuration's own candidate/review/Main gates pass. Frontend paired CI binds
the actual room-move API correction e3fccfd; source R adds only its protected
Gitlink and source-selection record to that application code. Full Chromium,
WebKit, protected browsers and permanent three-customer/two-reset gates remain.

Only five semantic fields per existing service change: frozen branch, literal
API build guard, API source pin, frontend source pin and corresponding manifest.
Review a fresh provider plan for exactly these ten field changes. Preserve the
paused Blueprint `exs-daakihlg1s2s73df6jdg`, Customer
`srv-daakprhsrm7s73f82deg`, Platform `srv-daakprhsrm7s73f82dg0`, retained unlinked
legacy group, Free/Frankfurt/one instance, disabled auto-deploy/previews, origins,
start/readiness paths, version and every operator-owned input.

Require two successful fresh deploy receipts, readiness and independent complete
served-byte equality before claiming delivery. Resume the retained synthetic
change through authenticated UI, verify room/participants/cost/history/reports,
then cancel normally and prove released capacity. No reset or direct DB repair.
Employee-only, real Microsoft/Exchange, independent security/recovery, physical
Safari and actual PDF acceptance remain separate.

## Observed rollback

The immediately preceding observed pair is API
`67527b7e054191cd51686d733b9b5575e7beccee` / frontend
`dda63bc08bffacc1f80e2681e12bbee59d8fe4f6`, frozen branch
`release/int-20261123-67527b7`. Customer receipt `dep-dc2936l6e07s73b4qkkg`
and Platform receipt `dep-dc2936l6e07s73b4qld0` are recorded with their manifest
digests in [the previous configuration](QA-20261123-SAAS2-CATERING-CONFIGURATION.md)
and [served-byte evidence](QA-20261123-SAAS2-RELEASE-VERIFICATION.md).
It preserves the original booking but does not repair the Applying change;
rollback is not recovery acceptance. No new provider receipt is claimed here.
