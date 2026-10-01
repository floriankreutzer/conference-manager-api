# Scoped MSAL Node 7 upgrade review

## Scope and baseline

This change supersedes dependency-only PR #79. Its baseline is main at
`9c0f75c3d414968c18df9117214f3dc62be52c13`, retaining the current SaaS 3.7
three-customer contract and the guest-context correction from PR #99.

The only approved runtime dependency change is `@azure/msal-node` 6.0.1 to
7.0.0. `pg`, `sharp`, exact-version enforcement, lifecycle-script restrictions,
license policy, audit thresholds and all CI/security/browser gates remain intact.
No database migration, role, callback route, cookie policy or deployment topology
change is authorized by this upgrade.

## Breaking-change assessment

Microsoft's release notes for `msal-node-v7.0.0` identify removal of
`responseMode` from **PublicClientApplication.acquireTokenInteractive** and
mandatory `form_post` for that browser-loopback flow. The existing customer and
platform adapters use **ConfidentialClientApplication.getAuthCodeUrl** and
**acquireTokenByCode**, not the interactive loopback API. Their explicit
`responseMode: 'query'` belongs to the authorization-code URL contract and must
not be removed or converted to a POST callback.

The release also coalesces matching silent-token requests. Customer and platform
sign-in use code redemption; the Microsoft 365 integration uses the existing
fixed-origin client-credential adapter. No new silent or interactive flow is
introduced. Provider SDK types remain inside their existing adapter boundaries.

Primary upstream evidence:
https://github.com/AzureAD/microsoft-authentication-library-for-js/releases/tag/msal-node-v7.0.0
https://github.com/AzureAD/microsoft-authentication-library-for-js/pull/8852

## Added SDK-level regression evidence

`tests/msal-package-contract.test.js` uses the actually installed
ConfidentialClientApplication with deterministic authority metadata and an
isolated synthetic network transport. It exercises the unchanged application
adapters, rather than replacing getAuthCodeUrl/acquireTokenByCode with doubles.

The tests require customer login, platform MFA and platform step-up to retain:
- exact authority, callback, code response type and query response mode;
- state, nonce, S256 challenge and code verifier;
- platform authentication context and max-age/step-up freshness request;
- no client credential in the authorization URL;
- a real SDK token request followed by safe, fail-closed provider rejection.

The existing claim, wrong-audience/issuer, nonce, expiry, replay, browser-binding,
session/CSRF, platform assurance, Microsoft 365 transport, PostgreSQL and complete
three-customer Chromium/WebKit suites remain mandatory and unchanged.

## Acceptance and limitations

Changing the single reviewed version in the architecture allowlist is contingent
on the scoped upgrade review and successful exact-head gates; the comparison and
all other allowed dependencies remain unchanged. No skip or allow-failure is an
acceptable resolution. PR check results are the execution evidence, not this
review document. Tests being added does not itself mean they passed.

Synthetic SDK transport tests do not prove real Microsoft tenant consent,
registration, credentials, conditional-access policies or live sign-in. The
existing two-independent-tenant Pilot acceptance requirement remains in
`docs/ENTRA-AUTHENTICATION.md`. No new claim of live Production acceptance is made.

Rollback is a reviewed dependency/lockfile/allowlist revert to 6.0.1 followed by
all normal validation gates. No data rollback is needed because this change
introduces no schema or persisted identity model change.
