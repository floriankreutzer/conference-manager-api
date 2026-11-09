# Automatic Jira PR readiness

## Temporary controlled manual gate (6 November 2026)

The owner accepted a temporary manual transition from `in Review` to
`Ready for Deployment` while the remaining CO-296 automation is implemented.
Before each transition, reconcile the complete issue-specific App/API scope,
explicitly retain supporting/superseded classifications, verify actual merges and
exact-commit required CI/security/review evidence, and record the reviewer, UTC
decision time and native evidence on the Jira work item. Recheck scope and status
immediately before transition. Missing or ambiguous evidence still blocks.

This supersedes the earlier prohibition of a manual interim operating mode.
It neither completes CO-296 nor waives its six native automation scenarios.
The unsafe automatic promotion rules remain disabled. Deployment and Product
Acceptance are separate gates; this procedure never authorizes `Done`.

## Approved register ownership (6 November 2026)

The owner approved an integration-maintained, versioned Jira PR register as the
authoritative association source. Jira's Development summary is corroborating
information, not the sole enumeration authority. This replaces the earlier
requirement to derive completeness from that index. It does not relax merge,
current-head CI/review, scope completeness or Product Acceptance requirements.

`scripts/jira-pr-register.mjs` proposes automatic register updates from complete,
fresh, authenticated App/API inventories. Exact issue keys in PR titles or source
branch names discover delivery obligations. Existing entries survive renaming;
missing historical PRs block. New PRs increment the version, repeated collections
are stable, and neither draft nor closed state can exclude a PR. Supporting and
superseded classifications require explicit authorized decisions and are retained.
No association means no closed scope. Automatic discovery covers the approved
App/API delivery repositories; additional delivery repositories require a reviewed
extension, never an implicit supporting classification.

This remains a pure proposal module. The journal and conditional publisher below
provide separate persistence/readback components; their protected provisioning,
native qualification and the transition composition are still required.
Its `closed` field means the proposed association is enumerated, not that delivery
is complete. The adapter must not authenticate its own input merely by copying
these output flags. No Jira register is written or automation activated by this module.

Tracking: CO-296. Automatic promotion is required; permanent manual promotion is
not the accepted target. The existing unsafe Jira rules stay disabled until the
complete integration and its native acceptance pass.

## Decision kernel

`scripts/jira-pr-readiness.mjs` is a pure, fail-closed decision kernel. It does not
fetch provider data, accept HTTP requests, publish evidence or change Jira issues.
It is not an executable release authority and must not be exposed as an endpoint
that accepts caller-supplied snapshots. Its fixtures are not live acceptance.

The trusted integration must supply a fresh snapshot covering both App and API,
an explicitly closed Jira change scope, complete authenticated inventories and
the exact associated PR set. Unknown, missing, stale, truncated or ambiguous
evidence blocks promotion. Draft, open and closed-unmerged PRs block promotion.
Supersession cannot be inferred just because a PR was closed; it requires an
authoritative scope revision which remains auditable in Jira.

Every PR requires the exact current head, merge commit, complete required-check
policy, successful checks bound to the expected producer app and head, and
completed head-bound review evidence with no unresolved findings or threads.
Formal approval counts and completed automated reviews are different evidence.
The owning repositories retain authority for their required policy; this module
does not hard-code or weaken their required check names or approval counts.

Only `in Review` can produce a `Ready for Deployment` decision. This kernel never
returns `Done`, performs a merge, or changes Product Acceptance. The independent
production deployment and Product Acceptance gate remains unchanged.

## Collection contracts and activation requirements

`scripts/jira-github-inventory.mjs` now supplies the transport-only first stage:
authenticated GET requests to the two fixed repositories, all PR states, bounded
pagination through an empty terminal page, a 45-second overall timeout and a
4 MiB response limit. Redirects, duplicate PR numbers, malformed records and
provider failures abort the whole collection without exposing provider errors.
It retains drafts and closed PRs instead of inferring that they were merged.
This is not an atomic GitHub snapshot: concurrent edits require independent final
recollection and scope reconciliation. `complete` means enumeration reached its
terminal page, not that Jira association, checks or review evidence are complete.
The manual `Jira GitHub Inventory Diagnostic` workflow calls this module only on
the owning repository's `main`. It mints a short-lived token from the existing
CI Reader App secrets, limited to pull-request read access in the two repositories.
It uses pinned actions, persists no checkout credential, runs without dependency
installation and retains only fixed repository names and counts in its log.
The token action revokes the token on cleanup. Failures produce a fixed error and
nonzero exit, never partial success. No PR titles, refs or provider payloads are
published, and no readiness or Jira mutation occurs. Dispatch after reviewed merge
is required to prove installed-token access; fixture tests alone do not prove it.

1. Bind the collector to the approved repositories and authenticated read-only
   provider access. Enumerate complete results with bounded pagination and verify
   schema, source identity and transport failures. No anonymous fallback.
2. Resolve the authoritative Jira scope and expected PR links. An omitted draft,
   incomplete development index or uncertain scope must not become an empty set.
3. Resolve required checks and review evidence from their owning sources, including
   producer identity, current head and all relevant pagination. Normalize attempts
   deliberately; never choose a historical green check over a newer pending one.
4. Serialize per issue, independently recheck scope, PRs and gates immediately
   before mutation, and persist the decision key with the transition result.
   An unchanged scope/head/policy set has a stable key. The kernel alone provides
   neither locking nor exactly-once delivery. Handle uncertain write outcomes by
   reading Jira before retrying, never by blindly repeating a transition.
5. Keep credentials in the approved secret store, exclude payloads and secrets
   from logs, and use fixed outbound destinations. No credential expansion or
   background workflow is activated by this source change.
6. Execute all six native CO-296 scenarios, including partial merges, final merge,
   missing index, closed-unmerged and Product Acceptance negatives. Include stale
   observations, authentication/pagination failures and duplicate delivery.

No customer HTTP/API, migration, tenant or deployed application contract changes.
The separate operator journal migrations and transition composition are described
below. Local kernel tests establish only decision behavior. Native qualification,
automatic invocation and operational acceptance remain activation requirements.
The temporary manual gate above does not qualify automation.

## Explicit scope reconciliation

`scripts/jira-pr-scope.mjs` compares a versioned, closed scope with a complete,
non-stale issue association. Every linked PR must be classified exactly once as
`delivery`, `supporting` (with reason), or `superseded` (with reason and a direct
replacement in the delivery set). Unknown/missing links, duplicates, foreign
repository delivery and unresolved supersession fail closed. Supporting PRs remain
part of the scope revision but are not evaluated as application delivery.

This is pure reconciliation, not an authenticated scope reader. Its inputs must
come from the trusted Jira adapter and an authorized scope-maintenance path; no
caller-supplied `complete`, `closed` or `stale` flag confers authority. The revision
is a deterministic content identifier, not a signature. The source adapter,
concurrency enforcement and native acceptance remain required before activation.

## Jira read transport and credential diagnostic

`scripts/jira-register-reader.mjs` reads the configured CO issue and its
`cm.delivery.pr-register.v1` property through the fixed Atlassian API origin.
The scoped API token, account email and validated cloud ID come from protected
runner configuration. It allows only GET, rejects redirects and foreign issue/
project identities, bounds responses to 256 KiB and the total read to 15 seconds,
and emits fixed errors without credentials or provider payloads. A missing
property means enrollment is required, never a complete empty delivery scope.

The manual main-only `Jira Register Diagnostic` workflow requires repository
variable `CM_JIRA_CLOUD_ID` and secrets `CM_JIRA_READINESS_EMAIL` and
`CM_JIRA_READINESS_API_TOKEN`. It reports only read success/enrollment-needed
booleans, performs no mutation, and accepts the issue key through an environment
variable rather than shell interpolation. A successful diagnostic proves token
read access only. It does not prove writer provenance, write scopes, locking,
transition safety or operational acceptance. Issue properties are editable by
principals with issue-edit permissions; authenticated reads alone cannot certify
which integration wrote the value. Those remaining boundaries must be resolved
before a property can authorize promotion.

## GitHub check and review evidence

`scripts/jira-github-gates.mjs` reads one App/API PR and its effective main-branch
rules, all head check runs, formal reviews, authenticated Codex summary and all
review threads. It binds required contexts to their producer App IDs and selects
the highest check-run ID for each context/producer; a newer pending or failed run
does not inherit an older success. Lists reach an empty terminal page (check-run
totals must agree); GraphQL thread cursors must finish without repeats or errors.
PR identity and policy are independently read again before returning evidence.

The supported profile is the current ruleset-only main policy with zero required
human approvals and no code-owner/last-push approval requirement. Classic branch
protection, a new unsupported rule or approval profile, missing producer identity,
ambiguous review summary or source drift blocks collection. Formal approval counts
remain distinct from the current-head Codex review. Pending/unresolved/failed
evidence is retained as blocking evidence, never relabeled successful. The existing
readiness kernel remains responsible for the final decision. This transport does
not establish Jira scope, property provenance, replay protection or serialization.

The manual main-only `Jira GitHub Gates Diagnostic` uses the existing CI Reader App
with read-only pull-request, check and content permissions limited to both delivery
repositories. Token creation must fail if the installation lacks a requested read
permission; no permission upgrade or anonymous fallback is performed. It logs only
counts and booleans, installs no dependencies and never writes Jira or changes PRs.
Its bounded GitHub GraphQL POST contains only a fixed read query. Native execution
after reviewed merge is required to establish installed access; local fixtures are
not live acceptance. Transport is limited to 45 seconds and 4 MiB per response.

## Composed issue diagnostic

`scripts/jira-readiness-diagnostic.mjs` composes the existing Jira reader, complete
App/API inventories, register proposal, per-PR gate collector and decision kernel.
It independently repeats Jira, inventory and gate reads. A changed issue identity,
status, update timestamp, register, inventory, head, policy, check result or review
blocks the entire diagnostic. New obligations are discovered even when the stored
register omits them; existing classifications and renamed obligations are retained.
There is no automatic supersession or supporting classification.

The complete operation has a 55-second deadline, 512-request and 64-MiB aggregate
response budget, at most 20 delivery PRs and two concurrent per-PR collections.
Existing per-provider pagination/response limits also apply. Exceeding a bound,
missing evidence or any provider failure produces a fixed redacted error and exit
1, never partial success or a mutation. The manual main-only workflow reuses the
existing credentials, installs no dependencies and emits only counts, booleans and
fixed result codes. All data requests are GET except the existing fixed read-only
GitHub GraphQL query. No new credential, grant or recurring trigger is introduced.

`candidateGateResult` evaluates only the hypothetical proposed scope. Even
`CANDIDATE_GATES_PASS` is **not** a readiness authorization: enrollment and register
updates may still be needed, classifications are not authenticated as authorized
decisions, and writer provenance is not established. Every result explicitly has
`registerProvenanceVerified=false`, `readinessAuthorized=false` and
`mutationPerformed=false`. No decision key or transition target is exported.
Do not consume this diagnostic as a Jira promotion condition. Two stable reads
also do not establish an atomic cross-provider snapshot or prevent later changes.

The journal and conditional publisher below are separate from this diagnostic.
Protected writer provisioning/qualification, automatic invocation and all six
actual Jira automation acceptance scenarios remain required. The transition
composition below adds serialization and recovery; its source tests do not replace
native qualification. The controlled manual operating gate stays
in effect. Native execution after reviewed merge qualifies this composition's
installed read access only, not those remaining write/automation boundaries.

## Durable register journal foundation

`scripts/jira-register-journal.mjs` supplies a separate PostgreSQL adapter for the
register writer's recovery checkpoint. Jira remains the authoritative association
register; this journal anchors the exact value the trusted integration intended
to publish and later independently read back. It is not a second backlog or a
replacement for GitHub collection. No application root imports this adapter.

The explicit operational migration `scripts/sql/jira-register-journal-v1.sql`
creates the isolated `cm_delivery` schema. It is not part of application startup
or the customer migration chain. Provisioning must use a separate schema owner
and a dedicated integration login, with schema USAGE, table SELECT/INSERT, and
UPDATE restricted to `state` and `confirmed_at`. Do not give that login ownership,
DDL, DELETE or UPDATE on scope/digest/version; do not grant any access to PUBLIC,
customer/runtime roles or Jira editors. Use the existing PostgreSQL infrastructure
with validated TLS and a bounded dedicated pool, never a customer database secret
in a workflow. No database role, credential, live schema or paid resource is created
by importing this source. A second execution of the migration fails deliberately;
there is no destructive rollback. Preserve journal rows when deactivating it.

Preparation commits a `pending` intent before any external write. New enrollment
requires version one and delivery-only obligations; unauthenticated exceptions
cannot acquire provenance through enrollment. Automatic updates only add delivery
obligations, retain every old entry exactly, increment one version and compare
the previously confirmed digest. Reclassification still requires its separately
authorized implementation. Per-cloud/per-issue transaction locks serialize even
first enrollment. SQL/lock timeouts are bounded, values are parameterized, errors
are redacted and pending intents survive process restart. Canonical JSON uses a
closed schema and a 32-KiB UTF-8 limit; key/entry ordering cannot change its digest.

Confirmation requires the independently observed Jira value to match the latest
intent exactly. An older correctly formed value, wrong issue ID, different scope
or competing update fails closed. Duplicate preparation/confirmation is stable.
An unknown database commit outcome requires a fresh read; an error does not prove
that nothing committed. The hash alone is not a signature or authorization: its
trusted database checkpoint and isolated writer identity establish the boundary.

This adapter does **not** collect GitHub, write Jira, authenticate a supplied
observation, serialize an external HTTP request, or perform a transition. Its
transaction lock ends before a caller can use the returned value. The conditional
publisher below supplies register dispatch claims, recollection and readback;
the transition composition below supplies its own serialized final checks and
deduplication/recovery. Ambiguous external outcomes stay quarantined. Never retry a
Jira PUT/transition merely because preparation returned an existing pending intent.
Native six-scenario automation acceptance and protected runtime provisioning remain
activation requirements. No workflow trigger or readiness flag is enabled here.

## Conditional register publisher

`scripts/jira-register-publisher.mjs` composes authenticated Jira and complete
App/API inventory reads with the journal and a conditional Jira property writer.
It accepts no caller-provided scope. Two independent collections must agree before
the integration prepares a new register. Existing confirmed Jira content must
match the trusted checkpoint; unanchored properties, missing obligations or drift
block. Draft/open PRs remain delivery obligations. Registration is not readiness.

Apply `scripts/sql/jira-register-write-receipts-v2.sql` after the v1 operational
migration. Grant the isolated integration role SELECT/INSERT and UPDATE(task_id)
on this additional table only. Preparation with `claimWrite=true` atomically
records the pending register and one dispatch claim. Only its fresh creator gets
permission to submit the request; duplicates and uncertain database commits do
not acquire another claim. A missing v2 table rolls back the entire preparation.
The resulting task identity is durable, cannot be replaced by another task and
cannot be reused for another issue/version in the same cloud.

The transport uses Jira's conditional bulk-property operation with exactly one
issue ID and either `hasProperty=false` or `hasProperty=true` plus the exact
`currentValue`. It never submits an unfiltered operation or an unconditional
single-issue overwrite. A 303 response establishes an asynchronous task, not a
successful property update. Its Location URL is never followed: only a bounded
task ID is extracted and read through the fixed gateway for the same cloud.
Task COMPLETE must be followed by exact property readback before confirmation.
See the owning [Jira property contract](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-properties/)
and [task contract](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-tasks/).
The provider-side eligibility filter is used as documented; this is not a claim
of an atomic cross-provider Jira/GitHub snapshot.

Recovery observes a previously recorded task without resubmitting the mutation.
Queued/running tasks return pending. An unknown submission with no durable task
receipt remains quarantined even when the desired property is visible; it needs
explicit operator reconciliation. Failed, cancelled, unavailable or conflicting
task/readback evidence never confirms the journal. No automatic retry, cancellation,
cleanup deletion, supporting/superseded reclassification or status transition is
implemented. A pending task needs a later invocation; no recurring trigger is
installed by this source. The controlled manual readiness gate remains current.

HTTP work has a 55-second cancellation budget, 128 requests and 32 MiB, with
the existing per-provider limits and a 15-second write/observation transport bound.
The injected operator pool must retain validated TLS and bounded connection/query
timeouts. In-flight SQL settles under its own timeouts; cancellation does not prove
that it rolled back. A deadline exceeded during SQL cannot return success or start
new HTTP work. Public results contain fixed codes, `writeSubmitted` for this invocation
and `readinessAuthorized=false`; a submitted task may still be pending. Errors
are redacted and deliberately do not claim that nothing was submitted or committed.

No application root invokes this publisher. The manual runner below is a separate
integration entry point. Protected provisioning, installed write/task-read scopes, native conditional-write
and fault recovery qualification, transition deduplication, automatic invocation
and all six native readiness scenarios remain required before activation. Fixtures
and database tests are not a native Jira acceptance claim.

## Protected manual publisher entry point

`Jira Register Publisher` invokes `scripts/jira-register-publish.mjs` only through
manual dispatch on this repository's `main`, in `jira-readiness-writer`. No schedule,
PR event, transition or automatic retry is installed. Runs serialize without
cancelling a previous writer. Pinned actions install locked dependencies without
lifecycle scripts before any writer credentials enter a process. The existing
Reader App creates a short-lived token with only pull-request read access to the
two delivery repositories; its permissions are not expanded.

Provision the actual GitHub environment with exactly the `main` branch, no tags
and no administrator bypass. Verify the policy independently before credentials
are installed; a workflow environment name is not proof of that protection.
Use only these dedicated environment secrets, with no repository/organization
fallback copies: `CM_JIRA_REGISTER_DATABASE_URL`, `CM_JIRA_WRITER_EMAIL`, and
`CM_JIRA_WRITER_API_TOKEN`. The existing read diagnostic credentials are not writer
credentials and must not be widened. The token needs the installed issue/property
read, conditional-property write and own-task read access required by the provider
contracts; a successful read diagnostic alone does not qualify those scopes.

The environment variables are `CM_JIRA_CLOUD_ID`,
`CM_JIRA_REGISTER_DATABASE_HOST` (the exact approved Neon endpoint hostname) and
`CM_JIRA_REGISTER_WRITER_ENABLED`. Leave the enabled variable absent until the
operational schema, dedicated login, secret placement and native qualification
plan are ready. Only literal `true` enables an explicit manual invocation.

The database URL must use `postgresql`, role `cm_jira_register_writer`, database
`conference_manager_demo_shared`, the exact configured Neon AWS host, default
port or 5432, and only `sslmode=verify-full`. Only direct endpoints are supported:
Neon hostnames whose endpoint label ends in `-pooler` are rejected before connecting,
even when both configured host and URL match. Transaction pooling cannot preserve
the session advisory lock across independent transactions and HTTP operations.
See the [Neon pooling contract](https://neon.com/docs/connect/connection-pooling#connection-pooling-in-transaction-mode).
The runner removes URL options before
passing an explicit verified TLS policy to pg. Its pool has at most two connections
and bounded connection, statement and query timeouts. Initial identity checks reject
foreign databases/users, superuser, role/database creation, RLS bypass and inherited
roles. These checks do not establish the complete schema ACL: provision and verify
the narrow grants documented above, separate ownership and absence of customer-data
access independently. There is no implicit migration or customer-credential fallback.

Idle database errors cancel outbound work; connection, publisher, cleanup and
output failures cannot report success. Logs contain fixed result codes and booleans
only, without connection strings, Jira payloads or a false no-write assertion on
failure. A pending task requires a later manual invocation which observes its
durable receipt. Unknown submissions remain quarantined. A green publisher run
never grants readiness or Product Acceptance; native six-case automation acceptance
and the transition/event integration remain separate unfinished work.

## Serialized one-shot readiness transition

`scripts/jira-readiness-promoter.mjs` is a trusted integration composition, not an
HTTP endpoint. It accepts no readiness snapshot from a client. The existing
diagnostic and promoter share `jira-readiness-collection.mjs`; the diagnostic
still reports candidate evidence only and never grants mutation authority.

Both register publication and promotion retain the same per-cloud/per-issue
PostgreSQL session advisory lock through collection, journal transactions and
outbound mutation. Nested journal transactions borrow that physical connection.
A busy lock fails without collection. Connection loss aborts outbound work and the
connection is destroyed on exit, never returned with session state to the pool.
The two manual workflows also share a non-cancelling concurrency group. These
locks serialize this integration; they cannot prevent human or provider changes
outside it and do not establish an atomic Jira/GitHub snapshot.

Apply `scripts/sql/jira-transition-journal-v3.sql` explicitly after v1 and v2,
under the existing isolated schema owner. Grant the dedicated writer SELECT,
INSERT and UPDATE(`state`, `history_id`, `confirmed_at`) on
`cm_delivery.transition_journal` only. Do not grant UPDATE on intent identity,
DELETE, DDL, ownership, role membership or customer-table access. There is no
startup migration or destructive rollback. Disabling the writer preserves all
records for recovery. A repeated migration fails instead of replacing evidence.

Promotion requires the current property to equal the latest confirmed journal
value, two complete current GitHub gate passes, final issue/inventory recollection,
an unchanged scope and a fresh kernel decision. The raw Jira transitions response
must expose exactly one available, non-global, screenless transition from the
current source status to the **status** `Ready for Deployment`, with no mandatory
fields. The transition's display name is not its target status. Missing global/
availability metadata or an unsupported workflow blocks instead of guessing.
The transition contract and source status are independently read again before
the claim. See the owning [Jira issue transition and changelog contract](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/).

Before one POST, a transaction commits a pending claim binding issue identity,
stable decision key, register version/digest, random attempt ID, configured writer
account ID, transition and source/target status IDs. Only a newly committed claim
authorizes submission. One pending claim per issue and unique decision/receipt
identities prevent concurrent or restarted callers from acquiring another dispatch.
The kernel freshness check is repeated after the database commit. An unchanged
scope/head/policy decision is never resubmitted, including after a human returns
the issue to `in Review`.

The POST includes a bounded history-metadata marker for that exact attempt.
HTTP 204 alone does not confirm the journal. Confirmation requires complete,
bounded Jira changelog enumeration with one matching marker, the actual changelog
author matching the configured writer, the exact from/to IDs and a plausible
provider timestamp. Current status alone is never a receipt. Recovery checks the
pending claim **before** the current-status filter, so a prior successful POST
remains recoverable after the issue has left `in Review`. A scheduler must likewise
include pending journal work independently of its new-candidate status query.

An ambiguous database COMMIT or POST never authorizes retry. A later invocation
only observes the original attempt. Missing, conflicting, truncated or unavailable
history leaves it pending or fails closed; it requires operator reconciliation,
not deletion, automatic replay or an inferred success. The bounded history window
is 1,000 entries; exceeding it requires explicit investigation rather than partial
enumeration. The promoter is limited to 90 seconds, 600 requests and 72 MiB; the
collector's tighter existing limits still apply. Logs expose fixed outcomes and
booleans only. Failure output intentionally makes no assertion that no write occurred.

Changelog reads start at 100 entries per page. A page exceeding the unchanged
256 KiB response limit is cancelled and fetched again at the same offset with
half as many entries, down to one. Smaller pages remain in effect for the rest
of the enumeration; description edits can contain large old/new values even
when the status receipt itself is small. Only this bounded read-size failure is
retried, never authorization, malformed JSON, transport failures or a transition
POST. Recovery allows 60 seconds for the complete history observation, including
its initial register read, while every history GET remains bounded to 15 seconds
through response-body consumption. Transition resolution and the one-shot POST
retain their existing 15-second budgets; the enclosing promoter retains its
90-second total deadline. The 1,000-entry ceiling, complete stable-total/duplicate/
receipt validation and cap of 100 changelog requests including reductions remain.
An oversized single entry or exhausted budget remains unverified and leaves the
original claim intact for investigation.

The manual runner may append a closed `historyObservation` diagnostic containing
only a fixed phase/outcome, monotonic elapsed milliseconds and bounded request/
entry counts. It contains no issue content, identifiers, provider response or
credentials. It is collection telemetry, not proof of a committed confirmation:
the owning result and independent journal/history readback remain authoritative.
Failures outside history observation retain the existing fixed error-only output.

## Protected transition qualification runner

`Jira Readiness Writer` runs only by manual dispatch on protected `main`, using the
existing `jira-readiness-writer` environment and dedicated secrets. It reconciles
the register before promotion, waits for a confirmed register, and never changes
Product Acceptance, `Done`, deployments or merges. The existing Reader App token
is limited to pull-request/check/content reads in the two delivery repositories.
No credential permission expansion, schedule or PR-triggered privileged execution
is introduced by this entry point. No writer credentials enter dependency installation.

In addition to the existing cloud/database configuration, explicitly configure
`CM_JIRA_WRITER_ACCOUNT_ID` to the authenticated writer's actual account ID and
`CM_JIRA_TRANSITION_WRITER_ENABLED=true` for an authorized qualification run.
The transition flag authorizes both register reconciliation and the one-shot
transition; it is independent of the manual register publisher's enable flag.
Absent, malformed or non-literal activation fails before connecting. The database
identity/TLS restrictions are shared with the existing publisher. Native token
access to transitions and changelog metadata must be proven, not inferred from
successful property writes.

The optional manual `defer_confirmation=true` input leaves a submitted transition
pending deliberately. The next invocation must recover its original native
history without a second POST; it cannot use this flag to resubmit an existing
claim. This qualifies restart behavior without changing the normal decision gates.

Source, fixture and real PostgreSQL tests prove only their executed contracts.
Activation still requires all six CO-296 native scenarios, installed workflow/
actor/transition metadata, real duplicate/restart evidence and an independently
qualified automatic trigger that also discovers pending journal work. The manual
qualification runner does not itself complete the automatic-promotion requirement.

## Bounded automatic catch-up and recovery

`Jira Readiness Sweep` supplies a separate hourly main-only entry point at minute
23, plus an explicit manual dispatch for operational qualification. Both
`CM_JIRA_READINESS_AUTOMATION_ENABLED` and `CM_JIRA_TRANSITION_WRITER_ENABLED`
must be literal `true`. Until then it reports `JIRA_READINESS_AUTOMATION_DISABLED`
and skips dependency installation, App-token creation and the credential-bearing
writer step. Its protected environment, pinned actions, read-only GitHub token,
direct verified-TLS database connection and shared non-cancelling concurrency
group are the same as the qualification runner. There is no privileged PR or
`workflow_run` trigger and no event payload can supply a snapshot or select a ref.

`jira-readiness-candidates.mjs` performs authenticated enhanced JQL search for
CO work items currently in `in Review`, with a fixed query and minimum fields.
It follows every cursor to a terminal page, rejects duplicate/foreign/malformed
records, warnings and cursor loops, and bounds discovery to 20 pages of 50 items,
256 KiB per page and 15 seconds. Search is eventually consistent and discovers
candidates only; it never proves association, readiness or absence of obligations.
Every selected issue passes the existing fresh register and gate composition.
See the [Jira enhanced search contract](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/).

Apply `scripts/sql/jira-readiness-sweep-v4.sql` explicitly under the isolated owner
after v3. Grant the existing writer SELECT/INSERT and
UPDATE(`last_issue_key`, `updated_at`) on `cm_delivery.readiness_sweep_cursor`.
No DELETE, ownership, DDL, cloud-ID update or customer-table grant is required.
This single cursor per cloud is scheduling metadata, not a copy of the Jira backlog,
a readiness receipt or permission to retry a mutation. It is retained on disable.

The PostgreSQL selector unions discovered candidates with **all pending register
and transition journal work**, independently of the issue's present Jira status.
A transition already applied remotely is therefore still discoverable for receipt
recovery after it leaves `in Review`. The union is capped at 1,000 issues. A
transactional per-cloud scheduling lock and persisted numeric issue-key cursor
select at most five issues in rotation. Persistent blocked/pending issues cannot
monopolize the first page of a stable queue; concurrent selections do not repeatedly
take its same first batch. The cursor commits before processing, so an interruption
may defer that batch until rotation returns. It never grants dispatch authority;
the existing per-issue lock and one-shot journal still govern every execution.

The runner processes the selected issues sequentially within 12 minutes and a
15-minute job cap. One unverified issue produces a minimized error receipt while
the remaining selected issues continue; any such error makes the run fail as
`JIRA_READINESS_SWEEP_PARTIAL`. Connection loss/deadline/cleanup uncertainty cannot
report completion. Logs contain only bounded CO keys, fixed result/phase codes,
counts and booleans, never titles, source payloads, credentials or a false no-write claim
on error. No association, incomplete gates or unsupported data never promote.
An empty candidate/recovery queue means no work was selected, not that delivery
or Product Acceptance is complete.

Each unverified issue receipt includes a fixed `failurePhase`: `register` or
`promotion` identifies the stage reached by the shared trusted composition;
`reconciliation` means it failed before a stage was observed; `receipt` identifies
invalid returned result data; `diagnostic` identifies a rejected observation.
These markers locate where failure surfaced, not its underlying cause or whether
an external write occurred. When the transition history reader emits an observation,
the receipt also includes its separately validated `historyObservation` (`phase`, `outcome`,
`requests`, `entries`, `elapsedMs`). The runner snapshots only those bounded fields
for that issue, on both successful and failed paths. A matched history observation
does not replace the journal confirmation or make an unverified result successful.
Error receipts never contain transition booleans. These diagnostics do not change
the history budgets, timeouts, decision gates, one-shot claims or recovery rules.

This is best-effort catch-up, with no guaranteed response time. Delayed/missed
schedules, provider failures, changing candidate sets and quarantined unknown
writes remain visible operational conditions. Diagnose a failing issue with its
manual runner and original journal/history; do not clear a claim or replay its
POST. No paid infrastructure, runner quota increase or new credential permission
is needed. Disabling the automation flag stops recurring writes; disable both
writer flags as well to stop the separately authorized manual entry points.

Enable recurring writes only after the reviewed source and separate Main checks,
v3/v4 grants, actor/workflow metadata, all six native CO-296 scenarios and real
duplicate/restart recovery pass. A manual sweep qualifies the same execution path
but is not proof that a scheduled event ran; retain an actual `schedule` receipt
separately. The older unsafe Jira promotion rules remain disabled. This integration
never completes Product Acceptance, transitions to `Done`, merges or deploys.
