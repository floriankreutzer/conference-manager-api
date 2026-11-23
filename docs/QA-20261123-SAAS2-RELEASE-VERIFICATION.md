# Protected INT release verification — 23 November 2026

Tracking: CO-299, CO-320, CO-85. This dated record describes actual deployment
and read-only artifact verification. Product Acceptance remains pending.

## Qualified implementation and configuration

Frontend PR489 selected F `dda63bc08bffacc1f80e2681e12bbee59d8fe4f6`; candidate
CI45199284550 and Main CI45206805496 passed. API source PR429 selected
R `67527b7e054191cd51686d733b9b5575e7beccee`; candidate CI45232591966 and Main
CI45237078546 passed all six jobs. Configuration PR430 exact head
`9015d278eeb07e5bc0355f7386f7b75aeabed55e` passed CI45237595572, dependency-policy,
gitleaks, inventory and authentic no-findings review. Its normal merge Main
`bb8cf407e326b1491fe209609e1ba9d891384eae` passed all six jobs in CI45242565363,
Secret Scan45242565531 and Release source evidence45242565209. Tree equality
between the reviewed configuration and Main was independently verified.

Two clean Node22.23.4 builds produced identical artifacts. The independent API
reader verified every file, manifest/profile binding, size and MIME; wrong digest
and API bindings were rejected. The release branch `release/int-20261123-67527b7`
remains at R under active exact ruleset27923248, with no bypass actors.

## Actual provider application

Blueprint sync `exe-dc29340u01pc73fumijg` planned current Main bb8cf40 and exactly
five semantic changes per existing service: branch, literal source build guard,
API pin, frontend pin and manifest digest. There were no manual input requirements
or extra resources. The reviewed plan was applied with auto-sync remaining paused.

| Surface | Actual successful deployment | Provider finish time UTC | Manifest SHA256 |
| --- | --- | --- | --- |
| Customer | `dep-dc2936l6e07s73b4qkkg` | `2026-11-23T19:19:38.992863Z` | `52e641d94e1284f19b44665fcfe08c1d9343bbfbc3cb4ad779a8b72cd81aca03` |
| Platform | `dep-dc2936l6e07s73b4qld0` | `2026-11-23T19:19:38.980121Z` | `21fefc4a4a50e0bfb3d9175dfc7f14acf9b584559a29c0b59750f7c19b747052` |

Selection instants normalize these provider timestamps to JavaScript ISO
milliseconds. Both provider receipts identify exact R; neither is a configuration
or observer commit. The rollback remains R671/Ff89 with the dated 22 November
receipts in the configuration record.

## Independent served-byte verification

At `2026-11-23T19:20:24.383Z`, the unchanged canonical
`verifyProtectedRuntimeArtifacts` completed successfully against the two fixed
public origins and independently built artifacts. All 315 Customer files and 197
Platform files matched SHA256, length and exact MIME. Both health responses
matched exact R and service version `cm-int-20261021`, with required state `ready`
and optional state `unknown`. The check used GET without cookies, refused redirects,
and did not use database credentials, an epoch, reconciliation or a persistable
observer receipt. It is not a fresh recurring-observer observation or evidence
that optional Microsoft/mail integrations are healthy.

## Verification source reconciliation and open acceptance

The follow-up change binds the fixed observer checkout, allowlist, selection and
read-only verification workflow to these actual receipts and artifacts. Old
frontend selections remain negative controls. Owner, source, epoch, database,
concurrency and schedule gates remain intact. No observer dispatch, schedule
activation or qualification-variable update is performed. This follow-up needs
its own candidate/review/Main checks; preceding release checks do not substitute.
Frontend DAST expected versions are reconciled in the paired follow-up; its own
native outcome must be inspected before claiming a current DAST pass.

The normal customer inactivity-unlock attempt returned a safe-validation failure.
The retained synthetic booking still needs valid reduction, history/report checks
and cancellation after normal access is restored. Employee-only acceptance is
separate from the Conference Manager session. Actual Microsoft/Exchange,
independent security/recovery, physical Safari and actual PDF acceptance remain
open as applicable. No product ticket is closed by the deployment or byte check.
The separate Jira Readiness Sweep failure45238686800 remains a historical failure.
