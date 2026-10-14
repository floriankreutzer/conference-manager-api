# Temporary Platform Demo access perimeter

The owner requested a temporary shared password prompt on the Platform/Operations Demo
while the general Demo login is being prepared. This is an additional Demo-only perimeter,
not a Production identity provider, operator identity, MFA assertion or role grant.

## Configuration and credential custody

Set `DEMO_PLATFORM_ACCESS_MODE=password` and supply `DEMO_PLATFORM_ACCESS_PASSWORD_SHA256`
through the existing Platform service's protected environment configuration. An unknown mode,
unknown access key, absent/malformed hash or a hash supplied in public mode aborts startup.
Without either setting the existing public synthetic Demo remains compatible with isolated CI.
Customer and Production entrypoints do not install this gate.

Generate a fresh 32-byte random password encoded as base64url (43 characters). The browser's
native HTTPS Basic authentication prompt uses username `ops`. The server stores only
SHA-256 over `conference-manager:demo-platform-access:v1:` followed by that password.
This digest is appropriate only for the generated high-entropy credential; it is not a
password-storage design for human-selected passwords. Never commit or log the password or
digest, include either in a URL, add either to frontend files, or reuse another service key.
Deliver the credential privately to the owner. Rotate the hash and redeploy to revoke access.
Browsers manage Basic credentials themselves; there is no application logout or per-user
identity for this perimeter. Closing the private browser session clears its cached credential.
Replace this mechanism with the general login before any Production identity assurance claim.

## HTTP and authority contract

The gate runs before static serving, Demo PostgreSQL access, persona routes, reset and normal
Platform routes. Missing, wrong, malformed or duplicate Authorization headers produce 401
with the fixed Basic realm. It validates exact HTTPS-origin Host, present Origin and safe request
targets, strips Authorization from all Node request header views before downstream code, and
does not expose credentials in response bodies, logs or metrics. Thirty failures per socket
address per minute are permitted; state is bounded to 1,000 keys. Forwarded addresses are
untrusted. Correct credentials and provider health probes do not consume the failure budget.
This local limiter is a single-process Demo control, not a distributed edge quota.

Only exact, bodyless GET requests to Platform health/live, health/ready and health/deploy bypass
the password. Dependency readiness, closed/expired traffic, normal Platform sessions, role and
target-scope checks, step-up and session-bound CSRF remain authoritative and unchanged.
Possession of the shared password does not issue a Platform session or grant any permission.
There is no new database table, migration, provider request, dependency or frontend change.

Denied perimeter requests use the existing minimized operational authentication telemetry:
only a generated request ID, fixed category/event and timestamp. No shared-password holder
is represented as a durable authenticated operator audit actor.

The native prompt protects the entire Operations origin, including direct API and asset requests.
API clients and future Hosted acceptance must explicitly supply the perimeter credential through
protected configuration. Do not weaken the permanent isolated browser acceptance journeys or
reuse expired media-operation acceptance tokens to bypass the perimeter.

## Release evidence boundary

Run focused negative HTTP tests and the complete repository CI/security, PostgreSQL and paired
browser gates before merging. Deploy the reviewed immutable commit, preserve the existing media
storage/traffic settings and verify: unauthenticated root and session reject; the correct password
loads the Operations UI; wrong credentials reject; exact deploy readiness remains dependency-based.
Record only non-secret commit/deployment IDs and test outcomes. Local tests do not prove live access.
The private provider graph and actual email delivery are separate work and are not implemented here.
