# SaaS 2 modular backend boundaries

## Status

This document extends `ARCHITECTURE.md`, the security baseline, and the repository coding standards. Existing SaaS 1 provider composition remains supported; SaaS 2 code follows these constraints without compatibility shortcuts.

## Dependency direction

The required direction is `HTTP transport -> application services -> domain and authorization policy -> explicit ports/contracts -> infrastructure adapters`. The Composition Root wires PostgreSQL, Microsoft, and runtime adapters. Application services do not import HTTP or persistence. Domain and authorization policy do not import application, HTTP, persistence, provider, or composition modules.

## Bounded configuration domains

Organization, locations/rooms, catalogue, booking policies, and cost allocation remain separately owned domains. User lifecycle, Microsoft operations, and audit remain separate operational domains. Generic mutable settings services or repositories are forbidden.

The common versioning protocol is limited to optimistic concurrency, immutable history, rollback, and atomic audit coordination. Each domain retains its own validator, application wrapper, persistence adapter, and route module. Domain-specific fields and decisions do not belong in the shared protocol/store.

Tenant authority comes from the authenticated principal and resolved Tenant context. Route or payload Tenant selectors are never authoritative. Production configuration does not fall back to Demo fixtures, browser storage, or a legacy unversioned mutation path.

## Route and persistence ownership

The five route modules below `src/http/settings/` use the executable route-module contract. Their shared transport parses only the bounded revision protocol and delegates to an injected domain service. Domain schemas, SQL, and provider behavior remain outside HTTP.

`configuration-revision-store.js` owns Tenant locking, optimistic revision checks, immutable revision/history persistence, head changes, and atomic audit append. Domain repositories own initialization from and projection into operational tables. They do not accept caller-controlled Tenant identifiers, generic table names, or dynamic SQL identifiers.

Append-only revision and audit rows are protected by database triggers. Down migrations fail closed while non-initial history or materialized settings exist. Architecture exceptions require a documented decision and regression updates; weakening a gate to make implementation pass is prohibited.
