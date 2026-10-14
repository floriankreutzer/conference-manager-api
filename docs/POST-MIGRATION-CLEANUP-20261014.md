# Post-migration workflow and code review — 14 October 2026

## Verified baseline

Backend baseline: [merged provider release](https://github.com/floriankreutzer/conference-manager-api/commit/605a9cba3116f1542c00380c2c6f6cb2570383dd).
Application main: `04d6a4e8d74cccda0e2f62009b539162a971b1c6`.
This is source/automation cleanup, not a new hosted release or data migration.

| Item | Disposition | Evidence / reason |
| --- | --- | --- |
| API `complete-saas37-milestone.yml` | Retired | Milestone 1 read back closed, zero open issues, closed 30 September 2026 |
| Application `complete-saas39-milestone.yml` and its dedicated closure-script tests | Retired | Milestone 12 read back closed, 4 October 2026; these tests exercise only the removed metadata script |
| API `room-media-retention.yml` | Retired | Disabled legacy PostgreSQL-only deletion job; does not implement Object Storage/Catalogue custody |
| Application `complete-saas36-milestone.yml` | Retained | Milestone 10 still open; #164 and #170 still open |
| Quality, security, dependency, DAST and shared/scenario browser workflows | Retained | Required security and permanent regression gates |
| Private source reader and public API publishing workflows | Retained | Separate active CI/publication responsibilities; source visibility is not permission to drop them |
| Hosted initialization, provider acceptance, recovery connection/pair and Live operator workflows | Retained | Scoped operational/diagnostic capabilities, not obsolete because one migration completed; expired authorizations must not be reused |
| PostgreSQL media adapters, backfill/rollback repositories, retention CLI and historical schema compatibility | Retained | Production/PostgreSQL mode, rollback, immutable history and both CI storage-mode rows still consume them |

No runtime module was proved dead by this review. Removing compatibility code
without checking persistent history or removing the PostgreSQL CI rows would
weaken supported behavior. No database/object/secret deletion, reset, quota,
plan, permission or required-check change is included. Historical workflow
source and run evidence remain in GitHub history.

## Issue acceptance

#263 still needs durable collection, failure/delivery behavior, billing provenance
and comparable baseline. A delivered Resend setup test is not a threshold alert.
#264 still has recovery/custody/retention acceptance limits; actual media copy
and reconciliation are complete, but waived checks remain waived.
#265–#267 and #269 retain their recorded operational measurements.
#262/#270 remain open until their full release criteria are met.
SaaS 3.6 #164/#170 require their final release reconciliation; the completed
SaaS 3.7/3.9 metadata does not close them.
