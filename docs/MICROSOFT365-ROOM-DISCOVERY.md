# Microsoft 365 Room Discovery

## Authority

Root `AGENTS.md`, `docs/CODING-STANDARDS.md`, `docs/ARCHITECTURE.md`, `docs/AUTHORIZATION.md`, and `docs/MICROSOFT365-CONNECTION.md` remain authoritative.

Room discovery is a Tenant Admin use case layered on the existing Microsoft 365 connection. It does not create or import Conference Manager rooms automatically and does not grant the browser authority over an internal Tenant, Microsoft Tenant, provider credential, Graph destination, or provider permission.

## Microsoft Graph baseline

Validated against current Microsoft Graph v1.0 documentation on 2026-08-25:

- room collection: `GET https://graph.microsoft.com/v1.0/places/microsoft.graph.room`;
- least-privilege delegated and application permission: `Place.Read.All`;
- room/workspace/room-list default page size: 100;
- supported list query controls include `$select`, `$top`, and `$skip`.

The application uses only the application-permission path through the existing confidential-client Microsoft 365 provider. `Place.ReadWrite.All` is not required for discovery.

Official references:

- Microsoft Graph v1.0 — List place objects: `https://learn.microsoft.com/graph/api/place-list?view=graph-rest-1.0`
- Microsoft Graph v1.0 — Room resource: `https://learn.microsoft.com/graph/api/resources/room?view=graph-rest-1.0`
- Microsoft Graph permissions reference — `Place.Read.All`: `https://learn.microsoft.com/graph/permissions-reference`

## HTTP contract

`GET /api/v1/integrations/microsoft365/rooms`

Requirements:

1. authenticated server Principal;
2. server-derived known Tenant context;
3. `tenant_admin` with `tenant:integrations:manage`;
4. active Entra Tenant binding;
5. Microsoft 365 connection for the same bound provider Tenant;
6. Places permission positively verified as `granted`.

No query parameters, request body, internal Tenant ID, provider Tenant ID, access token, or browser-selected Graph URL are accepted.

## Provider-neutral discovery model

Each returned room exposes only bounded onboarding metadata:

- `externalRoomId` — stable Microsoft room/place identifier;
- `displayName`;
- `resourceAddress` — room resource email address;
- `capacity`;
- optional building/floor/label/nickname/phone and device/booking metadata when safely shaped.

Provider objects are untrusted input. Missing optional properties normalize to `null`. Missing or malformed required identity properties fail the page closed rather than inventing a room identity. Access tokens and raw provider responses are never returned.

## Pagination and outbound controls

The provider client constructs the Graph URL itself. Discovery uses bounded pages of 100 and a maximum of 100 pages. `$skip` is generated server-side; provider-controlled continuation URLs are not followed. Every request is restricted to the configured Microsoft Graph origin, uses redirects disabled, and inherits the existing bounded timeout and response-size controls.

This trades a finite maximum discovery set for a deterministic SSRF-safe outbound contract. A tenant exceeding the bound receives an unavailable discovery result instead of unbounded Graph traversal.

## Failure mapping

- Graph `401` / invalid consent -> connection revoked/conflict state;
- Graph `403` -> Places permission missing/conflict state;
- Graph `429` -> transient discovery unavailable/throttled;
- Graph `5xx` or transport timeout -> transient discovery unavailable;
- malformed or overlarge Graph data -> discovery unavailable/fail closed.

Provider error text and response bodies are never reflected to the browser.

## Tenant isolation

The provider Tenant is corroborated from both the Tenant-owned Microsoft 365 connection and the active Entra Tenant binding. A mismatch fails before Graph is called. No external room identifier can select another Tenant's Graph context.

Room import and synchronization ownership are intentionally outside this contract and remain owned by the subsequent room-mapping capability.

## Test evidence

Automated coverage must include nominal normalization, missing optional data, malformed required data, bounded pagination, permission and throttling errors, fixed Graph destination, provider-Tenant mismatch, authorization denial and token/redaction checks. Repository quality, dependency, secret and PostgreSQL integration gates remain mandatory.

Real room discovery against customer Microsoft tenants remains an external Pilot acceptance step and must not be claimed until executed with actual Entra consent.
