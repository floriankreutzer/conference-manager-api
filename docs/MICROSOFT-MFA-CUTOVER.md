# Microsoft MFA cutover

## Approved target

The owner-approved replacement puts authentication before the existing Customer
and Platform applications. Existing application functions, presentation and all
three permanent Demo scenarios remain the functional baseline.

Platform uses Microsoft-managed MFA, with no application-managed passkeys.
Customer retains invitation-bound Microsoft and email-code authentication;
transactional invitations remain email. The designated owner has all four
Platform roles and may enter a chosen real Customer as Employee, Conference
Manager or Tenant Admin under the owner's actual auditable identity. This is
not impersonation of an existing Customer User. Customer role assignment combines
explicitly configured Microsoft-group mappings and direct Tenant Admin grants.
An effective role remains while either source grants it; a User suspension
blocks all access. Group/domain/display-name claims alone grant no authority.
Northwind, Contoso and Fabrikam must remain usable with safe history-preserving
reset and simulated outbound integrations. No private identity is recorded here.

## Implemented foundation in this branch

The explicit `microsoft_mfa` Platform assurance mode uses the existing bounded
Microsoft code-exchange adapter and server-side operator/session authority. It
requests `auth_time` and `amr`, requires a bounded nonduplicate `amr` list containing
`mfa`, and preserves exact directory, issuer, audience, nonce, PKCE, freshness,
expiry and transaction checks. Merely requesting a claim or having an Authenticator
registered grants nothing. `pwd`, `rsa` and `ngcmfa` without `mfa` are rejected.
Assertions are opaque, instance-bound, one-use, and checked for expiry on use.
Raw token claims never establish application roles or enter logs/audit output.

Internal contexts `cm:ms:mfa:v1` and `cm:ms:fresh:v1` describe independently verified
Microsoft MFA, not Conditional Access policy IDs. Sign-in requests max_age 300;
existing sensitive-operation reauthentication requests max_age 0. No paid
Conditional Access context or WebAuthn request is sent. Configure the Microsoft
application to emit the optional `amr` and `auth_time` ID-token claims and verify
an actual successful MFA and rejected non-MFA round trip before cutover.

The owned protected configuration accepts this mode without a passkey secret or
minimum count; supplying those inputs is rejected. Its session resolver accepts
only the new Microsoft contexts. The selected authentication composition exposes
no passkey, enrollment, key-management or offline-recovery route. UUID/integer
epoch fences, TLS, session cookies, CSRF, server-side permissions, target scope,
security-version invalidation and audit remain mandatory. Operational routes use
the existing Microsoft fresh-reauthentication policy. Provider/product aggregates
retain their explicit access-mode binding and authorization checks.

References:
- https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims
- https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference

## Incomplete release scope — do not activate

This is not full implementation of the approved target. In particular:

- Synthetic generation/handoff still has its separate passkey/continuation SQL
  custody. The new mode refuses that incompatible opt-in; replacing it requires
  additive custody, expiry/replay/concurrency and real reset/browser qualification.
- The one-time owner-role upgrade is implemented below but has not been executed
  live. General two-administrator operator lifecycle remains unchanged; broader
  sole-owner administration is not yet implemented.
- Auditable owner-to-real-Customer support access and administrative Microsoft
  group-to-role mapping require final paired/provider qualification. The schema069
  candidate implements approved mapping, bounded observation and independent
  source reconciliation; see CUSTOMER-ROLE-SOURCES.md. Never simulate these features by broadening ordinary User
  roles or linking a real identity to a synthetic persona.
- Runtime roles, schema/custody, source pair, browser manifests, deployment UUID
  and integer epoch, actual MFA claims, invitation sender/delivery and all three
  Demo scenarios require coordinated cutover evidence. Existing key/audit history
  must be retained; old processes/sessions must not reopen superseded authority.

Keep the live deployment unchanged until the complete target and required gates
are qualified. Existing passkey profiles are retained for current operation and
regression during the transition; they are not the approved final login model.
Passing software/provider fixtures does not prove live Microsoft MFA or external
email delivery. No owner role, Customer access, Demo generation, secret, migration
or live service is changed by adding this source mode.

## One-time existing-owner role upgrade (schema 067)

`node scripts/platform-owner-roles.mjs` is an offline administration command,
never an HTTP endpoint or a browser role selector. It uses the existing independently
bound offline database-owner configuration (historical `PLATFORM_PASSKEY_OFFLINE_*`
variable names); this credential is an administration credential, not a passkey,
and no authenticator enrollment or credential secret is required by this command.
The remaining configuration names and schema-ledger/TLS/audit-segment checks match
`platform-owner-bootstrap.mjs`. Descriptor 3 supplies the exact bootstrap identity,
INT deployment UUID, approval reference and fresh correlation ID, plus an explicit
`expectedSecurityVersion`. Neither roles nor scope can be selected by that input.

Only the already bootstrapped, active, all-scope Microsoft owner can receive the
fixed canonical four-role union. There must be exactly one non-Demo operator and
an original owner-bootstrap receipt for that operator. Identity, deployment,
version, database owner/session owner and prior-upgrade guards fail closed. An
upgrade is one-time and concurrency bounded; it cannot create/reactivate an owner,
change identity, revoke other operators or turn a Customer into a Platform actor.

The ordinary operator update trigger increments security version. The transaction
revokes old Platform sessions and pending OIDC transactions, appends an integrity-
protected offline-owner receipt and queues the existing access-change alert.
Other previously issued authority remains fenced by the changed operator version.
Receipt roles/permissions stay empty and its actor is explicitly offline owner;
no Microsoft MFA or independent second approver is fabricated. Required receipt
failure rolls back the change. Existing key records and audit history are retained.
Migration067 adds this narrowly guarded audit vocabulary; it grants no role by
itself. Its rollback refuses once an upgrade receipt exists, preserving signed
history. The source mechanism passed native database and complete Demo/browser CI at
API307 and the cumulative API310 candidate. Explicit coordinated operating
evidence is still required; no actual owner role grant is claimed.
