# Protected room-change recovery verification — 24 November 2026

Tracking: CO-299; broader customer acceptance remains in CO-320.

The qualified release is deployed to both existing INT services. Read-only
all-byte verification and authenticated recovery of the retained synthetic booking
succeeded. This scoped result does not close the broader product acceptance.

## Source and qualification

The release selects API `4e64ba5d3f8fc94a38cc1af391897ce700d5faa4` and frontend
`2e452aff6e5d3db6f040065faece0146e1c6ec19`. API PR432 fixes the server-owned target
calendar-resource binding; frontend PR491 exposes recovery of the same persisted
applying proposal through the existing guarded approval. API PR433 binds the
protected frontend Gitlink and PR434 prepares the exact provider configuration.

| Change | Candidate CI | Merge source | Independent Main CI |
| --- | --- | --- | --- |
| API PR432 | 45280481531, success | `5ff5bd30ab741a96d7c16502224fb1ae7a8663f9` | 45284894663, success |
| Frontend PR491 | 45281672505, success | `4becd49069861cfdf26678ecfebe412edd29eff8` | 45289602399, success |
| API PR433 | 45282711602, success | `43d035a1d235b1689fc97c822e256e545517cdaf` | 45289645162, success |
| API PR434 | 45283551954, success | `ef255c916dde218d089b638975832307d2bf0f0e` | 45289681602, success |

Every candidate retained its exact-head authentic review without findings and
native security gates. Frontend candidate and Main CI each completed all 619
ordinary browser cases per engine, protected Chromium/WebKit, the permanent
three-customer progression and two reset cycles, followed by the aggregate e2e
gate. API candidate and Main gates, including PostgreSQL/proof-expiry, permanent
Demo, security/DAST and source inventory/attestation, completed before application.
The merge trees equal the reviewed candidate trees; ordinary merges preserved all
enforced source protections. Separate Jira automation diagnostics are not these
release gates and are not represented as successful by this record.

The frozen branch `release/int-20261123-4e64ba5` resolves to the exact API release
source. Active ruleset `27944981` targets only this branch, prohibits updates,
deletion and force pushes, and contains no bypass actor.

Two clean Node 22 builds in the configuration record and a third independent
clean build produced identical manifest digests. The canonical artifact reader
verified all 315 Customer files and 197 Platform files and refused incorrect API,
frontend, digest, surface and owner-profile bindings.

## Provider application and hosted bytes

Fresh provider plan `exe-dc2dh4ui0phs73aheqeg`, from configuration Main
`ef255c916dde218d089b638975832307d2bf0f0e`, was approved only after all release
gates succeeded. It changed exactly five semantic values per existing service:
frozen branch, literal source guard, API pin, frontend pin and manifest digest.
No manual environment input or new resource was requested. Provider readback
retained Free plans, Frankfurt, one instance per service, disabled auto-deploy
and previews, fixed origins and readiness paths. Blueprint auto-sync stays paused.

| Surface | Successful provider receipt | Completion time, UTC |
| --- | --- | --- |
| Customer | `dep-dc2dhke8bjmc73fbp850` | `2026-11-24T00:23:33.522Z` |
| Platform | `dep-dc2dhke8bjmc73fbp8s0` | `2026-11-24T00:23:38.929Z` |

Provider completion times are normalized to the established millisecond contract.
Both receipts identify the exact R4e64ba5 source. These are deployment times,
not observation timestamps.

| Surface | Qualified manifest SHA-256 | Files / bytes |
| --- | --- | --- |
| Customer | `652c82a3a83a0fb9193b725715134093bec91c933d603ccda385e2e11ae686cf` | 315 / 2,339,625 |
| Platform | `d255ec1f24a74d3da66a1c8b1d5ff5da68cdb100a9e879df0498e37907ddc376` | 197 / 1,525,801 |

After both direct readiness routes returned HTTP 200/ready, the unchanged
canonical `verifyProtectedRuntimeArtifacts` from the clean release source ran
under Node 22.23.4 against the independently rebuilt artifacts. At
`2026-11-24T00:26:33.963Z`, its report confirmed all 512 hosted files' exact bytes,
length, digest, MIME type, direct status and fixed origin, followed by both API
identities: build R4e64ba5, version `cm-int-20261021`, required state ready.
Optional provider state remains unknown. The report is verification-only: no
cookie, database credential, epoch, persistence or business write was involved.

## Retained booking recovery and cleanup

Authenticated normal UI acceptance used the existing synthetic Conference Manager
session and the same retained booking/proposal. The earlier unsuccessful move
remains historical evidence in CO-299. No replacement proposal, data reset or
direct database repair was performed.

After a full browser reload, the original confirmed booking still showed its
original room, ten participants and EUR 60. Its existing proposal remained
applying. Action required correctly showed one and exposed Resume change. A
single keyboard activation resumed the existing operation; controls were disabled
during the request. The authoritative result, including a subsequent Refresh,
showed the target room, six participants (four internal/two external), EUR 30,
confirmed booking and applied proposal. Action required returned to zero.
History retained the original entries and added Booking changed at 01:27 CET.

The same annual site report then showed four retained requests, one confirmed
booking, six participants, one room hour and zero catering bookings; room
utilisation attributed that hour and six participants to the target room.

Normal cancellation of this named synthetic test booking succeeded at 01:28 CET.
History retained the change event and added Cancelled. The report retained four
requests and showed zero confirmed bookings, participants, room hours and
catering bookings. A fresh normal availability query for the same target room,
date/time and six participants returned Calendar available. Its unsaved query
draft was discarded without submitting another booking. The final independent
manager view retained the four requests and zero confirmed bookings.

## Observation reconciliation and scope limits

The checked-in observer selection, fixed frontend checkout/allowlist and native
read-only verifier now use these actual successful receipts and independently
qualified digests. Negative coverage refuses the superseded frontend. This
source reconciliation requires its own normal review, candidate/Main and security
gates; those later native receipts remain in GitHub and are referenced from Jira.

Its first candidate CI run `45298122645`, WebKit/object job `138124406587`,
reached the unchanged 30-minute budget. APT fetched 140 MB from the runner's AWS
Ubuntu mirror in 24 minutes 37 seconds (94.7 kB/s). Both shared browser cases
then passed, but permanent three-customer/reset acceptance did not complete.
That cancelled attempt is not a pass. The existing Azure-only mirror preference
had retained the AWS defaults. The bounded correction also recognizes the
runner's exact AWS entry and swaps only existing priorities with the official
HTTPS archive. Negative fixtures preserve unknown or ambiguous configurations.
Fresh exact-head review and complete candidate/Main gates remain required.

This work does not activate recurring collection, change qualification variables,
allocate database credentials or claim a persisted observer result. Owner,
epoch, migration-ledger, routing, freshness and budget guards remain in force.
The preceding R67527/Fdda63 release and its failed move remain historical, and
the established rollback pair in the configuration record is retained.

Employee-only acceptance, actual Microsoft/Exchange, independent security and
recovery, physical Safari and actual PDF acceptance remain separate. Synthetic
room-change recovery and cleanup cannot close those gates or all of CO-299/CO-320.
