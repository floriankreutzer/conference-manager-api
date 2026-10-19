# Unsent order withdrawal and replacement

Implementation contract building on merged API #220 at
main6530407eb94fb66acfb680aa3c755659a6dc3f2d. Canonical052 and Demo018 compose the
readiness/inventory and replacement-routing extension. Dated validation and final
immutable acceptance evidence are maintained in PR#221; source implementation,
merged acceptance and deployment are separate facts. No release or live supplier
qualification is implied by this contract.

## Local withdrawal

An explicitly justified Manager command may stop a demonstrably unsent current
order or proposal. It is neither supplier transmission nor supplier cancellation.
An older confirmed supplier order remains effective when an unsent proposal is
withdrawn. Confirmed/partially confirmed/transmitted/unknown work cannot be stopped
through this command.

The current implementation draft adds closed GET/POST
`/api/v1/tenant/catering/orders/{orderId}/withdrawal` under the existing delivery
flag. POST has exactly schemaVersion1, commandId, expectedOrderVersion,
expectedStateRevision, justification and literal true attestNotTransmitted. GET optionally selects a historical
orderVersion. The server owns Tenant, Manager/session/security-epoch authority.
Exact same-command/actor/epoch replay precedes CAS; no automatic retry occurs.

Eligibility requires a pending quote/review/released order without any job, a
Manager-rejected unsent quote without a job, or an approved queued order with a
queued/deferred job, zero dispatch attempts, no durable attempt, no observation
and no lease. Any manual fact blocks withdrawal. Missing facts alone do not prove
that a human never sent anything; the Manager must explicitly attest that no manual
transmission occurred. That assertion is retained with the actor/security epoch.
Current source and job are locked
under the existing Tenant/Manager/session admission, shared with the worker.

Append-only withdrawal evidence, new `withdrawn` order state, optional zero-attempt
job supersession and minimized HMAC audit commit atomically. Deferred SQL guards
require matching evidence and effects, retain prior quote/decision heads and freeze
a withdrawn version permanently. Failed audit rolls everything back. Justification,
job/actor/security/session details and costs are absent from audit summaries.
Public facts include only order/version, prior status, justification, the explicit
not-transmitted attestation and recorded time. Neither quote expiry nor later technical disconnection should prevent this
strictly local stop. Platform has no access; Customer can read/append; Reset may
truncate the evidence. Empty rollback is allowed; populated or audit-only rollback
requires review.

Local Node24 validation passed: 1,541 native tests, live HTTP DAST and all17
Platform HTTP security tests; dependency audit found zero vulnerabilities. The first
full run retained a missing derived-field fixture failure, corrected by supplying the
actual initial delivery field and adding positive/negative projection tests. An
interrupted execution-environment recovery run is not acceptance evidence.
The actual052 Customer/Platform/Reset progression passed on5e6c305d6b8d1012cd6a6ec4f1b65e7ebdebca97
in PostgreSQL18.6 job118200238471. That full suite stopped afterwards in the existing
051 rollback probe because it revoked an overlay after dropping052 readiness.
The probe now revokes both overlays before canonical rollback, preserving its
original assertions and the runner's exact-readiness requirement. The earlier
delivery cleanup FK failure in job118196325273 is retained; cleanup explicitly
includes the new empty referencing tables. Complete exact-head CI remains required.
The real-role test covers concurrent/replayed withdrawal, raw SQL denial, audit rollback,
manual replacement confirmation, synthetic API place/read reconciliation, historical
immutability, scoped HTTP/session/CSRF and populated/audit-only/empty rollback plus reset.

## First physical replacement contract

Do not dispatch `changeOrder` when no supplier order was ever physically created.
Preserve business review intent separately from the actual supplier action.

- A withdrawn head with no effective supplier basis may propose a new reviewed
  `change` version from the current Confirmed request/current matching assignment,
  even if the request version itself is unchanged. Its review basis is the prior
  withdrawn local version, not a confirmed supplier commitment. It requires a fresh
  quote and explicit Manager decision regardless of configured initial mode.
- Store immutable `catering_unsent_replacements` evidence before the ordinary
  version-proposal row, in the same transaction. Tenant/order/version-qualified
  deferred FK to the proposal makes the evidence inseparable from review. Verify
  prior withdrawn state and its withdrawal evidence, exact head/state CAS, current
  request/assignment/configuration, and absence of any prior manual transmission,
  attempt, observation, active lease or non-superseded job for the whole order.
- Do not update/backfill immutable existing order versions. A scoped SQL helper
  derives `deliveryOperation=initial` only for that immutable replacement evidence;
  otherwise delivery operation remains the existing business operation.
- Extend051 proposal guards for this precisely evidenced no-basis branch and for
  a withdrawn unsent proposal over an older confirmed basis. Confirmed-basis
  branches retain all old protections. Pure proposal discovery and application
  output validation allow `change` without an effective basis only for the new
  withdrawn-head path. Existing partial/unknown work remains blocked.
- Quote capability, historical manual-mode validation, current job authority and
  worker capability/method routing use the derived delivery operation. Release
  policy and audit retain business `operation=change`, so initial automatic mode
  cannot bypass Manager review. Lease/intent/idempotency scope remains tied to the
  persisted business identity/version; the adapter receives an opaque idempotency
  key and calls placeOrder for the first physical delivery, including reconciliation.
- Keep old order DTOv1 unchanged when business and delivery operations agree. For
  a differing first physical delivery, return closed DTOv2 with the additional
  deliveryOperation. Validate the private repository field and v2 projection;
  consumers support both versions explicitly. Frontend adapters, documents and
  preflight must preserve the distinction. Human-facing copy should say a new
  supplier order replaces a locally withdrawn draft, rather than presenting an
  update to a nonexistent supplier order. Existing job operation remains the
  business operation for review/status consistency.
- Test the actual manual path and an actual PostgreSQL-backed synthetic API worker
  path: first physical replacement must invoke placeOrder, never changeOrder,
  preserve initial v1, require fresh exact cost approval, reject obsolete source/
  authority, and retain unknown outcomes without resend. No real supplier call.

Initial supplier rejection/failure replacement, acceptance of changed supplier
positions/substitutions, new provider order creation, publication/availability/
cutoffs, partner API/credentials and qualification remain open until implemented.
In particular, a past partial confirmation cannot be erased by a later rejection
or a fresh initial order; confirmed positions require explicit reviewed resolution.
