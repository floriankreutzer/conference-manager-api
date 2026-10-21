# Qualified two-site browser runtime fixture

This test-only bootstrap starts the unchanged closed Customer and Platform roots
with actual verified PostgreSQL TLS/SCRAM, fresh positive restricted roles,
independent max1 business/lease pools and the exact64/28 ledger. It accepts only
immutable API/frontend commit references. Origins are fixed to default-port
HTTPS `app-int.example.test` and `ops-int.example.com`, different registrable
sites. No HTTP auth/test/provider/driver/clock port enters either production root.
No cloud database, image pull, paid service or real mail is used.

Only initial operator custody is test state: canonical protected normal MFA
session and two independent generated software P256 credentials. This does not
exercise Microsoft primary authentication, physical key independence, actual
enrollment/recovery or deployment cutover. The existing software credential
fixture can export its own ephemeral PKCS8 private key for Chromium's native
virtual authenticator. That key is generated in memory, never committed, logged,
saved to an artifact or sent to a web page. WebKit may use an explicitly named
test-only origin-bound software signing bridge; that is not native hardware or
WebKit WebAuthn-engine proof. The pinned server verifier stays real in both.

Migration paths are fixed to the checked-out API; the unchanged operator role
installer briefly uses its repository cwd during sequential setup and restores
the caller directory before a browser or runtime starts. The common process
fixture now resolves its own existing child modules/cwd by import.meta.url,
preserving the same startup/stop/log bounds from outside the repository.
Native bootstrap acceptance covers both actual roots from /tmp, current canonical
Platform session, unauthenticated Customer refusal, plane separation, no seeded
generation and cleanup. Full qualified browser frontend/edge/cookie/RP/journey
execution is owned by a separately pinned frontend acceptance change.

Evidence exposes only exact source refs, bounded nonsecret tenant state/counts
and verified tenant audit chains. Actual child output is checked for fixture
credentials/secrets without printing them. Native fixture cleanup closes both
roots, owner pool and isolated generated container/keys. No fixture issuer is
available to a deployed runtime. Source tests verify closed refs, fixed distinct
sites and matching ephemeral PKCS8/COSE ES256 public key material. The initial
unit used an unavailable SDK decode method; inspection of the exact installed
pinned SDK selected decodeFirst instead, preserving byte-equality assertions.

Native bootstrap, fresh full CI/permanent unchanged four paired three-customer/
two-reset journeys and actual-main gates remain pending. Local Docker/browser
executables are absent; no native/browser pass is claimed. SaaS1 issue351.
