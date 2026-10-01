# Scoped MSAL Node 7 upgrade review

## Scope and baseline

This change is the scoped replacement for dependency-only PR #79. Its baseline
is main at `9c0f75c3d414968c18df9117214f3dc62be52c13`, retaining SaaS 3.7's
three-customer contract and the guest-context correction from PR #99.

The runtime dependency change is `@azure/msal-node` 6.0.1 to 7.0.0. The platform
SDK adapter also needs the compatibility correction described below. `pg`,
`sharp`, exact-version enforcement, lifecycle-script restrictions, license
policy, audit thresholds and all CI/security/browser gates remain intact.
No database migration, role, callback route, cookie policy or deployment topology
change is introduced.

## Upstream breaking-change assessment

Microsoft's `msal-node-v7.0.0` release removes `responseMode` from
**PublicClientApplication.acquireTokenInteractive** and requires `form_post`
for that browser-loopback flow. Our adapters use
**ConfidentialClientApplication.getAuthCodeUrl** and **acquireTokenByCode**,
not the interactive loopback API. Their explicit `responseMode: 'query'` must
remain; this upgrade does not introduce a POST callback.

Silent-request coalescing does not introduce a new application flow. Customer
and platform sign-in use code redemption; Microsoft 365 retains the existing
fixed-origin client-credential adapter. SDK types remain within adapters.

Primary upstream evidence:
https://github.com/AzureAD/microsoft-authentication-library-for-js/releases/tag/msal-node-v7.0.0
https://github.com/AzureAD/microsoft-authentication-library-for-js/pull/8852

## Pre-existing defect found by real SDK characterization

Baseline runs 36896525037, 36896934229 and 36897192146 exercised the installed
6.0.1 SDK rather than fabricated authorization URLs. Customer requests and
fail-closed code redemption worked, but platform MFA/step-up URL validation
failed. The SDK adds `offline_access`, `clidata` and three nonessential identity
claim requests (`signin_state`, `login_hint`, `tenant_region_sub_scope`). It also
does not emit the application's `maxAge` request property as `max_age`.
Earlier platform test doubles did not reproduce these SDK defaults.

The correction is deliberately restricted to the SDK boundary:

- Request the server-selected freshness through `extraQueryParameters.max_age`.
  The final value must still match the server's exact normal or step-up policy.
- Remove `offline_access` only from the exact SDK three-scope set. Final platform
  consent remains exactly `openid profile`; unknown scopes are rejected.
- Discard bounded `clidata` telemetry. Reject duplicate query parameters before
  any adaptation.
- Remove the three known optional claim requests only when each has exactly
  `{ essential: false }`. Preserve `acrs` and all unexpected properties for the
  strict validator. Modified optional shapes, unknown claims or changed
  assurance requirements fail closed.

The public HTTP redirect validator remains unchanged. It still requires exact
Tenant authority, callback, state, nonce, S256 challenge, freshness, response
mode and the single essential authentication context. No refresh grant or
additional identity claim is exposed by the final redirect.

The old adapter test that rejected an SDK-added offline scope now rejects an
additional unexpected `User.Read` grant. Separate SDK-level and boundary tests
require offline scope removal, while the unmodified HTTP validator still
rejects the unadapted SDK URL. This changes the test's boundary, not the final
least-privilege consent requirement. All missing-security-parameter and other
negative cases remain mandatory.

## Verification and acceptance

`tests/msal-package-contract.test.js` executes the actual installed
ConfidentialClientApplication with deterministic authority metadata and an
isolated synthetic network transport. An observing wrapper delegates to the
real SDK URL method and never replaces its output. Tests cover customer login,
platform MFA and step-up, exact query contracts, nonce, PKCE verifier, real SDK
token request construction and safe provider rejection.

Boundary and optional-claim tests verify bounded input, duplicates, unknown
scopes, claims, URL credentials, foreign authorities/callbacks and assurance
tampering. The preparation workflow requires these tests and the existing
platform authentication security suite to pass on both baseline and target
versions before committing the dependency/adapter update.

Full normal PR CI remains mandatory: dependency/architecture policy, static and
secret analysis, authentication/session regression, PostgreSQL integration and
three-customer Chromium/WebKit progression/reset acceptance. Actual exact-head
check results are the execution evidence; this document and added tests do not
by themselves establish a passing run.

Synthetic SDK tests do not prove live Microsoft tenant consent, registrations,
credentials, conditional-access policies or real sign-in. The existing
independent-tenant Pilot acceptance requirements in
`docs/ENTRA-AUTHENTICATION.md` remain. No live Production acceptance is claimed.

## Rollback

A dependency-only rollback pins manifest, lockfile and architecture allowlist
back to 6.0.1 and reruns all gates while retaining the SDK-boundary correction:
the same defect was demonstrated on 6.0.1. A full revert also restores that
pre-existing defect and must not be described as a verified working platform
login. No data rollback is needed because no schema or identity persistence
model changes.

## CI execution correction discovered during final validation

API main run `36861249787` and PR run `36900079406` repeatedly hit the
isolated WebKit scenario's 420-second aggregate test budget during cycle two.
The baseline failure predates this upgrade. An unchanged-job retry reproduced
it, so another retry is not treated as a correction or passing evidence.

Frontend PR floriankreutzer/conference-manager#227 narrowly gives the complete
isolated WebKit scenario the existing hosted 660-second total budget. CI pins
counterpart `f4c07fcde3d012d81832b24b0d38b0ff23208cf2`; the deployed frontend
reference remains unchanged. Chromium keeps 420 seconds. Global, action,
navigation, assertion, retry, rate-window, customer, negative and two-reset
requirements are unchanged. Seed version and semantic checksum are unchanged.

CI also prefers the existing official Ubuntu HTTPS package mirror without
changing APT trust or suites, and retains both the shared journey and permanent
scenario failure reports. Full exact-head CI, dependency policy and secret
scan must all succeed after these corrections; a timeout is never acceptance.
