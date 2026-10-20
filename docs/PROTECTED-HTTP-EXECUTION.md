# Protected HTTP execution boundary

This opt-in transport is not yet composed or deployed. It owns no session,
Tenant permission, operation proof, lifecycle or reset grant. Full protected INT
roots, browser/provider/worker acceptance and operating cutover remain open in
frontend SaaS1 issue351. Closed Demo graphs must not import it.

The future owned Customer and Platform roots must supply their canonical app,
fixed HTTPS configuration and actual distinct-pool/current-UUID execution scopes.
The Platform root supplies the fixed Platform transport-boundary adapter; the
shared transport cannot import Platform identity or control-plane modules.

Method, target, host, Origin, bounded local rate state, declared and actual body
bytes, encoding and actual upload deadline are checked before a database lease.
Uploads are staged in bounded memory, with the canonical two-MiB media upload
limit only on the exact Customer image-upload shape; other bodies retain the
configured maximum. Route content type, empty-body, exact schema, authorization
and CSRF checks still run on a separate single-use read view. The original
IncomingMessage is not modified. No body, cookie or proof is logged. A failed
preflight closes the connection, preventing reuse of an unread partial upload.

The same current shared lease surrounds the whole awaited app: actual session
resolution, current Tenant context, business/provider work, audit and response
construction. Nested canonical scopes join it using their private live marker;
it does not hold a business connection. This avoids stale identity/context reads
outside the reset barrier and supports max1 on each fixed pool. Business services
must still validate current membership, object ownership and runtime mode.

Only exact canonical GET health probes and the two fixed Platform POST proof
completions omit this outer lease. The latter are generation replacement and
synthetic delegation approval. Their canonical protocols still own current
preparation, exact operation-bound passkey proof and the exclusive transaction.
Trailing paths, other methods, query-controlled names and Customer lookalikes do
not select this exception. No arbitrary root-provided list or browser flag does.
Static assets belong to a separately validated immutable static handler, not this
API transport. This adapter does not implement response buffering or make the
shared coordination transaction an authoritative business transaction. Each
business/proof service remains responsible for commit-before-success semantics.

Gate errors produce minimized503 before app entry; unexpected failures produce500
without exception details or uncommitted cookies. The transport preserves ordinary
HTTP security headers and closes failed connections. Existing apps retain their
own request observability, rate policy and route/Principal guard contracts.

Focused native HTTP tests cover read-view preservation, exact exceptions,
preflight denials, streamed bounds, real partial-upload expiry, local rate bounds,
closed configuration, stale gate failure and no-cookie unexpected failure. The
new PostgreSQL integration fixture must prove the canonical Platform session
handler resolves an actual protected session under the shared lease with max1
pools, blocks concurrent exclusive reset, releases on completion and rejects an
actual epoch rotation before another Principal read. It uses explicit internal
fixture primary custody; it proves no real Microsoft login, independent physical
keys, browser TLS/CSP, full runtime or deployment acceptance. Native CI execution
is pending. No migration, external request, paid resource or live action is added.
