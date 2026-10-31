# Grouped dependency review — 31 October 2026

Scope: API PR361 and infrastructure INF-07 in frontend issue433. The candidate is
integrated with API Main `4413647d255fb5ae6e83f14a43888b35292ffe75`; deployment
remains a separate coordinated qualification. Grouping does not approve versions.

| Direct package | Previous | Reviewed candidate | Boundary |
| --- | --- | --- | --- |
| `@aws-sdk/client-s3` | 3.1152.0 | 3.1158.0 | Private media storage adapter |
| `@azure/msal-node` | 7.1.0 | 7.1.1 | Fixed-origin identity adapter |
| `@biomejs/biome` | 2.5.15 | 2.6.3 | Development-only lint tool |

The [S3 package changelog](https://github.com/aws/aws-sdk-js-v3/blob/v3.1158.0/clients/client-s3/CHANGELOG.md)
records version-only updates through3.1157.0 and an upstream test-key isolation fix
in3.1158.0. The lockfile also updates AWS core, credentials, checksum, signing and
token packages, Smithy core3.37.0/HTTP handler4.13.0 and Bowser2.15.0. These are
transitive updates, not evidence that the complete SDK is unchanged. The reviewed
adapter still supplies explicit credentials and a validated endpoint, disables
region redirects, permits one attempt, bounds sockets and deadlines, verifies
content length/type/digest and exposes no SDK type or provider URL to consumers.

[MSAL Node7.1.1](https://github.com/AzureAD/microsoft-authentication-library-for-js/releases/tag/msal-node-v7.1.1)
updates Common16.14.2 to16.14.3. Its [upstream source comparison](https://github.com/AzureAD/microsoft-authentication-library-for-js/compare/msal-node-v7.1.0...msal-node-v7.1.1)
adds an optional bridge-type performance field in Common and updates Node package
metadata; it does not change the authentication exchange source. Existing actual
installed-package tests continue to cover PKCE/nonce and the bounded synthetic
transport. This is not new real-provider acceptance and does not change scopes,
consent, callback origins, persistent token custody or session authorization.

[Biome2.6.3](https://github.com/biomejs/biome/releases/tag/%40biomejs/biome%402.6.3)
adds rules and fixes. The existing explicit repository configuration and all
enabled lint/security checks remain unchanged. The lockfile adds two optional
Android CLI packages; no runtime adapter is added. None of the changed lockfile
entries declares an install lifecycle script, and installation still uses
`npm ci --ignore-scripts`.

Only the two reviewed exact runtime versions are changed in the architecture
allowlist. The regression test explicitly rejects their superseded versions as
well as ranges, missing adapters and additional packages. A future grouped update
must undergo the same independent approval; matching package names is insufficient.

Acceptance requires the locked install, audit, full native quality/security suite,
PostgreSQL regression and all four existing shared Demo browser/storage cells.
Those cells retain three customers, two resets and Chromium/WebKit. Exact PR and
independent Main run receipts belong in the tracking issue after completion;
this source review alone does not assert passing CI or a deployed upgrade.
