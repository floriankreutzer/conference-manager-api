# Microsoft Entra Pilot Validation Evidence

## Purpose

This document is the evidence template for the live Microsoft Entra checks required by SaaS 1 issue #58. Repository unit/integration/security tests validate the implementation boundary, but they do not prove that a specific Microsoft tenant or production application registration is configured correctly.

Do not store client secrets, authorization codes, access/refresh/ID tokens, cookies, raw claim payloads, or personal user identifiers in this evidence.

## Application registration evidence

Record only non-secret deployment metadata:

| Evidence | Value |
| --- | --- |
| Environment | Pending |
| Application registration owner | Pending |
| Supported account type | Pending — must be organizational multi-tenant |
| Redirect URI verified | Pending |
| Credential lifecycle owner | Pending |
| Credential expiry/rotation procedure reference | Pending |
| Validation date | Pending |
| Validator | Pending |

The expected supported account type is **Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant)**. The expected redirect URI is the exact HTTPS `PUBLIC_ORIGIN` plus `/api/v1/auth/microsoft/callback`.

## Independent Tenant validation

Use two independent organizational Entra test tenants. Record Tenant aliases rather than Tenant GUIDs where possible.

| Scenario | Tenant A | Tenant B | Evidence/result |
| --- | --- | --- | --- |
| Same SaaS application starts login | Pending | Pending | Pending |
| Microsoft organizational account authenticates | Pending | Pending | Pending |
| Validated identity reaches onboarding/claim policy | Pending | Pending | Pending |
| Browser Tenant manipulation cannot change validated Tenant | Pending | Pending | Pending |
| Logout invalidates Conference Manager session | Pending | Pending | Pending |

## Negative authentication validation

| Scenario | Expected result | Evidence/result |
| --- | --- | --- |
| Wrong audience | Authentication fails closed | Covered by repository tests; optional live negative test pending |
| Wrong/Tenant-mismatched issuer | Authentication fails closed | Covered by repository tests; optional live negative test pending |
| Expired token | Authentication fails closed | Covered by repository tests; optional live negative test pending |
| Invalid/replayed state | Authentication fails closed | Covered by unit + PostgreSQL tests; live check pending |
| Nonce mismatch | Authentication fails closed | Covered by repository tests; optional live negative test pending |
| Provider access denied | Fixed safe local failure result; no provider details reflected | Repository HTTP test; live check pending |
| Unclaimed Tenant | Onboarding/claim policy; no privileged session | Repository tests; live check pending |
| Provider group/role/email claims | Never grant Conference Manager/Tenant Admin privileges | Repository tests; live verification pending |

## Exit criteria

Issue #58 live verification can be marked complete only when:

- the production/Pilot application registration is confirmed organizational multi-tenant;
- the exact HTTPS callback URI is registered;
- the deployment credential is held in approved secret management with an owner/rotation process;
- two independent organizational Entra tenants successfully execute the same SaaS login flow;
- unsupported/unclaimed Tenant handling is verified;
- session logout/revocation is verified;
- no secret/token/PII evidence was persisted in this document.

A green repository PR is necessary but not sufficient evidence for these external checks.
