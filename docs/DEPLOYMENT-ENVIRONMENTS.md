# Deployment environments

## Status and authority

The deployment names are `dev`, `int` and `prod`. These are server-controlled
configuration labels, not browser-selected routing or authorization values.
Root `AGENTS.md`, the existing security configuration and the cross-repository
production topology remain authoritative.

| Deployment | `DEPLOYMENT_ENVIRONMENT` | `NODE_ENV` | Use |
| --- | --- | --- | --- |
| Development | `dev` | `development` | Developer runtime |
| Integration / pilot / demonstration | `int` | `pilot` | Production-like security; controlled non-production customers |
| Production | `prod` | `production` | Productive customers |

Automated tests continue to use `NODE_ENV=test` and have no deployment identity.
Do not rename `NODE_ENV` to `int` or `prod`. An explicit deployment label that
does not match its runtime profile fails startup in both Customer and Platform
configuration. Existing configurations without the label derive the mapping
above, preserving current runtime requirements.

## Registration and secret separation

Prepare one Customer registration and one Platform registration for each of the
three environments: six registrations in total. This inventory is a target, not
evidence that the registrations or hosted environments exist.

- Customer registration: organizational multi-tenant login; callback
  `/api/v1/auth/microsoft/callback` on that environment's Customer origin.
- Platform registration: the operator directory only; callback
  `/api/v1/platform/auth/microsoft/callback` on its separate Platform origin.
- A Tenant Operator uses the existing `tenant_admin` Customer authorization
  domain. It does not receive a Platform Principal or Platform privileges.
- Each environment has separate credentials, OIDC/session/CSRF secrets, data
  stores and deployment settings. Customer and Platform registrations and
  secret domains remain separate within an environment.
- A registration does not activate a deployment or grant Microsoft Graph
  consent in a customer directory. Graph scope and calendar acceptance remain
  separately governed integration requirements.

## Staged activation

Initially, only `int` is intended to host development, integration/pilot work and
demonstrations. Prepare `dev` and `prod` without activating additional hosted
resources. Before the first productive customer starts, activate the separate
environments and move development to `dev`.

This decision does not relax HTTPS, identity, session, CSRF, authorization,
database TLS, release or recovery requirements for `int`. Retain an immutable
tested release and a compatible recovery path while development and
demonstrations share it. Do not promote resettable test data or credentials into
Production as part of activating `prod`.

## Implementation boundaries still open

The current Shared Demo remains a deliberately simulated identity/provider
runtime. This configuration change does not convert it into `int`, add email
authentication, enable private Microsoft accounts, or permit real credentials
in Demo configuration.

The planned invitation-only `int` experience requires its own reviewed identity
and persistence changes: invitation-bound membership, email-code authentication,
Tenant Admin invitations and role assignment, provider mode per Tenant, and
reset isolation that preserves real users/Pilot customers. Keep existing
three-customer Demo acceptance intact until the replacement passes its gates.
