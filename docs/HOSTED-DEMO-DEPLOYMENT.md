# Hosted Shared Demo Deployment — Render Free + Neon Free

## Purpose and authority

This runbook deploys the SaaS 3.5 Shared Demo Runtime on the accepted zero-cost provider-domain topology:

- Customer Demo: Render Free Web Service in Frankfurt;
- Platform Admin Demo: separate Render Free Web Service in Frankfurt;
- authoritative shared data: Neon Free PostgreSQL 18 in AWS `eu-central-1` / Frankfurt;
- public addresses: Render-managed `*.onrender.com` HTTPS origins;
- no custom domain;
- GitHub Pages remains only a static fail-closed compatibility/launcher surface.

This is a Demo-only deployment. It does not select a Production provider and does not replace Production identity, provider, penetration, restore or customer acceptance evidence.

The canonical Shared Demo architecture and security contract remains `docs/SHARED-DEMO-RUNTIME.md`. This runbook adds only provider packaging, initial database setup and deployment operations.

## Target topology

```text
https://conference-manager-demo.onrender.com
  /                       -> pinned Customer Demo browser artifact
  /api/*                  -> Customer Demo API process
                              \
                               -> Neon conference_manager_demo_shared
                              /
https://conference-manager-ops-demo.onrender.com
  /                       -> pinned Platform Admin Demo browser artifact
  /api/v1/platform/*      -> Platform Demo API process
```

The two services remain separate origins and security domains. They have different cookies, sessions, CSRF secrets and PostgreSQL runtime roles. They share only the canonical Demo database state and the stable Tenant-audit HMAC key required for the same Tenant audit chain.

## Provider baseline

The accepted Demo provider settings are:

| Component | Setting |
| --- | --- |
| Render Customer service | `conference-manager-demo` |
| Render Platform service | `conference-manager-ops-demo` |
| Render plan | Free |
| Render region | Frankfurt |
| Neon project | `conference_manager_demo` |
| Neon region | AWS `eu-central-1` / Frankfurt |
| Neon database | `conference_manager_demo_shared` |
| PostgreSQL | 18 |
| Custom domain | None |

If either Render service name is unavailable, stop the deployment. Change both the service name and the corresponding exact `DEMO_*_ORIGIN` value through a reviewed repository change before creating the services. Do not deploy under an ad hoc URL and relax origin validation afterward.

## 1. Create the four Neon roles

Create the runtime roles with SQL, not through the Neon Console role-creation UI. Neon roles created through the Console/API/CLI receive broad `neon_superuser` membership; SQL-created roles receive only the PostgreSQL privileges explicitly granted to them.

In the Neon SQL Editor, connect to the default database as the project owner and execute the following after replacing each password placeholder with a unique high-entropy URL-safe value. Do not reuse passwords and do not store them in source, issue comments, screenshots or documentation.

```sql
CREATE ROLE cm_demo_customer
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  PASSWORD '<CUSTOMER_DB_PASSWORD>';

CREATE ROLE cm_demo_platform
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  PASSWORD '<PLATFORM_DB_PASSWORD>';

CREATE ROLE cm_demo_reset
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  PASSWORD '<RESET_DB_PASSWORD>';

CREATE ROLE cm_demo_migration
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  PASSWORD '<MIGRATION_DB_PASSWORD>';
```

Use at least 32 random bytes of entropy for each credential. Prefer URL-safe values so the password does not require manual percent-encoding inside a PostgreSQL URL.

If any of these roles already exists, do not silently reuse it. Verify its attributes and intended ownership before continuing.

## 2. Create the Neon Demo database

In the Neon Console:

1. Open project `conference_manager_demo`.
2. Open the `production` branch.
3. Open **Roles & Databases**.
4. Select **Add database**.
5. Database name: `conference_manager_demo_shared`.
6. Database owner: `cm_demo_migration`.
7. Create the database.

Then connect to `conference_manager_demo_shared` as the Neon project owner and restrict database connection authority:

```sql
REVOKE CONNECT ON DATABASE conference_manager_demo_shared FROM PUBLIC;
GRANT CONNECT ON DATABASE conference_manager_demo_shared
  TO cm_demo_customer, cm_demo_platform, cm_demo_reset, cm_demo_migration;
```

Do not manually create application tables, views, migration ledgers, Demo sentinels or seed rows. Those belong exclusively to the repository migrations and deterministic reset contract.

## 3. Create the four database connection URLs

For each of these roles, obtain a **direct/unpooled** Neon PostgreSQL connection string targeting `conference_manager_demo_shared`:

- `cm_demo_customer`;
- `cm_demo_platform`;
- `cm_demo_reset`;
- `cm_demo_migration`.

The application deliberately configures certificate and hostname verification through `DEMO_DATABASE_SSL=verify-full`. The current Demo URL contract therefore does not accept query parameters. If Neon shows a URL ending with a query such as `?sslmode=require&channel_binding=require`, remove the complete query portion before storing the URL.

The final shape is:

```text
postgresql://ROLE:PASSWORD@HOST/conference_manager_demo_shared
```

Do not paste any real connection string into GitHub issues, Confluence, chat, documentation or logs.

## 4. Configure the protected GitHub initialization environment

In `floriankreutzer/conference-manager-api` open **Settings → Environments** and create the environment `hosted-demo-initialize`.

Configure its deployment branches and tags policy to allow only the protected `main` branch. Add required reviewers according to repository governance. Do not allow arbitrary branches or tags to deploy to this environment.

Create exactly these four **environment secrets** inside `hosted-demo-initialize`:

- `HOSTED_DEMO_CUSTOMER_DATABASE_URL`
- `HOSTED_DEMO_PLATFORM_DATABASE_URL`
- `HOSTED_DEMO_RESET_DATABASE_URL`
- `HOSTED_DEMO_MIGRATION_DATABASE_URL`

Each value is the matching direct Neon URL from the previous step. Do not create repository-level copies: keeping the credentials only in the protected environment prevents a workflow dispatched from an unreviewed ref from receiving them.

The initialization job additionally rejects every ref except `refs/heads/main`. The migration credential exists only in this GitHub Actions environment and is intentionally absent from both Render runtime services.

## 5. Initialize schema and deterministic seed from GitHub

After the hosted-deployment change has been reviewed and merged to `main`, open the repository's **Actions** tab and run:

**Initialize Hosted Shared Demo**

Enter the exact confirmation value:

```text
saas-3.6-shared-demo-v5
```

The workflow performs, in order:

1. fail-closed verification that all four database URL secrets exist;
2. locked dependency installation;
3. canonical PostgreSQL migrations `001..038` through the migration role;
4. Demo overlay migrations and least-privilege grants;
5. deterministic reset/reseed with the fixed seed version and semantic checksum.

The workflow generates parser-only transient session/CSRF/HMAC values for the command lifetime. These are not deployed browser/session secrets and are masked in the workflow environment.

A failed migration or reset blocks Render deployment. Do not bypass it with manual table edits or by granting a runtime role broader privileges.

## 6. Create the two Render services from the Blueprint

Only after the hosted database initialization succeeds:

1. Open Render.
2. Select **New → Blueprint**.
3. Select `floriankreutzer/conference-manager-api`.
4. Use the Blueprint file `render.yaml` from `main`.
5. Review that exactly two Web Services will be created:
   - `conference-manager-demo`;
   - `conference-manager-ops-demo`.
6. Confirm both are **Free** and **Frankfurt**.
7. Render prompts for the `sync: false` database values. Provide:
   - Customer service: `DEMO_CUSTOMER_DATABASE_URL` = Customer Neon URL.
   - Platform service: `DEMO_PLATFORM_DATABASE_URL` = Platform Neon URL.
   - Platform service: `DEMO_RESET_DATABASE_URL` = Reset Neon URL.
8. Do not add the migration URL to either service.
9. Create/sync the Blueprint.

Render generates the Customer session/CSRF secrets, Platform session/CSRF secrets and the shared Tenant-audit HMAC value defined by the Blueprint. Secret values remain provider configuration and must not be copied into source.

`autoDeployTrigger` is intentionally `off`. Provider deployment is a deliberate release operation after repository checks and release refs are reviewed.

## 7. Immutable frontend packaging

Each Render build checks out the API repository from reviewed `main` and then fetches the exact 40-character frontend commit configured as `DEMO_FRONTEND_REF`.

`conference-manager` is the public source repository for this pinned browser artifact. The nested frontend fetch must be anonymous even when the surrounding Render build checked out the private API repository with provider-scoped Git credentials. The preparation command strips inherited `GIT_*`, `GH_*`, `GITHUB_*` and askpass configuration, runs the child Git process with its own newly-created empty temporary `HOME`/XDG/curl configuration directory, disables global/system Git configuration and terminal prompting, and then fetches only the fixed public repository at the immutable SHA. The temporary credential-isolation directory is removed after the fetch attempt. Do not add a GitHub PAT, deploy key or other cross-repository credential to either Render service as a workaround.

The build fails if:

- the ref is not an immutable commit SHA;
- the commit cannot be fetched anonymously from the fixed public repository;
- the Customer server-backed Demo entrypoint is missing;
- the Platform server-backed Demo entrypoint is missing.

Before the first provider deploy, verify that `DEMO_FRONTEND_REF` in `render.yaml` points to the approved frontend release commit. Changing the frontend pin requires a reviewed repository change.

The API process serves the pinned browser files itself so each surface remains same-origin with its corresponding API. Do not split the browser to a separate Render Static Site and introduce CORS or browser bearer tokens.

### Build-bound deployment identity evidence

A configured or expected commit ref is not evidence that Render is currently serving that ref. Every real Render build therefore emits the non-secret same-origin file:

```text
/assets/hosted-demo-deployment.json
```

The artifact uses schema version `1` and contains exactly these fields:

```json
{
  "schemaVersion": 1,
  "provider": "render",
  "repository": "floriankreutzer/conference-manager-api",
  "branch": "main",
  "serviceName": "conference-manager-demo | conference-manager-ops-demo",
  "runtimeRef": "<40-character lowercase Render RENDER_GIT_COMMIT>",
  "frontendRef": "<40-character lowercase DEMO_FRONTEND_REF>"
}
```

The build fails closed if the provider repository slug, branch, fixed service name, runtime commit format or frontend commit format does not match this contract. Non-Render preparation does not emit provider identity. The artifact contains no database URL, session identifier, CSRF/HMAC secret, provider credential, SQL detail or internal exception.

After a deliberate deploy, operators and automated hosted acceptance must fetch the artifact from **both** live origins:

- `https://conference-manager-demo.onrender.com/assets/hosted-demo-deployment.json`
- `https://conference-manager-ops-demo.onrender.com/assets/hosted-demo-deployment.json`

Both responses must use schema version `1`, identify provider `render`, repository `floriankreutzer/conference-manager-api` and branch `main`, report the service name matching the origin, and report the exact reviewed runtime/frontend SHAs selected for the release. Missing metadata, additional fields, malformed or stale refs, a mismatched service identity or any other contract expansion invalidates hosted acceptance. The detailed evidence boundary is documented in `docs/HOSTED-DEMO-DEPLOYMENT-EVIDENCE.md`.

## 8. Runtime binding and health

Render requires the public HTTP process to bind to `0.0.0.0` and the provider-supplied `PORT`. The Blueprint supplies `DEMO_LISTEN_HOST=0.0.0.0`; the Demo runtime consumes Render's `PORT` dynamically.

Readiness health checks are:

- Customer: `/api/v1/health/ready`
- Platform: `/api/v1/platform/health/ready`

These checks include the Demo PostgreSQL/schema/sentinel readiness chain. Liveness alone is not sufficient for hosted acceptance.

Normal Customer and Platform PostgreSQL statements remain bounded to 10 seconds. The separate Demo reset pool uses a 60-second statement/query timeout because the authorized reset performs one exclusive, transactional truncate/reseed/integrity/audit operation across the complete synthetic baseline and can take longer on a remote Free-tier database. This extended budget applies only to the reset database role/pool; it must not be copied to normal runtime pools or Production configuration. A timeout still fails the HTTP reset and rolls the transaction back rather than returning partial success.

## 9. First hosted acceptance

After both services report ready:

1. Fetch `/assets/hosted-demo-deployment.json` from both public origins and verify the complete schema-v1 deployment identity contract against the reviewed runtime/frontend SHAs.
2. Open `https://conference-manager-demo.onrender.com` in a fresh browser context.
3. Open `https://conference-manager-ops-demo.onrender.com` in a different browser context.
4. Verify that clearing browser LocalStorage/sessionStorage does not remove business state.
5. Execute Platform → Tenant Admin → Employee → Conference Manager → Employee → Platform using the same Tenant and Request state.
6. Verify a second Tenant is concealed from unauthorized cross-Tenant access.
7. Execute the authorized Platform Demo reset.
8. Re-establish both sessions and verify the deterministic baseline.
9. Verify the Customer and Platform readiness endpoints return ready.
10. Record only provider URLs, verified deployment refs, schema/seed versions and non-secret evidence.

The frontend repository's `Hosted Demo Acceptance` workflow automates the readiness wait, validates both build-bound deployment identity artifacts before starting the destructive browser journey, executes the fixed-origin critical journey, and records only bounded non-secret evidence. If the journey fails after mutating shared Demo state, the workflow first captures the bounded reset failure audit evidence, then establishes fresh Platform `security_admin` authority and runs the deterministic reset/reseed cleanup, uploads the evidence, and finally preserves the original journey failure as a failed acceptance result. A cleanup failure is itself a failed acceptance and must never be ignored.

## Free-tier operating constraints

The Demo accepts the following Free-tier behavior:

- Render Free services spin down after inactivity and can take roughly one minute to wake;
- Render local filesystem is ephemeral, so only Neon PostgreSQL is authoritative;
- no availability SLA is claimed;
- no artificial keep-alive traffic is used to defeat Free-tier limits;
- if Free-tier limits or provider terms become unsuitable, the hosting decision is revisited rather than weakening application architecture.

A cold start may delay the first page load. It must never cause fallback to browser business persistence, local fixtures or a different security mode.

## Rollback and recovery

A frontend-only rollback may redeploy an approved compatible frontend ref while the current API/schema remain in place. A backend rollback across migration 034 is not a simple prior-ref redeploy.

Before crossing that boundary, quiesce both Demo origins because they share canonical schema readiness. Use only the protected migration owner to change canonical migration bookkeeping; migration 034 down must leave Customer revocations intact. The target backend, fixture and canonical schema must be one reviewed compatible set, and all Customer and Platform sessions must be re-established. On re-forward, quiesce again, reapply migration 034 before traffic, deploy the current pair and verify old Customer cookies fail.

For Demo data corruption or an invalid seed state, prefer the supported deterministic reset/reseed operation. If sentinel/schema integrity cannot be established, recreate the isolated Demo database and rerun the controlled initialization workflow. If the main-only initialization workflow cannot initialize the reviewed target contract, stop and forward-fix. Do not apply ad hoc repair SQL or grant a runtime role broader privileges.

## Secrets inventory

Never record values. The expected names are:

### Protected GitHub Actions environment only

- `HOSTED_DEMO_CUSTOMER_DATABASE_URL`
- `HOSTED_DEMO_PLATFORM_DATABASE_URL`
- `HOSTED_DEMO_RESET_DATABASE_URL`
- `HOSTED_DEMO_MIGRATION_DATABASE_URL`

### Render Customer service

- `DEMO_CUSTOMER_DATABASE_URL`
- generated `DEMO_CUSTOMER_SESSION_SECRET`
- generated `DEMO_CUSTOMER_CSRF_SECRET`
- shared generated `DEMO_TENANT_AUDIT_HMAC_SECRET`

### Render Platform service

- `DEMO_PLATFORM_DATABASE_URL`
- `DEMO_RESET_DATABASE_URL`
- generated `DEMO_PLATFORM_SESSION_SECRET`
- generated `DEMO_PLATFORM_CSRF_SECRET`
- shared generated `DEMO_TENANT_AUDIT_HMAC_SECRET`

The migration credential must never be added to Render. Customer credentials must never be added to the Platform service and Platform/reset credentials must never be added to the Customer service.

## Equipment composition rollout

Migration 035 adds exact Request composition v3 Equipment constraints to the existing Request,
revision and booking-change JSON snapshots. Existing v1/v2 data is not rewritten. Create,
resubmit, transition, history and confirmed-change paths support the accepted nested version,
while the outer response envelopes remain unchanged. Equipment is resolved using existing
Tenant-composite Catalogue tables, charged once and included in allocation.

The `saas-3.6-shared-demo-v5` reset fixture contains distinct priced Northwind/Contoso Equipment
and verifies those identity, price and applicability facts during semantic readback. Demo overlay
004 adds only the reset role's `INSERT` and `TRUNCATE` privileges on the canonical attribution
migration-state table introduced by migration 036; customer and Platform roles receive no access.
Apply canonical migrations first, apply Demo overlays 001 through 004, reset/reseed Demo, deploy
both API processes at one compatible SHA, verify Catalogue pages and then pin/deploy the updated
frontend. Down 035 refuses once any v3 snapshot/proposal/history exists; use a compatible binary or
a forward fix. Production never activates Demo authority.

## SaaS 3.6 persisted Request attribution

The exact v3 Request response envelopes, relational snapshots, honest legacy-null
semantics, unchanged audit-chain payload, and mandatory staged writer cutover are
defined in [Request Attribution](REQUEST-ATTRIBUTION.md). Existing Tenant, role,
object ownership and session/CSRF boundaries remain required for these reads and writes.
