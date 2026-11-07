# Grouped dependency review — 7 November 2026

Scope: CO-291, replacing the dependency-only candidate in API PR370 on current
Main `d18de2cdf23b0baf5051612759b529f034ce7393`. Runtime adapters, identity policy,
deployment selection and immutable frontend counterparts remain unchanged.

| Package | Previous | Reviewed candidate | Boundary |
| --- | --- | --- | --- |
| `@aws-sdk/client-s3` | 3.1158.0 | 3.1160.0 | Private media adapter |
| `@azure/msal-node` | 7.1.1 | 7.1.2 | Fixed-origin identity adapters |
| `@biomejs/biome` | 2.6.3 | 2.6.4 | Development-only lint tool |

## Storage and transitive correction

The [S3 changelog](https://github.com/aws/aws-sdk-js-v3/blob/v3.1160.0/clients/client-s3/CHANGELOG.md)
lists version-only client changes. The locked AWS core, credential, checksum,
signing and Smithy packages also change and require separate assessment. The
adapter retains explicit credentials, fixed Frankfurt endpoint, one attempt,
no region redirects, bounded sockets/deadlines and independent SHA-256 verification.
Checksums remain `WHEN_REQUIRED`; the real installed SDK test covers signed
PUT/GET/DELETE without optional checksum streaming, alongside existing redirect,
retry, corruption, size and timeout negatives.

The original candidate locked deprecated `@smithy/core`3.38.0. Upstream
[AWS issue8393](https://github.com/aws/aws-sdk-js-v3/issues/8393) identifies incomplete
redaction of sensitive fields nested in lists/maps when a custom logger emits
the events. This adapter configures no custom logger; no exposed data is inferred.
Following the upstream update procedure resolves core3.39.0 and types4.20.0,
including the3.38.1 redaction correction. Its additional change propagates aborts
during retry-token acquisition/backoff; the adapter still permits one attempt and
retains its independent whole-operation deadline. No direct dependency or override
is added. Unrelated optional-native-package lock metadata is preserved.

## Identity and tooling

[MSAL Node7.1.2](https://github.com/AzureAD/microsoft-authentication-library-for-js/releases/tag/msal-node-v7.1.2)
updates Common16.14.3 to16.15.0. The published npm source comparison confirms Node
source changes only its version metadata; Common changes response-header casing,
throttling/header handling, flat authorization-response parsing and an optional
popup-origin assertion. Existing real-SDK tests retain exact callback, state,
nonce, PKCE, consent, MFA/freshness and safe rejection. Additional assertions
require `pocd` to remain absent: the server-side flow makes no browser-popup
claim that could suppress provider COOP. No new scope, callback or token custody.

[Biome2.6.4](https://github.com/biomejs/biome/releases/tag/%40biomejs/biome%402.6.4)
adds rules and fixes; repository rules, formatter policy and runtime remain
unchanged. Changed packages retain approved licenses and no install lifecycle
scripts. Locked installation continues with `npm ci --ignore-scripts`.

## Acceptance and rollback

Only the two reviewed runtime versions change in the exact architecture allowlist.
Its negative test also rejects both newly superseded versions; ranges, missing and
additional adapters remain rejected. Required quality, dependency/audit, static,
secret, PostgreSQL and all four browser/storage cells remain mandatory, including
three customers and two resets. Candidate and independent Main receipts belong in
Jira; this review alone asserts no passing CI, deployment or real-provider acceptance.

No schema, seed, role, artifact, source-access, provider configuration or deployed
release changes are made. A rollback must qualify a complete manifest/lock/allowlist
pair again and preserve the corrected Smithy transitive resolution; blindly
restoring the previous lockfile would restore the deprecated redaction version.
