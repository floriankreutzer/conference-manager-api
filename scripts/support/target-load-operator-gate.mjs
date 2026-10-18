import { setTimeout as wait } from 'node:timers/promises';
import { createPostgresPersistence } from '../../src/persistence/postgres/index.js';
import { assertLoadDatabase, loadTargetScope } from './target-load-guard.mjs';
import { loadTargetSetupConfig } from './target-load-setup-config.mjs';
import { loadTargetOperatorConfig } from './target-load-operator-config.mjs';

function valid(value) { if (!value) throw new Error('LOAD_OPERATOR_GATE_FAILED'); }

// Only the restricted installer owns this temporary table. Neither runtime has
// any grant. Release is a separate, independently verified control-plane write.
export async function awaitTargetOperatorRelease({ env, clock = Date.now, sleep = wait,
  persistenceFactory = createPostgresPersistence, verifyDatabase = assertLoadDatabase,
  prepared = () => {} } = {}) {
  let persistence;
  try {
    loadTargetOperatorConfig(env, clock());
    const { scope, values, config } = loadTargetSetupConfig(env, clock());
    const end = Math.min(clock() + 45 * 60_000, scope.expiresMs - 26 * 60_000);
    function active() { loadTargetScope(values, clock()); valid(clock() < end); }
    active(); persistence = persistenceFactory(config);
    await verifyDatabase(persistence.pool, scope, { clock }); active();
    async function query(sql, parameters) {
      active(); const result = await persistence.pool.query(sql, parameters); active(); return result;
    }
    await query(`CREATE TABLE public.saas38_load_operator_gate (
      singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),run_id text NOT NULL,
      release_sha text NOT NULL,expires_at timestamptz NOT NULL,ready boolean NOT NULL DEFAULT false)`);
    await query(`INSERT INTO public.saas38_load_operator_gate(run_id,release_sha,expires_at)
      VALUES($1,$2,$3)`, [scope.runId, scope.releaseSha, scope.expiresAt]);
    await prepared(); active();
    while (true) {
      const result = await query('SELECT run_id,release_sha,expires_at,ready FROM public.saas38_load_operator_gate');
      valid(result.rowCount === 1 && result.rows[0].run_id === scope.runId
        && result.rows[0].release_sha === scope.releaseSha && result.rows[0].expires_at.toISOString() === scope.expiresAt
        && typeof result.rows[0].ready === 'boolean');
      if (result.rows[0].ready) return;
      await sleep(5000); active();
    }
  } catch { throw new Error('LOAD_OPERATOR_GATE_FAILED'); }
  finally { try { await persistence?.close(); } catch { throw new Error('LOAD_OPERATOR_GATE_FAILED'); } }
}
