# Customer email authentication HTTP contract — unreleased

This explicitly injected route module is not installed by the ordinary Customer
composition or either closed Demo surface. Root `AGENTS.md`, the current session,
Tenant and invitation contracts remain authoritative. It does not activate INT,
provider dispatch, a sender, Microsoft linking or invitations administration.

The module composes through the existing Customer app and requires its fixed
HTTPS public origin, Host/target/method/body/rate guards, security headers,
server-generated request IDs and minimized error/log/metric contracts. Five fixed
low-cardinality telemetry keys contain no mailbox, proof, Tenant or User values.
No CORS, arbitrary URL, redirect, browser storage or provider request is added.

All endpoints are below `/api/v1/auth/email`. Queries are forbidden. Mutations
require the exact Origin, non-simple bounded JSON and, except for starting a new
anonymous challenge, the browser-bound transaction cookie and 64-hex CSRF header.
Fetch Metadata, when present, must be `same-origin`. Cookie/header values and
provider/database errors never enter public JSON or logs. Bodies are capped at
1024 bytes even if the host app permits larger ordinary business commands.

| Method and suffix | Closed command | Success |
| --- | --- | --- |
| POST `/challenges` | `recipient`, `locale` (`de` or `en`) | 202, neutral code-required state, expiry, CSRF, request ID; HttpOnly transaction cookie |
| GET `/pending` | Empty body | 200, current code/choice state, expiry, CSRF, request ID |
| POST `/verify` | Eight-character decimal `code` | 200, membership-required state, expiry, rotated CSRF and HttpOnly cookie |
| GET `/choices` | Empty body | 200, at most 100 proved current choices, each only opaque membership ID and display label |
| POST `/selection` | `membershipId` | 204, ordinary session cookie and cleared transaction cookie after committed admission |

No challenge ID, browser proof, recipient, role, provider reference or independent
Tenant ID is returned. Choice labels appear only after browser-bound mailbox proof.
Unknown/unadmitted recipients use the same pre-proof durable response contract;
this does not assert equal timing across all deployments. Shared database source/
recipient budgets and attempt counts retain authority across instances. A limited
request has generic 429 with fixed Retry-After 60; that header is guidance, not a
promise that hourly budget has recovered. Invalid/stale proof has generic 401.
Neither failure issues a session or automatically resends a code.

Source keys use only the server-observed socket address, HMAC-separated per
environment. Forwarded headers are ignored. Trusted reverse-proxy policy, public
edge/resource bounds and deployment timing verification remain activation gates;
a reverse proxy must not silently make arbitrary forwarded input authoritative.

Private service outputs are positively projected. Transaction-cookie serialization
validates canonical browser proof and bounded lifetime. Ordinary session output
must match the existing exact Secure/HttpOnly/Lax `/api` cookie contract without
extra attributes. The route performs selection once, waits for the admission
transaction, then sends cookies. A lost HTTP response or subsequent session-refresh
failure must not cause blind automatic selection retries; the proof is single-use.

Five real loopback HTTP cases cover full request/pending/verify/choice/selection,
leading zeroes, source-header spoofing, cookie/CSRF/origin/body/query/method denials,
private output bounds, error redaction and opt-in composition. The loopback socket
is a test transport behind the declared HTTPS public-origin contract, not deployed
TLS evidence. Native database concurrency, browser UI/keyboard/DE/EN, complete CI,
real sender/receipt and protected INT acceptance remain separately required.
