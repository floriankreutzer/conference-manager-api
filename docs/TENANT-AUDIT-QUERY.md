# Tenant audit query and change history

## Authority and scope

Root `AGENTS.md`, `docs/CODING-STANDARDS.md`, `docs/AUDIT.md` and
`docs/AUTHORIZATION.md` remain authoritative. This document defines the SaaS 2 bounded query extension for
issue #88. It reuses the existing append-only `audit_events` table, HMAC chain, audit service and
`tenant:audit:read` authorization. It creates no second audit store or mutable history representation.

## Query contract

`GET /api/v1/audit` continues to derive Tenant authority only from the authenticated Principal. It accepts
the following optional single-value parameters:

- `limit`: 1-100, default 50;
- `beforeId`: positive numeric cursor;
- `category`: `user`, `configuration`, `request`, `integration` or `security`;
- `outcome`: `success`, `failure` or `denied`;
- `actorUserId`: internal User UUID inside the current Tenant scope;
- `from` and `to`: canonical UTC instants.

The default query window is the 30 days ending at server evaluation time. A caller can supply a different
window of at most 90 days. Reversed, noncanonical, excessively wide or materially future windows fail
validation. Unknown/duplicate query fields and any Tenant selector fail validation.

Filtering is applied through fixed parameterized predicates. Category values map server-side to the known
audit action taxonomy; browser input never becomes a SQL identifier or audit authority.

## Integrity and isolation

Before any filtered page is returned, the service verifies the complete HMAC chain for the authenticated
internal Tenant using the existing audit repository. Query filtering does not narrow or bypass integrity
verification. A corrupt/unknown chain returns `AUDIT_INTEGRITY_UNAVAILABLE`; it is not presented as an empty
result.

The query adapter always includes internal `tenant_id` in SQL. Actor, action, outcome, time and cursor filters
are additional restrictions, never alternative Tenant authority. Platform/operator audit remains a separate
authorization domain and is not inferred from missing Tenant events.

## Public event representation

The response includes `events`, `nextBeforeId`, the normalized `window` and server `requestId`. Each event is
projected to:

```json
{
  "id": "42",
  "category": "configuration",
  "action": "tenant.configuration.changed",
  "actor": { "userId": "internal-user-uuid" },
  "target": { "type": "catalogue", "id": "tenant-catalogue" },
  "outcome": "success",
  "occurredAt": "2026-08-27T10:00:00.000Z",
  "correlationId": "server-request-uuid",
  "change": {
    "before": { "revision": 3 },
    "after": { "revision": 4 },
    "summary": { "activeServiceCount": 3, "serviceCount": 4 }
  }
}
```

Only an allowlist of small presentation-safe state keys and change-summary metadata is projected. The
optional `change.summary` never contains arbitrary metadata fields. Raw metadata, retention mechanics,
Tenant ID, HMAC fields, integrity version, tokens, session data, provider payloads and provider identifiers are
omitted. Integration and Tenant target IDs are suppressed because they are infrastructure/scope identifiers;
their canonical target type and event action remain available for localized presentation.

The API returns canonical action/category/reason semantics. The browser localizes those fixed identifiers and
must not display raw provider/internal error text.

## Operational handling

Every successful query appends the existing `audit.read` evidence with a bounded result count and whether
filters were applied. Authorization denials with a valid Tenant/actor context retain correlated
`authorization.denied` evidence.

When integrity is unavailable:

1. keep the customer-facing view fail closed;
2. retain the request/correlation ID;
3. investigate database restore, key/configuration and chain continuity through protected operational access;
4. do not edit/delete Tenant audit rows to make the view available;
5. follow the reviewed recovery/restore decision and record external acceptance evidence where required.
