# Automatic Jira PR readiness

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
open integration work, not an alternative manual operating model.

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
