# Protected Operations source registers

Tracking: application #319 extends #298. This is an internal, low-concurrency Demo
operator source. Real Pilot observations remain #316. Before customer-facing or
multi-operator transactional feedback, move authoritative structured persistence to
PostgreSQL; Object Storage remains suitable for attachments and exports.

## Separation and contracts

The existing private Frankfurt Neon bucket is reused. Automatic collection retains
its independent `operations/metrics/daily-v1.json` object and original contract.
Only these two additional exact keys are admitted by the source adapter:

| Kind | Key | Source |
| --- | --- | --- |
| manual | `operations/metrics/manual-v1.json` | Existing Product/Delivery compiler input, with feedback unconfigured |
| feedback | `operations/feedback/register-v1.json` | Closed minimized feedback source |

Each envelope contains exactly `schemaVersion: 1`, `environment: "demo"`, `kind`,
opaque `operatorId`, server-generated `recordedAt`, and `source`. Manual source
facts use the existing compiler's complete closed input contract and all existing
count/clock/integrity limits. Feedback source contains exactly `observedAt`,
`periodStart`, `periodEnd`, `feedbackSource`, `feedbackComplete`, `feedback`.
Feedback records retain exactly the existing eight closed fields, at most 200
records. Identities, emails, URLs, unrestricted text, arbitrary metadata and KPI
values are rejected. The operator ID is an opaque custody label, not a person name
or a new identity provider. The compiler remains the only KPI calculation owner.

Source clocks use exact UTC milliseconds. Writes require a source observation no
older than 24 hours and no later than the server recording time. Record clocks and
28-day windows retain their existing compiler semantics. Missing facts and
incomplete coverage stay null. A first empty feedback register cannot be written as
historically complete. No initial register is evidence of actual Pilot feedback.

## Conditional writes and operator workflow

Provider preconditions were independently exercised on a separate synthetic exact
key on 2026-10-15: initial `If-None-Match: *` PUT returned 200; its duplicate and a
wrong `If-Match` returned 412; a correct `If-Match` update returned 200; reusing the
old version returned 412. The synthetic object was then removed. This is evidence
for this existing branch/provider, not a guarantee about arbitrary S3 providers.
Do not enable writes on an unverified provider. Bucket versioning/lifecycle settings
are not substitutes for conditional update and application retention enforcement.

`scripts/operations-source.mjs` is the protected server-side operator workflow. It
does not create a browser mutation endpoint. Run only in an owner-authorized
protected environment; keep source input/output files private (`umask 077`). Supply
branch-bound server credentials through protected configuration:

- `OPERATIONS_SOURCE_BRANCH_ID`
- `OPERATIONS_SOURCE_ACCESS_KEY_ID` / `OPERATIONS_SOURCE_SECRET_ACCESS_KEY`
- `OPERATIONS_SOURCE_OPERATOR_ID` (opaque custody label)
- `OPERATIONS_SOURCE_WRITE_ENABLED=true` only for an intentional write command

The read command uses a `storage:read` credential. Writes use a separately held
short-lived `storage:write` credential, which the provider grants branch-wide;
there is no provider-enforced key-level IAM claim. The adapter confines operations
to the two exact keys and exposes no list/delete/media method. Revoke ephemeral
write credentials after use. Never install them in the HTTP process or browser.

```sh
node scripts/operations-source.mjs read feedback > protected-current.json
node scripts/operations-source.mjs write feedback < protected-write.json
```

Write input is exactly `{ "expectedVersion": null, "source": { ... } }` for an
absent object; for an update, supply the exact quoted provider ETag returned by the
read. Never interpret a read failure as absence. Validation precedes PUT. A stale
version returns `OPERATIONS_SOURCE_CONFLICT`; re-read, reconcile the source facts
and deliberately retry. Identical source submission returns the existing version
and digest without a write or observation-clock refresh. There are no blind retries.
A network timeout has an unknown write outcome: read back the exact key and compare
the deterministic source digest before retrying. Validation/precondition failures
cannot replace the last good provider object.

Digesting uses recursively sorted object keys and preserves array order. The
server records opaque custody, original source observation and deterministic digest.
Source digests are reproducibility markers, not cryptographic source authentication.
Explicit authorization/custody and independently verified source completeness are
still operator obligations. This shared-owner workflow is not Production RBAC.

`scripts/compile-operations-sources.mjs` optionally combines an automatic raw
compiler source with the two envelopes. Input is exactly `automatic`, `manual`,
`feedback`, with null allowed for unconfigured optional sources. Different windows,
immutable identity conflicts, competing known classifications or complete-inventory
contradictions fail closed. Manual facts may fill unknown fields; they cannot
replace known automatic facts. Output separates the compiled snapshot from source
clocks/digests. It must not be substituted blindly for the daily v1 wire contract.

## Protected reads and presentation

`DEMO_OPERATIONS_SOURCES_ENABLED=true` is a default-OFF Operations-only boundary.
It requires the existing validated password mode and daily read-only storage
configuration. Unknown source configuration keys fail startup. It reuses the
separate `storage:read` credential, never a media/write credential.

`GET /api/v1/platform/demo/operations-sources` runs the existing owner and traffic
gates before storage and returns only two separately attributed compiled aggregates.
No source records, custody IDs, provider ETags, credentials or bucket URLs enter the
response. Query/body selectors and mutation methods are rejected. Customer and
Production compositions do not import the concrete adapter. The response remains
private/no-store and bounded by the existing 64,000-byte projection boundary.

Reads coalesce and cache for five minutes; errors retry after one minute. Invalid,
future, rollback or equivocal same-clock replacements never refresh last-good data.
Source failure retains the last validated in-process envelope with `last_good` and
its original clock. Missing/expired sources are independently unavailable. The UI
must display automatic observations and operator-confirmed facts separately, mark
unknown/incomplete values, stale sources and last-good state, and never silently
override newer automatic observations. The minimized feedback register is not a
general browser store or a public feedback form.

## Retention and reset boundary

Sources become stale after 24 hours and logically expire after 30 days. The API
does not claim that object bytes are physically deleted at expiry. The operator
must renew with independently verified source facts or explicitly remove the exact
expired register using the protected provider workflow after retaining any required
separately authorized evidence. A retained expired object does not become valid
merely because it was re-read. There is no automatic broad-prefix cleanup.

Operations keys are outside the canonical `v1/<tenant>/<kind>/<asset>/<digest>` media
namespace. Customer media/reset/purge ports cannot construct Operations keys; the
source adapter cannot construct media keys and has no deletion API. Demo media
cleanup authority does not authorize register deletion. Keep detailed evidence in
its separately authorized process; the KPI source contains only normalized facts.

## Acceptance evidence boundaries

Native tests cover closed schemas, clocks, limits, fake-zero rejection, conditional
creation/update, duplicate submissions, concurrent/stale updates, last-good behavior,
provider failure minimization, fixed keys, read-only defaults, owner/traffic gating,
method/selector rejection and architecture isolation. Required full repository,
PostgreSQL, security and permanent browser/reset gates still apply before merge.
Source merge, configured rollout, actual object initialization, deployed paired UI
and an executed scheduled collection remain separate acceptance claims.
