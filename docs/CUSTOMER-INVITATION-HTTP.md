# Customer invitation administration HTTP — unreleased

The explicitly injected `customer-invitation-routes.js` module delegates to the
existing invitation application service. It is absent from ordinary entrypoints
and both closed Demo compositions. It does not activate INT, dispatch email or
provide Platform onboarding authority.

The existing Customer host supplies session resolution, current Tenant context,
CSRF verification, security headers, rate and transport bounds, minimized errors
and server-generated correlation. Only current same-Tenant Tenant Admin authority
with `tenant:users:manage` may use these operations. Employee, Conference Manager,
foreign objects and browser-supplied Tenant/User headers confer no authority.
The repository retains current lifecycle/session/version and object checks under
its locks; the route does not replace those checks.

| Method and path | Closed input | Success |
| --- | --- | --- |
| GET `/api/v1/tenant/invitations` | Empty body; optional unique `limit` 1..100 (default 50) and UUID `afterId` | 200, `invitations`, `requestId` |
| POST `/api/v1/tenant/invitations` | UUID `commandId`, 1..20 invitation intents | 201, `invitations`, `requestId` |
| POST `/api/v1/tenant/invitations/{id}/reissue` | Exact positive `expectedRevision` | 200, `invitation`, `requestId` |
| POST `/api/v1/tenant/invitations/{id}/revoke` | Exact positive `expectedRevision` | 200, `invitation`, `requestId` |

Each intent contains only `recipient`, existing Customer `roles` and `locale`
(`de` or `en`), validated by the shared policy. Requests cannot supply expiry,
acceptance, provider identity, permission, Tenant or User authority. Mutations
require the exact configured HTTPS Origin, current session CSRF and JSON capped
at 16384 bytes. Queries on mutations are forbidden. Fetch Metadata, if present,
must be same-origin. Methods, UUIDs, pagination, duplicate query fields and
revision boundaries fail closed. Existing standardized errors preserve concealed
foreign-object responses and stale-revision conflicts.

Public receipts contain only ID, revision, recipient, roles, locale, state,
expiry and delivery. All values are validated and response sizes remain bounded;
private Tenant/environment, browser and provider fields are never copied.
Delivery `accepted` denotes provider acceptance, `processing` an in-flight lease,
and `cancelled` a cancelled queued attempt. Revocation cannot claim a queued send
or erase an accepted/in-flight observation. No receipt proves delivery, creates a
session or changes an accepted User's roles. Exact issuance replay remains the
original command receipt; list/mutation responses represent current state.

Four real loopback HTTP cases exercise the application authorization service,
list/batch/reissue/revoke, concealed foreign objects, stale revisions, role and
CSRF/origin denials, nested authority injection, body/query bounds, minimized
output/logs and absent-by-default composition. The loopback test transport is not
deployed TLS, real database concurrency, browser UI or mail acceptance evidence.
There is no migration or dependency change in this HTTP slice. Native persistence
and permanent three-customer/two-reset-cycle qualification remain separate gates.
