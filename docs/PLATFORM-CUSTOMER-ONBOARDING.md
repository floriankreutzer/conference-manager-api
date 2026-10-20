# Platform customer onboarding preparation

This inactive factory replaces the legacy single bearer-claim invitation only
when a real protected INT composition explicitly selects it. The existing Demo
and default entrypoints remain closed to this implementation. It is not live
activation evidence.

## Ownership and authority

`createPlatformCustomerOnboardingService` accepts the existing Platform principal,
creation permission and all-Tenant creation policy. The protected configuration
must explicitly provide the owner recipient and locale; Microsoft profile/email
claims and browser fields cannot supply that contact. Zero to nineteen additional
individual invitations are accepted. The configured owner is always included with
`tenant_admin`, retaining an explicitly requested Conference Manager role and the
configured locale. Tenant Operator means the existing Customer `tenant_admin`
role and creates no Platform permission.

The invitation intent and public-result functions enter through the explicit
`invitationContract` port. The composition root supplies the existing Customer
contract functions. Platform application code does not import or impersonate the
Customer runtime. This contract validates intended Customer roles; it does not
authorize the Platform caller or issue Customer access.

## Atomic creation and retry

`createPostgresPlatformCustomerOnboardingRepository` first checks and locks the
current persisted Platform operator and session, including security version,
roles, permissions, scope, epoch, assurance and proof expiry. This happens before
receipt reads as well as fresh writes. Creation receipts use the existing
`tenant.invitation.create` operation and global target scope. A separate HMAC
domain binds the normalized owner-inclusive intent, name and reason to the
operator, command and deployment environment, without requiring a Tenant that
has not been created yet.

A fresh transaction creates one onboarding Tenant, appends its registration
record in both audit domains, and issues all invitations through the same private
Customer custody. Mailbox locks are ordered by protected lookup hash. Each
invitation has its own matching Tenant audit and Platform operator audit; the
Tenant actor remains explicitly `platform_operator` with no fabricated User.
Encrypted delivery jobs and recipient-free original receipt snapshots commit in
the same transaction. No legacy bearer claim, User, Customer role, Customer
session or outbound request is created.

The custody primitive requires the caller's active transaction. It cannot open
an independent connection to evade proof rollback. When invoked inside the exact
request proof transaction, audit, Tenant, invitations, delivery and receipts roll
back with a failed proof/session commit. There is no automatic signed-operation
retry.

An exact command replay requires current creation authority and the same HMAC.
It restores the original Tenant and invitation snapshots, decrypting recipient
custody only after authorization. It does not reset a current invitation or
create another email. Changed intent under the same command is a conflict.
Customer public projection rejects extra private fields, foreign scopes,
incorrect recipient/role/locale ordering and inconsistent original receipts.

## Verification and remaining activation work

Focused application tests cover owner inclusion/deduplication, creation denial,
closed bounded inputs and invalid persistence/evidence results. Cipher tests
cover environment/operator/command/domain separation and destroyed keys. The
existing Customer service and architecture tests cover the shared-custody
refactoring. These are local automated checks, not deployment evidence.

`tests-db/platform-customer-onboarding.test.js` is a native PostgreSQL acceptance
contract for three recipients, real Platform sessions, both real audit services,
concurrent exact replay, changed-command denial, audit rollback, enclosing proof
transaction rollback, no Customer impersonation and revoked-session denial before
receipt disclosure. Its successful execution must be reported from actual CI;
writing the test does not constitute a native execution claim.

The explicit HTTP composition, Platform multi-recipient management UI, current
customer-directory projection, invited-only Microsoft sign-in/linking, protected
INT runtime/reset, full linked-data retention, operational sender configuration,
physical key/recovery evidence and real owner contact remain separate SaaS1
activation work. No sender, physical key, cost-bearing resource or live state is
created by this preparation.

## Explicit HTTP composition

`createPlatformApp` accepts the optional `platformCustomerOnboardingService` port.
Its default is null, preserving the existing legacy/Demo request shape. With the
port explicitly selected, `POST /api/v1/platform/tenants` requires an additional
`invitations` array of zero to nineteen intents and calls `createTenant` only.
The application contract performs nested recipient/role/locale validation and
always adds the configured owner. Unknown root fields, oversized arrays, query
parameters, missing idempotency and invalid confirmation remain rejected. A
configured but invalid service fails at composition; a service failure never
falls back to bearer-claim creation.

This is the existing concrete `TENANT_CREATE` route. Its ordinary session, CSRF,
origin/body/response limits and telemetry identity remain shared. In the prepared
application-passkey composition, the exact-request hash includes every recipient,
role and locale. A pending proof cannot be used after changing any of them. The
route response and ordinary session cookie remain buffered until proof/business
commit succeeds. Tests exercise the actual decorator and route module together;
synthetic verification ports do not replace the separately required native and
physical-key acceptance evidence.

The port is not selected by a process entrypoint in this preparation. Platform
list/resend/revoke and directory projection for the new custody remain follow-on
work before activating this create path in protected INT.

## Platform invitation administration preparation

The optional `createPlatformTenantRoutes({ invitationAdministration: true })`
replaces the default Tenant route module in a protected composition. It requires
both real onboarding and real invitation-administration ports at startup. It
claims the scoped invitation collection for bounded GET listing and POST batch
issuance, and sends existing per-invitation resend/revoke routes only to the new
custody service. There is no fallback after a business or persistence failure.
The default route module does not claim the new collection. No entrypoint selects
this mode yet.

The new service requires the existing Platform invitation-management permission
and current target policy. Even listing recipients requires fresh proof and CSRF;
its exact query and pagination join the request hash. The minimized Platform
directory-read audit names the invitation collection and operation, without
recipient details. List output is ordered, cursor-fenced and limited to100 rows.
Additional invitation batches are limited to20 and do not re-add the owner already
included by initial onboarding. Customer role/locale intent uses the same injected
contract as onboarding; it cannot carry Platform roles or browser Tenant authority.

Existing-Tenant commands use environment/operator/Tenant/command-bound HMAC
receipts and reauthorize before replay. The repository locks current Platform
operator/session authority, command receipt and eligible Tenant before accessing
custody. Customer and Platform management use one private mutation primitive for
invitation/member locking, revision fencing, the sixty-second resend cooldown,
terminal-state denial, queued-only cancellation and a fresh encrypted delivery
revision. A provider acceptance or active claimed lease survives revocation as a
recorded external fact; revocation does not grant access. Both audit domains,
receipt and outbox effects remain atomic with the exact proof transaction.

Focused tests cover actual permission/target decisions, absent strong assurance,
closed inputs, public scope/result fences, private-field denial, query/body proof
substitutions and explicit route composition. Native acceptance extends the same
real PostgreSQL fixture with additional batch/replay, foreign invitation IDs,
concurrent revocation, retained acceptance observations and a positive resend of a
legitimately aged initial invitation. That initial fixture is inserted through
normal custody/audit guards with database-derived historical timestamps; it does
not patch a clock, edit immutable existing rows, disable a guard or sleep.
Writing these cases does not claim native execution; actual current CI remains
required before acceptance. Directory projection, UI and protected INT activation
remain follow-on work.

## Invited-customer directory projection

The existing Platform Tenant repository has the optional protected constructor
setting `customerInvitationEnvironment`. Null preserves the legacy query, its
parameter shape and claim-state behavior. An explicit dev/int/prod value reads
only that environment's new invitation and accepted membership records. It does
not decrypt mailboxes, expose recipients or create synthetic legacy bearer-claim
rows. An open individual invitation takes precedence in the summarized invitation
state, while any recorded membership acceptance changes onboarding to `claimed`.
Other still-pending individuals remain visible through the management collection.
Microsoft directory identity continues to use its independently verified binding;
email acceptance does not make that identity active or make onboarding complete.

The projection retains the existing bounded Tenant directory DTO and live
operator/target SQL scope. Cursor signatures include the selected custody
environment, so an INT cursor cannot be reused in PROD or the legacy mode. The
cursor bounds the Tenant traversal and observation window; it does not create an
invitation-history archive or grant any mutation authority. Individual management
always rechecks current state and expected revision.

Unit cases verify the separate fixed query modes, environment binding, minimized
projection, independent membership/directory state and cross-mode cursor denial.
The native acceptance additionally runs actual Platform-created invitations
through the existing encrypted email challenge, explicit membership choice,
ordinary Customer session issuance and directory observation. Synthetic code
factory material tests backend composition; it does not claim live mail delivery
or Microsoft identity proof. Current native CI execution remains required.
