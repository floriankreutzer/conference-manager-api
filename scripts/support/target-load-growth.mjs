import { createPostgresPersistence } from '../../src/persistence/postgres/index.js';
import { withPostgresTransaction } from '../../src/persistence/postgres/transaction.js';
import { createSessionService } from '../../src/identity/session-service.js';
import { assertLoadDatabase, loadTargetScope } from './target-load-guard.mjs';
import { loadTargetSetupConfig } from './target-load-setup-config.mjs';
import { validateTargetLoadManifest } from './target-load-manifest.mjs';
import { seedLoadSessions } from './target-load-sessions.mjs';

function valid(value) { if (!value) throw new Error('LOAD_TARGET_GROWTH_FAILED'); }

async function existingSessionBindings(data) {
  const bindings = [];
  const service = createSessionService({ publicOrigin: data.origins.customer,
    auditService: { createActorEvent() {}, createEvent() {}, async record() {} },
    repository: { async issue() { throw new Error('UNEXPECTED_GROWTH_ISSUANCE'); },
      async resolveByTokenHash(tokenHash) { bindings.at(-1).tokenHash = tokenHash; return null; } } });
  for (const actor of [...data.managers, ...data.employees]) {
    bindings.push({ tenantId: actor.tenantId, userId: actor.userId, role: actor.roles[0] });
    // Reuse the canonical token hash/security epoch without copying its crypto.
    await service.resolvePrincipal({ headers: { cookie: actor.cookie } });
  }
  return bindings;
}

// Local installer authority only; no storage/provider allocation or runtime owner
// credential. A committed growth with a lost private manifest must fail closed on
// the next attempt, rather than issue a second population or pretend rollback.
export async function growTargetLoadPopulation({ env = process.env, manifest, clock = Date.now,
  persistenceFactory = createPostgresPersistence, verifyDatabase = assertLoadDatabase,
  exit = code => process.exit(code) } = {}) {
  let persistence; let timer;
  try {
    const settings = loadTargetSetupConfig(env, clock()); const { scope, values, config, population } = settings;
    const data = validateTargetLoadManifest(manifest, values, clock());
    valid((data.employees.length === 100 && population === 1000) || (data.employees.length === 1000 && population === 10_000));
    function active() { loadTargetScope(values, clock()); valid(clock() < scope.expiresMs - 60_000); }
    timer = setTimeout(() => exit(1), Math.max(0, scope.expiresMs - clock())); timer.unref();
    persistence = persistenceFactory(config); await verifyDatabase(persistence.pool, scope, { clock }); active();
    const bindings = await existingSessionBindings(data); active();
    await withPostgresTransaction(persistence.pool, async client => {
      async function query(text, parameters) {
        active(); const result = await client.query(text, parameters); active(); return result;
      }
      // The immutable run marker also serializes installer growth. Runtime roles
      // cannot obtain this write lock; their SELECT-only startup reads stay valid.
      const marker = await query('SELECT run_id FROM public.saas38_load_scope FOR UPDATE');
      valid(marker.rowCount === 1 && marker.rows[0].run_id === scope.runId);
      const counts = await query(`SELECT (SELECT count(*)::int FROM public.users) AS users,
        (SELECT count(*)::int FROM public.sessions) AS sessions,(SELECT count(*)::int FROM public.tenants) AS tenants,
        (SELECT count(*)::int FROM public.rooms) AS rooms`);
      valid(counts.rows[0]?.users === bindings.length && counts.rows[0]?.sessions === bindings.length
        && counts.rows[0]?.tenants === 10 && counts.rows[0]?.rooms === 100);
      for (let offset = 0; offset < bindings.length; offset += 500) {
        const rows = bindings.slice(offset, offset + 500);
        const matched = await query(`SELECT count(*)::int AS count FROM jsonb_to_recordset($1::jsonb)
          AS fixture("tenantId" uuid,"userId" uuid,"tokenHash" text,role text)
          JOIN public.sessions session ON session.tenant_id=fixture."tenantId" AND session.user_id=fixture."userId"
            AND session.token_hash=fixture."tokenHash" AND session.roles=ARRAY[fixture.role]::text[]
            AND session.expires_at>transaction_timestamp() AND session.revoked_at IS NULL AND session.principal_version=1
          JOIN public.users actor ON actor.tenant_id=session.tenant_id AND actor.id=session.user_id
            AND actor.active=true AND actor.security_version=session.principal_version
          JOIN public.tenants tenant ON tenant.id=session.tenant_id AND tenant.status='active'`, [JSON.stringify(rows)]);
        valid(matched.rows[0]?.count === rows.length);
      }
      const sessionTtlSeconds = Math.floor((scope.expiresMs - clock() - 60_000) / 1000);
      valid(sessionTtlSeconds >= 300 && sessionTtlSeconds <= 7200);
      await seedLoadSessions({ query }, data.tenants, data.employees, population,
        { roles: ['employee'], publicOrigin: data.origins.customer, sessionTtlSeconds }); active();
    });
    active(); return validateTargetLoadManifest(data, values, clock());
  } catch { throw new Error('LOAD_TARGET_GROWTH_FAILED'); }
  finally {
    try { await persistence?.close(); }
    catch { throw new Error('LOAD_TARGET_GROWTH_FAILED'); }
    finally { clearTimeout(timer); }
  }
}
