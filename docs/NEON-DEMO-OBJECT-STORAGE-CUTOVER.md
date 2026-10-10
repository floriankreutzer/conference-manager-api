# Hosted Demo Object Storage cutover

Tracking: [Object Storage #264](https://github.com/floriankreutzer/conference-manager/issues/264)
and [SaaS 3.8 release gate #270](https://github.com/floriankreutzer/conference-manager/issues/270).

## Scope and current boundary

Object Storage activation can precede completion of the remaining FinOps, dashboard,
alert-delivery and representative-load work. Those are separate SaaS 3.8 acceptance
items. The storage-specific integrity, authorization, recovery and rollback gates
still precede this cutover; the owner's 10 October request prioritizes this work.

This change adds explicit opt-in storage wiring to the ordinary Customer and
Platform Demo entrypoints. PostgreSQL remains the default. Adding the wiring does
not migrate data, deploy a service, validate a provider credential, or accept a
restored database/object pair.

Provider reads on 10 October, at API baseline
`5784dac63e09033a770fe31c8e66a10655f79d43`, established:

| Surface | Observed state |
| --- | --- |
| Existing Neon project | `divine-shape-86658581`, Frankfurt, PostgreSQL 18 |
| Live Demo database branch | `br-summer-rice-b1f8voyp` (`production`) |
| Live branch Object Storage | Enabled; private `conference-manager-media` bucket; **zero objects** |
| Isolated restored baseline | `br-rapid-morning-b1a704p9`; 34 retained objects / 5,192,696 bytes |
| Customer Render service | `srv-daakprhsrm7s73f82deg`, Free, auto-deploy off |
| Platform Render service | `srv-daakprhsrm7s73f82dg0`, Free, auto-deploy off |
| Both deployed API versions | `356459004dbede11cc3cd17a93d4e6cf515d410b`; last live deploys 9 October |

The isolated baseline's objects are not objects on the live branch. A successful
SDK or browser run against that isolated storage does not populate the live bucket.
Refresh these observations immediately before an operational cutover.

## Why this requires a coordinated transition

The existing repositories deliberately use one storage mode at a time:

| Metadata state | PostgreSQL mode | Object Storage mode |
| --- | --- | --- |
| PostgreSQL bytes, no object pointer | Readable | Rejected: backfill required |
| Object pointer, retained PostgreSQL bytes | Rejected: external storage is inactive | Reads and verifies the exact object |
| Object pointer, no PostgreSQL bytes | Rejected: external storage is inactive | Reads and verifies the exact object |

The operator's `copy` phase sets the object pointer while retaining the original
database bytes. That is already a metadata transition, not an invisible staging
upload. A partial copy against the currently running PostgreSQL-mode service would
interrupt reads. Similarly, merely changing the mode back to PostgreSQL does not
perform a rollback.

Pause both Customer requests/writes and Platform resets before the first copy or
rollback batch. Keep both services unavailable to ordinary traffic throughout the
transition. Verify the pause and absence of active resets; a failed deployment
does not prove that Render stopped serving its previous live deployment. This
procedure does not introduce an online mixed-storage mode.

## Runtime configuration

Use the normal `npm run start:demo:customer` and `npm run start:demo:platform`
entrypoints. Do not run the loopback test fixture, application acceptance harness,
or `NODE_ENV=test` as the Hosted Demo server.

| Variable | Customer service | Platform service |
| --- | --- | --- |
| `DEMO_MEDIA_STORAGE` | `neon` after the accepted transition; absent or `postgres` before it | Same selected mode |
| `DEMO_MEDIA_STORAGE_BRANCH_ID` | Independently verified live branch ID | Same branch ID |
| `DEMO_MEDIA_STORAGE_DATABASE_HOST` | Exact verified host already used by the Demo database URLs | Same verified host |
| `DEMO_CUSTOMER_MEDIA_STORAGE_ACCESS_KEY_ID` | Named Customer credential's full `token_id` | Must be absent or empty |
| `DEMO_CUSTOMER_MEDIA_STORAGE_SECRET_ACCESS_KEY` | Named Customer credential's `s3_secret_access_key` | Must be absent or empty |
| `DEMO_RESET_MEDIA_STORAGE_ACCESS_KEY_ID` | Must be absent or empty | Separate reset credential's full `token_id` |
| `DEMO_RESET_MEDIA_STORAGE_SECRET_ACCESS_KEY` | Must be absent or empty | Separate reset credential's `s3_secret_access_key` |

The endpoint is derived from the branch ID as
`https://<branch-id>.storage.c-5.eu-central-1.aws.neon.tech`; the region is fixed to
`eu-central-1` and the bucket to `conference-manager-media`. There is no arbitrary
endpoint, public URL, bucket selector or default AWS credential chain in this path.

Neon mode requires `NODE_ENV=demo`, verified database TLS, port 5432,
`conference_manager_demo_shared`, and the canonical per-surface Demo roles. Existing
credential exclusions, separate origins, session/CSRF secrets and reset identity
remain mandatory. Ordinary Platform persistence receives no storage port: only
its existing distinct reset-role path receives the reset adapter.

The database host/branch settings are independently supplied operator pins.
Comparing a URL to those pins cannot prove that a database endpoint belongs to a
Neon branch. Verify that relationship, the bucket's private access and each
credential's anchor/scopes through the provider control plane before configuration.
Create separate named Customer and reset credentials on the actual live branch,
with the required storage read/write scopes. Do not reuse a recovery-child,
ancestor/default or migration-operator credential.

Before SDK allocation or HTTP startup, the read-only startup guard verifies actual
database identity and storage-mode consistency of Room and Catalogue metadata.
Mixed/unbackfilled metadata prevents startup. This guard does not fetch all
provider objects and is not a substitute for the cutover's complete byte/digest
verification. Provider/driver startup failures use fixed safe error codes. Adapter
resources are released on startup failure and shutdown.

Unselected nonempty storage settings and credentials are rejected. Empty values
are treated as absent, so an operator can safely clear the Neon keys when reverting
to PostgreSQL without retrieving or replacing unrelated Render secrets.

## Preconditions before pausing the live Demo

1. Accept the runtime-wiring PR with all normal quality, security, PostgreSQL and
   four browser/storage CI rows. Bind the exact API and immutable frontend/acceptance
   versions to the planned deployment.
2. Confirm usable protected recovery Secrets/Variables and workflow-dispatch access
   before provisioning the approved child/compute. Then complete the
   [restored-pair acceptance](NEON-PAIRED-RECOVERY-ACCEPTANCE.md) on that disposable
   child. Retain the actual four-role preflight,
   exact restored objects, both complete browser contracts and verified PostgreSQL
   rollback. Retain real missing/corrupt-object, failed-rollback and historical
   Room reattachment/read evidence from its mandatory `faults` phase. That phase
   must precede the unchanged browser contracts and positive rollback; native or
   PostgreSQL fixture checks alone are not a real-provider execution result.
3. Revoke temporary exercise credentials and remove temporary Actions secrets;
   dispose of the authorized child/compute. Preserve the protected restored and
   independent backup baselines and their retained evidence.
4. Independently inspect the current live database, complete current/historical
   media references, private bucket and exact Neon database-to-storage branch
   relationship. The 34 canonical seed files do not replace an inventory of live
   changes made since the seed. Retain a consistent database/object recovery basis.
5. Prepare the distinct runtime/reset and operator credentials through protected
   settings, and verify a usable execution path for the bounded operator batches,
   coordinated service pause/resume and exact-version deployment. Do this before
   interrupting the live Demo.

## Draft application traffic gate: preparation, not cutover approval

The Demo entrypoints support an application gate for the existing two Render Free
services. This gate does not replace accepted real-provider paired recovery,
required CI/browser rows, current live inventory or explicit deployment evidence.
It does not activate provider maintenance mode, create a service or change a plan.
The full protected Hosted browser adapter and its secret-leak verification remain
required before the `acceptance` mode can be used operationally.

| Setting | Contract |
| --- | --- |
| `DEMO_TRAFFIC_MODE` | Absent means `open`; exact values are `open`, `closed`, `acceptance` |
| `DEMO_CUSTOMER_ACCEPTANCE_TOKEN` | Customer service only; independent random 32 bytes encoded as 64 lowercase hex characters |
| `DEMO_PLATFORM_ACCEPTANCE_TOKEN` | Platform service only; separate independent token in the same format |
| `DEMO_TRAFFIC_ACCEPTANCE_EXPIRES_AT` | Acceptance only; absolute UTC ISO timestamp including milliseconds, at most 60 minutes ahead at startup |

Nonempty unused settings, another surface's token, unknown `DEMO_TRAFFIC_*`
settings, malformed deadlines and aliases of configured application/storage/DB
secrets prevent startup. An already expired deadline starts closed; restarting
cannot extend the same absolute deadline. Remove acceptance tokens and deadline
when selecting `open` or `closed`. Do not extend an acceptance window to rescue a
failed run. Any subsequent exercise needs its own independently accepted basis.

`closed` validates the ordinary pure Demo and media configuration before opening
only a bounded HTTP listener. It constructs no active composition, database pool,
storage SDK, static-file adapter or projection worker, and therefore can start
while the database is in a mixed-pointer transition state. Opening or entering
acceptance retains every existing actual database identity, role, sentinel, seed,
media-mode and composition readiness check. There is no startup migration.

All static files, APIs and resets return 503 while closed. The exact existing
liveness GET remains available; ordinary application readiness remains 503. The
new exact GET paths `/api/v1/health/deploy` and
`/api/v1/platform/health/deploy` report deployment readiness without database
initialization only when closed. In `open` and `acceptance`, these strictly
bodyless exact GETs dispatch to the existing normal application readiness route,
including its dependency checks and 503 failures; no acceptance token is needed
for this health-only path. A closed 200 is not business readiness. At expiry, ordinary traffic closes immediately and deployment health is 503 while
active resources drain. A successful complete stop permits a closed listener and
a green deployment probe. Failed or hanging stops terminate the process after at
most the 10-second shutdown watchdog; no closed-ready claim follows failed stop.
Expiry during unfinished active bootstrap terminates the process because startup
has not yet returned a safely stoppable runtime. Expiry never selects `open`.

Acceptance requires exactly one `X-CM-Demo-Acceptance` request header. The gate
checks its fixed-length token with `timingSafeEqual` and removes it from parsed,
distinct and raw request headers before normal application handling. It grants
no identity, role, Tenant, session or CSRF privilege. The ordinary principal and
Same-Origin requirements remain authoritative, including Platform's required
Origin on unsafe requests. A correct gate token cannot make a cross-origin
request valid. Host and request-target bounds apply to closed probes as well.

A protected browser adapter must add the appropriate token only to requests whose
origin exactly equals that surface's independently verified HTTPS origin. Do not
use global browser extra headers, URL parameters, cookies, local storage or a
frontend configuration bundle. Preserve real browser session/persona switching,
CSRF, foreign-Tenant and cross-origin negative assertions. Headers must not enter
traces, HAR files, diagnostic request dumps or uploaded artifacts. The application
strip alone cannot sanitize browser or intermediary artifacts. Existing immutable
browser assertions and the three-customer/two-reset contract must remain intact;
a test fixture or partial native probe is not this missing Hosted acceptance.

### Required Render setting and deployment order

The connected Render tools cannot update a web service's health-check path or
pin a trigger-deploy call to an arbitrary commit. The required operator setting is
the **Health Check Path** in each existing service's Render Dashboard: select its
new `/health/deploy` path above after the accepted gate binary is already installed.
Record both actual deploy commit IDs; a selected repository branch or successful
trigger request is not evidence of the deployed commit. No tariff/topology change
is required. Provider maintenance mode is unavailable on these Free services.

1. Before any pointer mutation, accept this gate and all existing CI/security/DB
   and four browser rows. While the current database remains consistently in
   PostgreSQL mode, install the exact accepted gate binary on both services in
   `open` mode using the existing readiness paths. Confirm each actual live SHA.
2. Set both Dashboard Health Check Paths to their new deployment paths. Verify the
   probes on the installed binary, then save `DEMO_TRAFFIC_MODE=closed` and deploy
   both surfaces. Keep normal PostgreSQL storage configuration at this stage.
3. Verify both closed deployments and ordinary 503 responses. Independently prove
   that Render has retired every previous active instance and that no previous
   request, reset or projection worker is still using the database. A green probe
   describes one new instance only: rolling deployment leaves an older instance
   alive temporarily. A failed deploy, 503 response or elapsed timer alone does
   not establish this coordinated pause. Retain provider retirement evidence and
   independent database activity evidence before starting any operator batch.
4. Only after all preceding cutover preconditions and quiescence evidence pass,
   perform the bounded forward or rollback work below. Keep both modes closed
   while changing storage configuration and deploying the accepted target binary.
5. After complete pairing/integrity checks, a separately verified protected Hosted
   browser adapter may enter `acceptance` on both surfaces with distinct tokens
   and the same short absolute end. Check actual deployments and authenticated
   normal readiness, then run every unchanged Hosted acceptance contract. A
   deadline or failed check closes the exercise; it does not reopen ordinary use.
6. Only accepted complete evidence permits an explicit deployment of `open` on
   both services, with acceptance settings cleared. On any failure, keep or
   explicitly deploy `closed`, retain evidence and follow verified rollback.

Primary Render references inspected 10 October 2026:
[deploy lifecycle](https://render.com/docs/deploys),
[health checks](https://render.com/docs/health-checks),
[maintenance mode](https://render.com/docs/maintenance-mode), and
[MCP capabilities](https://render.com/docs/mcp-server).

## Forward transition

1. Establish and verify the coordinated pause described above. Record the source
   deployment, database identity, inventory, backup/recovery references and selected
   target configuration. Keep the normal services in PostgreSQL mode until copying
   has fully completed; do not allow them to serve traffic during that interval.
2. Run the existing operator CLI using its separate maintenance-role database URL
   and exact live-branch storage settings. The complete operator environment contract
   is in [Private Object Storage](PRIVATE-OBJECT-STORAGE.md#operator-backfill-and-rollback).
   Execute bounded batches explicitly:

   ```sh
   node scripts/private-media-migration.mjs --execute copy room
   node scripts/private-media-migration.mjs --execute copy catalogue
   ```

   Retain each JSON result and repeat only incomplete work until both kinds report
   completion, then establish that no skipped/locked remainder exists through the
   independent metadata reconciliation below. A batch can see no unlocked candidates
   while another transaction still holds eligible rows. Each invocation is bounded; do not
   turn this into an unbounded startup hook or background migration. Each successful
   asset copy verifies MIME, length and digest before its pointer is published.
3. Independently reconcile all current pointers and required historical custody
   against the target objects. Verify exact MIME, byte lengths and SHA-256 contents,
   no remaining PostgreSQL-only rows, and retained database bytes for the copied
   revisions. A bucket count or successful command exit alone is insufficient.
4. Configure both normal entrypoints for the same accepted Neon pairing and deploy
   the exact accepted API version. The Customer adapter serves authorized media;
   the separate Platform reset adapter publishes object-backed canonical resets.
   Inspect actual deployed commit identities and both startup/readiness results.
5. Keep the acceptance window controlled while running the full immutable shared
   role/Tenant/CSRF and three-customer/two-reset browser contracts on the Hosted Demo.
   Verify authorized media GETs, conditional GET behavior, upload/replace, forbidden
   foreign-Tenant access and both object-backed resets. Retain exact workflow/source
   bindings and reports before reopening ordinary use.

## Failure and rollback

Keep the pause in effect if copying, verification, startup or acceptance fails.
A batch is atomic per asset, not across the complete media inventory. Successfully
copied earlier assets may already carry external pointers even when a later batch
fails. Inventory and database queries determine the actual state.

Use the same protected operator execution path for bounded rollback:

```sh
node scripts/private-media-migration.mjs --execute rollback room
node scripts/private-media-migration.mjs --execute rollback catalogue
```

Each rollback verifies the current provider revision, restores its database bytes
and clears its pointer atomically. Missing/corrupt provider contents leave that
asset's authoritative metadata unchanged and require recovery of the exact current
revision. Retained bytes from an earlier copy do not cover newer object-only
uploads or replacements; do not clear pointers manually or substitute stale bytes.

After both kinds finish, independently verify complete PostgreSQL byte/digest
integrity and absence of external pointers. Set both services to
`DEMO_MEDIA_STORAGE=postgres`, clear their Neon-specific settings/credentials, and
deploy the accepted PostgreSQL-mode runtime. Re-run the required Hosted Demo
acceptance before reopening use. The provider objects and inventory stay retained.

The ordinary `demo:db:reset` operator command is not a migration or rollback command.
It must not reset an object-backed database into PostgreSQL-only media. Use the
accepted object-aware Platform reset path after Neon activation.

## Separate follow-up work

Object activation does not authorize PostgreSQL blob purge, schema downgrade,
reference-blind deletion or changes to the 30-day orphan-retention policy. Purge
has its own evidence-digest contract and cannot be inferred from this runbook.

SaaS 3.8 telemetry, actual alert delivery, representative business/worker load and
attributable cost results remain open after storage activation where not yet
accepted. Keep Neon Launch in October, inspect Free eligibility after the November
counter reset, and retain the existing Render topology.

The available GitHub connector currently cannot write the protected recovery
Secrets/Variables or dispatch the manual workflow. The cancelled browser login is
not an authenticated execution path. Runtime code preparation does not remove this
operational boundary or establish that a live cutover has taken place.

Provider references inspected on 10 October 2026:
[Object Storage](https://neon.com/docs/storage/overview),
[Authentication](https://neon.com/docs/storage/authentication), and
[Render environment variables](https://render.com/docs/configure-environment-variables).
