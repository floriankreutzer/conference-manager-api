# Owned protected Customer process

`npm run start:protected:customer` is an explicit alternative process entrypoint.
It does not change either closed Demo, the ordinary entrypoint, deployment
configuration, existing conditional-access mode or any rollout flag. No process
has been activated against an external database or provider.

The owned factory accepts only explicit per-surface deployment configuration and
returns start/stop. It owns the production-mode configuration, canonical verified
TLS business/lease pools, persistent repositories, current schema/UUID/role
readiness, pinned fresh organizational Microsoft primary adapter, invited-only
email/Microsoft admission, optional current signed delegation, normal business
composition and whole-HTTP shared execution wrapper. No supplied identity,
issuer, verifier, driver, clock, handler, policy or provider implementation can
replace that chain. Before listening it requires actual role/current-deployment
readiness. Concurrent startup/shutdown is serialized; failure closes pools and
custody keys without reflecting driver/configuration details.

The canonical HTTP server now accepts an optional construction-only request
wrapper factory around its actual application. The default path remains the
same. Header bounds, request/header/keepalive timeouts and canonical application
guards remain in force. The protected root owns the wrapper; Host/origin/target/
rate/bounded-body checks precede the live shared lease, which spans authentication,
Tenant resolution, business work, provider work, audit and response construction.
Secure cookies still require the configured same-origin HTTPS edge; the internal
HTTP listener is not itself a public TLS edge.

The root's canonical Microsoft business facade is qualified against the current
server-owned REAL Tenant for the complete consent/discovery/mapping/verification/
connection operation. It never chooses a mode from provider IDs or browser input.
Calendar operations use the separately accepted current-mode factory and REAL
cleanup rules. No synthetic calendar factory exists in this change: synthetic
calendar work remains unavailable and cannot fall through to Microsoft. Durable
SIM state and its truthful discovery/media/UI/booking integration remain required.
The existing canonical final calendar-write authority also still needs the
reviewed synthetic branch before such writes may be enabled. Current catering
provider configuration remains the existing explicit, inactive/manual baseline.

Only an explicitly configured transactional mail adapter starts the bounded
single-flight worker. It owns current REAL eligibility and the enclosing lease
through claim/send/settlement. Missing adapter means no worker/send; configuration
does not prove sender-domain verification or delivery. No actual sender or owner
recipient is inferred. Shutdown stops scheduling and waits for the bounded
in-flight run before releasing persistence. Existing provider timeout/retry and
one-use proof/custody controls remain unchanged.

Seven local cases cover all three environments, closed output/no replacement
ports, configuration refusal/redaction, actual unavailable loopback DB plus
concurrent stop, canonical HTTP wrapping/limits and architecture direction.
The new native test starts a fresh, bounded, loopback-published PostgreSQL
container inside the existing native runner, using only its already-loaded
immutable service image (`--pull=never`). It does not alter the shared service
or any cloud resource. Fresh runtime passwords and test-only certificates are
generated at execution, never committed or printed, and removed with the
container/anonymous volumes. PostgreSQL uses actual TLS plus SCRAM host auth;
the migration-owner fixture installs canonical schema and positive runtime grants.

The actual child process runs the unmodified owned factory with its real pinned
adapters and private role credentials. Negative checks cover actual28P01 password
failure, untrusted CA and hostname startup refusal, actual driver hostname
rejection, and an actual refused HTTP connection after failure. The positive
test path exercises role readiness, actual HTTP mailbox challenge, decrypted fixture
queue code, CSRF, one-use invitation admission, current normal session/directory,
legacy-cookie denial, audit verification, redacted logs and graceful shutdown.
Queue decryption is explicit test-fixture access, not proof of email delivery.
The primary identity/provider adapters are never replaced; live Microsoft is not
invoked. No physical-device, cross-site browser, deployed immutable artifact-pair,
real sender, recovery or credential-cutover proof is implied. Exact-source native
execution, all four unchanged permanent full Demo pairs, then actual-main all9
contexts remain mandatory. Whole SaaS1/INT acceptance remains open in issue351.
