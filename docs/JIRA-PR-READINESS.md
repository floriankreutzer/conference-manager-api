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

This is currently a pure proposal module. Trusted Jira persistence, provenance,
serialized read/compare/write and independent final recollection are still required.
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

## Integration still required before activation

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

No HTTP/API, database, migration, tenant or deployed application contract changes.
Local kernel tests establish only decision behavior. Native collection, secret
custody, serialized transition, workflow triggers and operational acceptance remain
open integration work. The temporary manual gate above does not qualify automation.

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

Trusted register persistence/provenance/replay controls, serialized final recheck
and transition recovery, automatic invocation and all six actual Jira automation
acceptance scenarios remain required. The controlled manual operating gate stays
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
transaction lock ends before a caller can use the returned value. The eventual
single-writer composition must independently collect inputs, retain serialization
across its final checks and writes, compare Jira readback, quarantine ambiguous
external outcomes, and implement transition deduplication/recovery. Never retry a
Jira PUT/transition merely because preparation returned an existing pending intent.
Native six-scenario automation acceptance and protected runtime provisioning remain
activation requirements. No workflow trigger or readiness flag is enabled here.
