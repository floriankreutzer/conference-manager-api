# Owned protected frontend delivery

SaaS1 issue351. Prepared source only; no hosting configuration or traffic has
changed. The Customer and Platform roots can serve their separate immutable
browser artifacts on their existing same-origin API sites. Ordinary and closed
Demo roots remain unchanged. No additional hosting service is required by this
implementation. This is not evidence of a provider plan, deployment or cutover.

`PROTECTED_HOSTED_FRONTEND_ENABLED` defaults to false. Exact true additionally
requires `PROTECTED_HOSTED_FRONTEND_SHA256`, the independently reviewed SHA256 of
that surface's manifest. A stray digest with inactive delivery is rejected. No
filesystem path, handler, source URL or frontend implementation is accepted by
the protected runtime configuration. The fixed directory is
`.protected-frontend/customer` or `.protected-frontend/platform` beside the API
source root, independent of the process working directory.

The manifest fixes schemaVersion1, surface, environment, both source40SHAs,
both canonical HTTPS origins, synthetic presentation state, explicit boolean
Microsoft/invitation presentation state and the ordered path/length/SHA256 of
every file. The complete profile must match the runtime. The external digest
prevents adoption of modified bytes plus a locally recomputed manifest. Every
file is verified before any pool construction/listening and captured in private
memory. Missing, stale, oversized, extra, symlink, traversing and foreign-plane
files fail startup without reflecting their contents or paths. Limits are512
files,2MiB per file,16MiB total and a256KiB manifest. Only browser modules and
known public asset MIME types are admitted; manifests, build/operator scripts,
tests, environment files and other directories are never public routes.

The owned responder validates Host, target, optional Origin, GET/HEAD and absence
of a request body. It bounds rate-limit state and sends no-store, nosniff,
same-origin resource policy, HSTS and the verified HTML CSP with frame denial.
Platform `/` redirects only to its fixed `/platform-admin/`. Unknown files return
an empty404; no SPA/Demo/API fallback exists. All `/api` targets use the original
protected transport handler and whole-request database lease, including unknown
or foreign-plane endpoints. Static files contain no Tenant or session authority
and acquire no business database connection. Cookies, CSRF, roles, source
revocation and exact privileged-operation proofs remain unchanged.

Build both artifacts in the exact clean reviewed frontend checkout with
`node scripts/build-protected-frontend.mjs /absolute/api/.protected-frontend`.
Supply the nonsecret deployment inputs: PROTECTED_API_COMMIT,
PROTECTED_FRONTEND_COMMIT, PROTECTED_ENVIRONMENT, PROTECTED_CUSTOMER_ORIGIN,
PROTECTED_PLATFORM_ORIGIN, PROTECTED_SYNTHETIC_ENABLED and optional explicit
PROTECTED_PRESENTATION_MICROSOFT_ENABLED / PROTECTED_PRESENTATION_INVITATIONS_ENABLED
(both defaultfalse). Locked frontend dependencies must already be installed.
The frontend CLI verifies its actual HEAD and clean checkout, never fetches or
executes downloaded source, refuses an existing output directory, writes both
separate manifests and outputs their public digests. Record those digests with
the actual immutable artifact pair, then configure each process with only its
own digest. Build inputs contain no runtime secret. Do not enable presentation
features before their independent operating readiness is proved.

Local adversarial tests cover profile and byte drift, recomputed manifests,
extra/unsafe/symlink files, captured-buffer isolation, Host/method/body/target
rejection, private headers, API routing and lower-layer/Demo import denial.
The native two-root fixture additionally verifies actual owned static delivery
beside real session guards with verified PostgreSQL TLS/SCRAM and max1 pools.
The separately pinned frontend qualified journey must forward static as well
as API requests to the real roots; a test-edge static server is insufficient
evidence for this addition. Native/qualified CI remains required. No physical
key, real Microsoft/mail, operating restore or deployment acceptance follows.

Initial actual hosted qualified CI39617252870 failed both engines because the
new static1000-request/minute/address budget truncated legitimate repeated cold
native-module navigations at HTTP429. This is retained as a product failure,
not an infrastructure-only failure. The corrected budget admits sixteen complete
sealed graphs per minute/address, capped at4096 requests with2000 bounded keys.
API/auth/database limits and the test-edge2000-event bound remain unchanged.
An additional actual-HTTP case admits sixteen complete minimal graph loads,
then requires429 for the next static file while API routing remains unaffected.
The earlier local2052/both-DAST result does not prove this correction; fresh
complete CI including both qualified engines is required.
