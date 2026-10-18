# Isolated object-backed media measurement

Scope: isolated measurement tooling for application #269/#270. Successful exact-source
PostgreSQL and complete CI/browser evidence must be retained before numerical acceptance.
This is separate from the target-host run described in SAAS-3.8-TARGET-LOAD.md.

`measureRoomMediaReads` reuses the existing bounded loopback measurement transport.
It accepts at most 1,000 canonical asset IDs and session cookies on one fixed attached
Room route. It verifies WebP/private-cache/nosniff/opaque-validator contracts, caps
binary accumulation at 2 MiB and preserves fixed deadlines, no redirects, no retry,
settled cancellation and caller-owned exact-byte verification. JSON operation bounds
remain unchanged. Full 200 and matching-validator 304 reads are independent phases.

The disposable PostgreSQL18 test composes the real Customer HTTP/session/authorization,
Room attachment repository and external-object metadata/integrity path. Only the
object-storage port is an explicit in-process fixture; no Neon SDK/network or actual
provider latency is measured. Ten synthetic Tenants have colliding Room IDs, one
attached image each, ten separate Managers and 100/1,000 generated Employee sessions.
The first three retained canonical room images are cycled across Tenants. Upload
sanitization/publication, fixture setup and pool warmup stay outside measured reads.
SQL asserts no fallback database blobs exist.

Every full body matches its exact sanitized asset. Each conditional read still
requires one full fixture object read/integrity verification. Count those bytes
separately from the zero-byte outgoing 304 body. Anonymous/foreign-asset denials must
perform no object read, and corrupt bytes must return the safe 503 rather than 304.
Verify every Tenant audit chain before reporting results.

This image distribution and two endpoint cache phases are controlled baselines,
not approved popularity/cache proportions. Do not infer billed provider egress,
monthly savings, a representative sixteen-operation replay, cold/worker behavior
or current Render capacity. No normal runtime, schema, Demo seed, provider resource,
deployment, credential, plan or quota changes are part of this tooling.
