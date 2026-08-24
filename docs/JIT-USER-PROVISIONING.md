# Just-in-Time User Provisioning

## Scope

This document defines the server-side just-in-time (JIT) User provisioning contract for SaaS 1 issue #60. Root `AGENTS.md`, `docs/CODING-STANDARDS.md`, `docs/IDENTITY-SESSION.md`, `docs/AUTHORIZATION.md`, and `docs/ENTRA-AUTHENTICATION.md` remain authoritative for their respective boundaries.

JIT provisioning removes bulk directory synchronization as a prerequisite for the Pilot. It does not import Microsoft directory authorization into Conference Manager.

## Trust flow

```text
Microsoft Entra OIDC
  -> protocol and claims validated by the Entra adapter
     -> provider-neutral external identity
        { provider, tenantReference, userReference, displayName }
     -> active internal Tenant <-> provider-Tenant binding lookup
     -> JIT User resolver
        -> PostgreSQL User + provider identity binding
        -> fixed Employee authorization snapshot
     -> existing server-side session service
```

The browser never selects the internal Tenant, internal User, role, permission, provider Tenant, or provider User authority.

An invitation-backed authentication transaction remains owned by the Tenant-claim flow from issue #59. JIT provisioning is used only for a normal login after the external Tenant has already been claimed.

## Identity key

A local User is resolved by the complete trusted identity tuple:

- internal Tenant UUID;
- provider identifier;
- validated provider Tenant reference;
- validated provider User reference.

Email address, username text, display name, email domain, provider groups, and provider roles are not identity keys.

Including both the internal Tenant and provider Tenant reference prevents a stale external User binding from being reused after an internal Tenant is unbound from one provider organization and rebound to another.

## Safe default authorization

A newly provisioned User receives only the current Employee authorization snapshot:

- role: `employee`;
- permission: `request:read`;
- permission: `request:cancel`.

JIT provisioning never infers `conference_manager`, `tenant_admin`, Platform/operator privileges, or additional permissions from:

- email domain;
- display name;
- provider groups;
- provider roles;
- browser/request fields;
- provider claims that are not part of the approved identity contract.

Tenant-scoped elevated-role administration is a separate authorization operation owned by issue #61.

## Persistence

Migration 009 introduces `user_identity_bindings`.

The binding is Tenant-owned and uses the composite key:

```text
(tenant_id, provider, provider_tenant_reference, provider_user_reference)
```

The row references the existing Tenant-owned `users` record through `(tenant_id, user_id)`.

The existing `users.active` flag remains authoritative for local offboarding. The existing `users.security_version` remains authoritative for stale-session invalidation.

The JIT transaction uses a PostgreSQL advisory transaction lock derived from the complete identity tuple. Concurrent first logins for the same identity therefore serialize and resolve to one local User rather than creating duplicate identities.

## First login

For a validated external identity whose provider Tenant is actively bound:

1. the Tenant is checked for a login-available lifecycle state;
2. the complete User identity tuple is locked;
3. an existing binding is resolved if present;
4. otherwise one local User is created;
5. one `user_identity_bindings` row is created;
6. `tenant.user.provisioned` audit evidence is appended in the same transaction;
7. only after commit may session issuance proceed.

If required audit persistence fails, User and identity-binding creation roll back.

## Repeat login and profile refresh

Repeat login resolves the existing local User deterministically.

The validated bounded display name may refresh `users.display_name`. A display-name change:

- does not create a second User;
- does not change roles or permissions;
- does not increment privilege state;
- appends `tenant.user.profile_updated` audit evidence atomically with the profile update;
- does not copy the display name itself into audit metadata.

Email claims are not persisted by this JIT contract.

## Fail-closed conditions

No application session is issued when:

- the external identity is malformed;
- the provider Tenant has no active internal Tenant binding;
- the internal Tenant is suspended, archived, pending, or otherwise not available for JIT login;
- the resolved local User is disabled;
- authoritative persistence fails;
- required audit persistence fails;
- the JIT repository returns an unknown state.

An unknown provider Tenant remains an onboarding-required result and cannot provision a User.

## Rebinding behavior

Provider-Tenant rebinding does not make prior provider-User bindings authoritative for the new organization.

After an old Tenant identity binding is unbound:

- login from the old provider Tenant no longer resolves the internal Tenant;
- the same provider User reference in a newly bound provider Tenant is treated as a distinct external identity;
- an old local User is not silently reused across the provider-Tenant boundary.

Historical binding cleanup or account reconciliation must be an explicit support/governance operation. It must not be inferred from browser input.

## Audit and privacy

JIT security audit actions are:

- `tenant.user.provisioned`;
- `tenant.user.profile_updated`.

Audit records use the internal Tenant and internal User as authority. Provider Tenant/User references, email, display name, raw OIDC claims, tokens, cookies, and secrets are not copied into JIT audit metadata.

Operational logs must continue to follow the repository redaction and low-cardinality rules.

## Migration and rollback

Migration 009 is versioned and explicit. Runtime schema readiness is version 9.

Rollback fails closed with SQLSTATE `55000` when JIT User bindings or JIT audit evidence exist. Operators must review/reconcile those rows before a destructive rollback can proceed.

## Verification

Required automated coverage includes:

- first login;
- repeat login;
- concurrent first login;
- same provider User reference in different Tenants;
- provider-Tenant rebind isolation;
- changed display name;
- disabled local User;
- unavailable Tenant;
- malformed external identity;
- attempted provider/client privilege injection;
- audit-atomic rollback;
- migration rollback protection;
- existing session, Tenant, onboarding, authorization, DAST, static, dependency, and secret-scan regression gates.

Real Microsoft Pilot acceptance still requires live identities from independent Microsoft organizations. Automated repository tests do not substitute for that external acceptance evidence.
