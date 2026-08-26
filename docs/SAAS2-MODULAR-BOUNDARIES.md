# SaaS 2 modular backend boundaries

## Status

This document defines the permanent backend architecture constraints introduced for SaaS 2. It extends `ARCHITECTURE.md`, the security baseline and the repository coding standards. Existing SaaS 1 provider composition remains supported; new SaaS 2 code must follow these rules without compatibility shortcuts.

## Dependency direction

The required direction is:

`HTTP transport -> application services -> domain and authorization policy -> explicit ports/contracts -> infrastructure adapters`

The Composition Root in `src/index.js` wires concrete PostgreSQL, Microsoft and runtime adapters. Application services do not import HTTP, PostgreSQL, configuration or composition modules. Domain and authorization policy do not import application, HTTP, persistence, provider or composition modules. PostgreSQL and provider adapters do not depend on HTTP or application services.

The reviewed SaaS 1 Microsoft application modules may continue to consume the existing Microsoft contract constants. This explicit compatibility boundary does not authorize new non-Microsoft application services to import concrete provider clients.

## Bounded settings domains

SaaS 2 configuration is implemented by the owning bounded domain, for example locations/rooms, catalogue, booking policies, cost allocation, User lifecycle, Microsoft operations and audit. Generic mutable `settings` services, repositories or route families are forbidden because they erase ownership, authorization, versioning and audit semantics.

Each domain owns its contract, validation, authorization requirements, persistence port, PostgreSQL adapter and HTTP route family. Tenant authority is derived from the authenticated principal and resolved Tenant context; route or payload Tenant selectors are never authoritative.

## HTTP route ownership

`src/http/route-module.js` defines the registration contract for new SaaS 2 route families. A route module has a stable identifier, a route-key resolver and an injected handler factory. The contract provides deterministic route ownership, duplicate detection and bounded dispatcher composition.

Existing SaaS 1 routes remain operational during incremental extraction. New settings route families below `src/http/settings/` or named `*-settings-routes.js` must use `defineRouteModule`; they must not add domain schemas, SQL or provider behavior to the central dispatcher.

## Automated enforcement

`npm run check:architecture` runs the existing architecture gate followed by `scripts/check-module-boundaries.mjs`. The general gate:

- rejects source import cycles and unresolved relative imports;
- enforces application, domain/policy, HTTP, PostgreSQL and provider dependency boundaries;
- prevents unauthorized concrete provider imports;
- rejects generic `settings`, `utils`, `helpers` and `common` dumping grounds;
- requires the route-module contract for new SaaS 2 settings routes.

`tests/module-boundaries.test.js` contains positive and intentionally invalid graph fixtures. `tests/route-module.test.js` protects route registration and dispatch behavior. Architecture exceptions require an explicit documented decision and corresponding regression updates; weakening the gate to make an implementation pass is not permitted.
