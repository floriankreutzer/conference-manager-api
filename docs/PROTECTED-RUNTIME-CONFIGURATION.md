# Protected runtime profile envelope

The shared profile is composed by the explicit protected Customer and Platform
startup loaders. This source contract activates no deployment, provider,
Microsoft application, recipient, sender or security profile by itself.
`loadProtectedRuntimeProfile` is a pure explicit-input validator. It does not read
or mutate the inherited environment, open a pool, query a database, create an
identity, run a migration or manufacture cutover evidence. Existing ordinary and
closed Demo roots remain unchanged.

## Prepared environment separation

All protected processes use production security settings, including DEV and INT.
Only INT is intended to operate initially. DEV and PROD remain unprovisioned until
they are needed and must be separate before the first productive customer.

| Environment | Customer database role | Platform database role | Synthetic data |
| --- | --- | --- | --- |
| DEV | cm_protected_dev_customer | cm_protected_dev_platform | Explicit opt-in |
| INT | cm_protected_int_customer | cm_protected_int_platform | Explicit opt-in |
| PROD | cm_protected_prod_customer | cm_protected_prod_platform | Forbidden |

The selected surface receives only its own prefixed database credential.
Roles must match the selected surface and environment. Missing credentials or
invalid passwords are rejected, as are connection parameters, unsafe TLS and
excessive pool limits.
The validator returns separate immutable business/lease pool configurations;
both owned roots instantiate distinct pools. Both use verify-full
TLS and canonical application names. Defaults are2 business and1 lease connection;
each bound is at most5 and their sum at most8. These are application bounds, not
an assertion about a provider's plan or available quota.

Customer and Platform origins are explicit distinct canonical HTTPS DNS origins
on the default port. No IP, userinfo, path, query or fragment is accepted. Both
origins must match the separately verified registration/artifact configuration.
Customer/Platform API routing remains same-origin and cookies remain host-only;
this envelope adds no CORS or browser token path.

## Fixed profile inputs

Required common inputs are NODE_ENV=production, PROTECTED_ENVIRONMENT,
PROTECTED_SECURITY_EPOCH, PROTECTED_CUSTOMER_ORIGIN, PROTECTED_PLATFORM_ORIGIN,
PROTECTED_PLATFORM_SECURITY_EPOCH, PROTECTED_API_COMMIT and
PROTECTED_FRONTEND_COMMIT. The UUID is non-reusable deployment custody; the
Platform integer epoch is independent and at least2. Commit inputs must be full
lowercase40-character object IDs. Syntactic validation does not prove artifact
integrity; existing source/counterpart inventory and digest evidence must verify
the actual immutable pair before activation.

The surface-specific database key is PROTECTED_CUSTOMER_DATABASE_URL or
PROTECTED_PLATFORM_DATABASE_URL. URLs have no query parameters; TLS configuration
is explicit and fixed to verify-full. PROTECTED_DATABASE_POOL_MAX and
PROTECTED_LEASE_POOL_MAX are optional bounded decimal integers.
PROTECTED_SYNTHETIC_ENABLED defaults to false; only exact true/false strings are
accepted and true is rejected in PROD.

PROTECTED_HOSTED_FRONTEND_ENABLED also defaults to false. Exact true requires
the selected surface's externally reviewed PROTECTED_HOSTED_FRONTEND_SHA256;
inactive delivery rejects a stray digest. The fixed artifact manifest must match
the complete source pair, environment, both origins and synthetic flag, and every
allowed file must match its sealed length/hash before pool construction. Runtime
configuration accepts no artifact path, handler or source-repository override.
See `PROTECTED-HOSTED-FRONTEND.md`. Presentation-only Microsoft/invitation flags
belong to the isolated frontend build command, not this runtime environment.

Legacy DATABASE_URL, PLATFORM_*, DEMO_*, ENTRA_*, OIDC_* and ordinary origin/audit/
CSRF names are forbidden even when empty. A Customer envelope rejects Platform
secrets/credentials, while permitting the explicitly shared nonsecret Platform
origin/integer epoch. The common-key list deliberately recognizes encrypted
invitation custody, Tenant audit, handoff and immutable-build inputs required by
both server compositions. It returns none of those secrets. Full authentication,
provider, keyring, sender and recipient validation belongs to the existing owned
Customer/Platform startup loaders after this envelope. The loaders and owned
roots construct the authentication, provider and cipher adapters; callers cannot replace
their dependencies with a supplied issuer, verifier, clock, driver or provider.
This envelope is not a complete application-secret configuration or issuer.

## Coordinated operating cutover remains mandatory

New prefixes prevent an old binary from consuming the new credential environment.
Tests prove the existing Customer, Platform and both Demo config loaders reject
these new-prefix fixtures. This does not revoke an old process's already loaded
credentials or sessions. Before any REAL admission, operators must block traffic,
drain both old entrypoints/workers, revoke or rotate old database credentials,
terminate old connections, apply reviewed migrations explicitly, advance the
UUID together with profile/integer epoch changes, and verify both new surfaces
and the immutable artifact pair. Retain epoch history and all identity/business/
audit data. Restore or rollback must keep traffic closed until compatible custody
and fresh authentication are restored. No fallback or role/proof weakening is
introduced to keep an old binary alive.

Configured owner recipient and verified sender must be explicitly supplied;
Microsoft/email claims do not select them. Source/runtime fixtures qualify
current provider-mode isolation and whole-HTTP progression; separately pinned
qualified browser tests cover their stated software scope. Actual Microsoft
primary, physical keys and recovery, sender receipt, operational restore and
zero-additional-spend deployed cutover still require independent evidence.
No resource, plan, paid compute or email is triggered by source preparation.

## Evidence

The profile/negative cases cover all six surface/environment combinations,
immutable verified-TLS pool settings, old-loader rejection, cross-surface/legacy
keys, origins, deployment/artifact identity, unsafe connection parameters,
role aliases, pool bounds and PROD synthetic denial. Hosted artifact cases add
external digest/profile/byte qualification, path/symlink/foreign-plane refusal,
captured-buffer isolation, transport bounds and unchanged API routing. Required
exact-source quality/native/browser/permanent/security gates and reviews remain
mandatory; their current status belongs to the PRs and SaaS1 issue351. None is
deployed isolation or operating acceptance by itself.
