# S3 patch batch review — 7 November 2026

Scope: CO-291, replacing dependency-only PR384 on Main
`3bdf29ae817da24289d854deff3dc4f29bf19602`. The previously accepted
[grouped review](DEPENDENCY-REVIEW-20261107.md) remains historical evidence.
This batch freezes the observed S3 release at 3.1164.0; later releases need
their own review. MSAL 7.1.2, Biome 2.6.4 and other direct dependencies stay fixed.

| Package | Accepted baseline | Reviewed candidate |
| --- | --- | --- |
| `@aws-sdk/client-s3` | 3.1160.0 | 3.1164.0 |
| `@aws-sdk/core` | 3.979.0 | 3.980.1 |
| `@smithy/node-http-handler` | 4.14.0 | 4.14.2 |
| `@smithy/fetch-http-handler` | 5.8.0 | 5.8.1 |
| `@smithy/core` / `@smithy/types` | 3.39.0 / 4.20.0 | Preserved |

## Source and boundary assessment

The [S3 changelog](https://github.com/aws/aws-sdk-js-v3/blob/v3.1164.0/clients/client-s3/CHANGELOG.md)
records version-only changes and a generated TypeScript import-alias correction.
The [upstream release changes](https://github.com/aws/aws-sdk-js-v3/blob/v3.1164.0/CHANGELOG.md)
and published npm source comparison also cover core clock-skew correction and
opt-in service-default socket timeouts. Clock skew now excludes server processing
time. The adapter still supplies explicit credentials and a fixed Frankfurt
endpoint, uses SigV4, disables region redirects, and permits only one attempt.
No default credential discovery, extra service, environment opt-in or retry is enabled.

The Node HTTP handler now shares its default HTTP agent across concurrent initial
requests and keeps socket idle timeouts active through response-body consumption.
It destroys an incomplete body with `TimeoutError`, while preserving an already
complete buffered response. Long socket timeouts still defer registration by three
seconds. Our production adapter supplies its own bounded HTTPS agent and retains
its independent five-second whole-operation abort/body-destruction deadline;
this deadline does not depend on the upstream opt-in timeout feature.
The Fetch handler now cancels its timeout timer after completion; it is not the
selected server transport.

PR384 would replace the previously qualified Smithy core/types with 3.38.1/4.19.0.
Core 3.38.1 already contains the redaction fix; this is not a newly asserted
vulnerability. The candidate keeps 3.39.0/4.20.0 and their reviewed abort behavior.
All changed package entries remain Apache-2.0 without install lifecycle scripts.
No dependency override or additional direct package is introduced. Unrelated
optional native-package metadata is preserved; CI retains locked, script-free installs.

## Acceptance and rollback

Only S3's exact reviewed version changes in the architecture allowlist. Negative
coverage additionally rejects 3.1160.0 and the unqualified 3.1161.0 candidate.
New loopback transport tests use the installed SDK to exercise incomplete-body
timeout/destruction and complete-body delivery with a configured short socket timeout.
They do not change the production endpoint policy or claim live Neon acceptance.
Existing real-SDK signing, PUT/GET/DELETE, checksum, redirect/retry, integrity,
tenant-bound key, concurrency and whole-operation-deadline coverage remains required.

Required quality, audit, static, secret, PostgreSQL and all four browser/storage
cells remain mandatory, including all three customers and two resets. Native
candidate and independent Main receipts belong in Jira; this review alone asserts
no passing CI. No schema, seed, frontend pin, runtime source, role, provider
configuration, source visibility or deployed release changes are included.
Rollback requires a separately qualified complete manifest/lock/allowlist pair;
retain the reviewed Smithy redaction/abort corrections and transport regression tests.
