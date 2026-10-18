import { createHash } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { AUDIT_ACTION } from '../../src/audit/event.js';
import { createPostgresPersistence } from '../../src/persistence/postgres/index.js';
import { assertLoadDatabase, loadTargetScope } from './target-load-guard.mjs';
import { loadTargetSetupConfig } from './target-load-setup-config.mjs';
import { validateTargetLoadManifest } from './target-load-manifest.mjs';

function valid(value) { if (!value) throw new Error('LOAD_TARGET_RECONCILIATION_FAILED'); }

// Local, read-only reconciliation through verified installer custody. Returns
// counts only, never Tenant/actor/Request IDs, cookies, SQL or provider references.
export async function reconcileTargetLoad({ env = process.env, manifest, campaigns, clock = Date.now,
  persistenceFactory = createPostgresPersistence, verifyDatabase = assertLoadDatabase,
  sleep = wait, exit = code => process.exit(code) } = {}) {
  let persistence; let timer;
  try {
    const { values, scope, config } = loadTargetSetupConfig(env, clock());
    const data = validateTargetLoadManifest(manifest, values, clock());
    valid(Array.isArray(campaigns) && campaigns.length <= 3);
    const outcomes = campaigns.flatMap(campaign => campaign.results);
    valid(outcomes.length <= 220);
    const expected = new Map(outcomes.map(outcome => [outcome.requestId, outcome]));
    valid(expected.size === outcomes.length);
    function active() { loadTargetScope(values, clock()); valid(clock() < scope.expiresMs - 60_000); }
    timer = setTimeout(() => exit(1), Math.max(0, scope.expiresMs - clock())); timer.unref();
    persistence = persistenceFactory(config); await verifyDatabase(persistence.pool, scope, { clock }); active();
    async function query(text, parameters) {
      active(); const result = await persistence.pool.query(text, parameters); active(); return result;
    }
    let pending;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      pending = (await query('SELECT count(*)::int AS count FROM public.platform_projection_outbox')).rows[0]?.count;
      if (pending === 0) break; await sleep(1000); active();
    }
    valid(pending === 0);
    const requests = await query('SELECT tenant_id,id,status,request_version FROM public.requests LIMIT 221');
    valid(requests.rowCount === expected.size);
    for (const row of requests.rows) {
      valid(expected.get(row.id)?.tenantId === row.tenant_id && row.status === 'Confirmed' && Number(row.request_version) === 3);
    }
    const references = await query(`SELECT tenant_id,request_id,state,idempotency_key,provider_reference,
      provider_resource_reference FROM public.booking_provider_references LIMIT 221`);
    valid(references.rowCount === expected.size);
    for (const row of references.rows) {
      valid(row.state === 'active' && expected.get(row.request_id)?.tenantId === row.tenant_id
        && row.provider_reference === `fixture-${createHash('sha256').update(row.idempotency_key).digest('hex')}`
        && row.provider_resource_reference === `room${data.tenants.indexOf(row.tenant_id)}@synthetic.invalid`);
    }
    const revisionCount = (await query('SELECT count(*)::int AS count FROM public.request_revisions')).rows[0]?.count;
    valid(revisionCount === expected.size * 3);
    const history = await query(`SELECT revision.tenant_id,revision.request_id,revision.request_version,
      revision.actor_user_id,revision.actor_role_at_action,revision.record,audit.actor_user_id AS audit_actor,
      audit.previous_state,audit.new_state,audit.outcome
      FROM public.request_revisions revision JOIN public.audit_events audit
        ON audit.tenant_id=revision.tenant_id AND audit.correlation_id=revision.correlation_id
        AND audit.target_id=revision.request_id AND audit.target_type='request' AND audit.action=$1
      WHERE revision.request_version IN (2,3) LIMIT 441`, [AUDIT_ACTION.REQUEST_TRANSITION]);
    valid(history.rowCount === expected.size * 2);
    const seen = new Set();
    for (const row of history.rows) {
      const wanted = expected.get(row.request_id); const version = Number(row.request_version);
      const previous = version === 2 ? 'Submitted' : 'In Review'; const status = version === 2 ? 'In Review' : 'Confirmed';
      valid(wanted && row.tenant_id === wanted.tenantId && row.actor_user_id === wanted.actorUserId
        && row.audit_actor === wanted.actorUserId && row.actor_role_at_action === 'conference_manager' && row.outcome === 'success'
        && JSON.stringify(row.previous_state) === JSON.stringify({ status: previous })
        && JSON.stringify(row.new_state) === JSON.stringify({ status }) && row.record.status === status && row.record.version === version
        && row.record.pricing.totalMinor === 1000 + data.tenants.indexOf(row.tenant_id) * 100);
      const key = `${row.request_id}:${version}`; valid(!seen.has(key)); seen.add(key);
    }
    for (const tenantId of data.tenants) { active(); valid(await persistence.auditRepository.verifyTenantChain(tenantId)); active(); }
    const population = await query(`SELECT (SELECT count(*)::int FROM public.users) AS users,
      (SELECT count(*)::int FROM public.sessions) AS sessions`);
    valid(population.rows[0]?.users === data.employees.length + 10 && population.rows[0]?.sessions === data.employees.length + 10);
    return { confirmedBookings: expected.size, activeFixtureReferences: references.rowCount, requestRevisions: revisionCount,
      transitionActorCorrelations: history.rowCount, verifiedTenantAuditChains: 10, pendingProjectionWork: pending,
      retainedEmployees: data.employees.length, retainedManagers: 10 };
  } catch { throw new Error('LOAD_TARGET_RECONCILIATION_FAILED'); }
  finally {
    try { await persistence?.close(); } catch { throw new Error('LOAD_TARGET_RECONCILIATION_FAILED'); }
    finally { clearTimeout(timer); }
  }
}
