# Conference Manager API

Backend for Conference Manager, providing authenticated application services, customer-scoped booking workflows and PostgreSQL persistence.

## Responsibilities

- Authenticate users and enforce server-side roles and resource ownership.
- Process conference requests, booking decisions and customer administration.
- Integrate with supported identity and calendar services.
- Persist application data and audit events.

This is the application backend. Its presence in a public repository does not publish every application endpoint as a supported partner API. Released integration documentation is maintained in [Conference Manager Developer](https://github.com/floriankreutzer/conference-manager-developer).

Operator changes use the separate authenticated Platform HTTP boundary; the only local mutation fallback is the dual-control, grant-bound recovery wrapper. These existing authority boundaries also apply during development.

## Requirements

- Node.js 22 or later and npm.
- A dedicated local PostgreSQL 18 instance for persistent development and database tests.
- The matching [browser application](https://github.com/floriankreutzer/conference-manager) for end-to-end use.

## Local development

```bash
git clone https://github.com/floriankreutzer/conference-manager-api.git
cd conference-manager-api
npm ci --ignore-scripts
cp .env.example .env
```

Edit `.env` for your local environment before starting. Configure `DATABASE_URL` for a dedicated local database and supply independently generated `CSRF_SECRET` and `AUDIT_HMAC_SECRET` values. A persistent database requires a stable audit key of at least 32 bytes. Keep `.env` untracked and use no production credentials or customer data.

After reviewing your local configuration:

```bash
set -a
. ./.env
set +a
npm run db:migrate
npm start
```

The development template binds to `127.0.0.1:3000`. These commands apply migrations to the configured database; use a disposable development database. Deployment and operational recovery require separate controlled procedures.

## Project layout

| Directory | Responsibility |
| --- | --- |
| `src/` | HTTP, application, domain and infrastructure modules |
| `migrations/` | Versioned database migrations |
| `tests/` | Unit, HTTP, security and database tests |
| `scripts/` | Development and validation tools |
| `docs/` | Technical contracts and contributor guidance |

## Validation

```bash
npm run check
npm run audit
npm run test:db
```

Database tests require a dedicated test database and the repository-defined configuration. Never point tests at production or shared customer databases. Cross-repository browser tests require the corresponding frontend and isolated test fixtures.

## Contributing

Start with [AGENTS.md](AGENTS.md) and the [coding standards](docs/CODING-STANDARDS.md). Preserve server-side authorization, customer isolation, data integrity and the existing test gates. Submit changes through the repository review process.

## Security

Do not publish credentials, customer payloads or sensitive diagnostics. Report suspected vulnerabilities privately using [SECURITY.md](SECURITY.md).

## License

No project-level license file is currently included. Refer to the corresponding notices for third-party assets and dependencies.
