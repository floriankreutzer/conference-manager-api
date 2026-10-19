import { performance } from 'node:perf_hooks';
import { assertNeonRecoveryIdentity, loadNeonRecoveryDatabaseConfig, RECOVERY_ROLES } from './neon-recovery-config.mjs';

export const CONNECTION_REPORT = 'neon-recovery-connections.json';
const PHASES = new Set(['before-marker', 'marker-readback']);
const DRIVER_MESSAGES = new Map([['timeout expired', 'PG_CONNECTION_TIMEOUT'], ['Query read timeout', 'PG_QUERY_TIMEOUT'],
  ['Connection terminated', 'PG_CONNECTION_TERMINATED'], ['Connection terminated unexpectedly', 'PG_CONNECTION_TERMINATED']]);
const SAFE_CODES = new Set([
  'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  'EPERM', 'EACCES', 'EPIPE',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  '28000', '28P01', '3D000', '42501', '42P01', '42703', '57014', '57P01', '57P02', '57P03', '53300',
  '08000', '08001', '08003', '08004', '08006', '08007', '08P01',
  'NEON_RECOVERY_CONTEXT_INVALID', 'NEON_RECOVERY_DATABASE_INVALID', 'NEON_RECOVERY_IDENTITY_INVALID',
  'NEON_RECOVERY_MARKER_INVALID', 'NEON_RECOVERY_SCHEMA_INVALID', 'NEON_RECOVERY_PHASE_INVALID',
  'NEON_RECOVERY_TIME_INVALID', 'NEON_RECOVERY_DEADLINE', 'NEON_RECOVERY_READ_ONLY_INVALID',
  'NEON_RECOVERY_OPERATION_TIMEOUT', 'NEON_RECOVERY_CLOSE_TIMEOUT',
]);
const KNOWN_EXISTING_ENDPOINT = 'ep-damp-wind-b1c04z8g.c-5.eu-central-1.aws.neon.tech';
const UNAVAILABLE_BRANCHES = new Set(['br-billowing-mouse-b1yzglz7', 'br-frosty-mud-b15738e2',
  'br-rapid-mountain-b1ioh1ah', 'br-red-salad-b16r1iz9', 'br-soft-fire-b1kb93nu', 'br-summer-wave-b11eb1pm',
  'br-weathered-boat-b1fe52yn', 'br-blue-haze-b1xv69tr', 'br-quiet-rain-b1j1n0y3', 'br-gentle-rice-b1w0yhm4']);
const IDENTITY_SQL = `SELECT session_user AS login, current_user AS role, current_database() AS database,
  current_setting('transaction_read_only') AS read_only, clock_timestamp() AS observed_at`;
const SCHEMA_SQL = `SELECT (SELECT max(version) FROM public.schema_migrations) AS runtime,
  (SELECT max(version) FROM public.demo_schema_migrations) AS overlay`;

export function safeConnectionCode(error) {
  try {
    for (const key of ['code', 'message']) {
      const value = Object.getOwnPropertyDescriptor(error, key)?.value;
      if (typeof value === 'string' && SAFE_CODES.has(value)) return value;
      if (key === 'message' && typeof value === 'string' && DRIVER_MESSAGES.has(value)) return DRIVER_MESSAGES.get(value);
    }
  } catch { /* Never inspect getters, causes, stacks or provider serialization. */ }
  return 'UNKNOWN';
}

function configuration(env, now) {
  const settings = loadNeonRecoveryDatabaseConfig(env);
  if (!PHASES.has(env.NEON_RECOVERY_CONNECTION_PHASE)) throw new Error('NEON_RECOVERY_PHASE_INVALID');
  if (env.GITHUB_REPOSITORY !== 'floriankreutzer/conference-manager-api' || env.GITHUB_RUN_ATTEMPT !== '1'
    || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
    || UNAVAILABLE_BRANCHES.has(settings.branch)
    || env.NEON_RECOVERY_HOST === KNOWN_EXISTING_ENDPOINT || env.PGOPTIONS !== undefined
    || env.PGSSLNEGOTIATION !== undefined || env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('NEON_RECOVERY_CONTEXT_INVALID');
  }
  let passwords;
  try { passwords = settings.databases.map(({ url }) => decodeURIComponent(new URL(url).password)); }
  catch { throw new Error('NEON_RECOVERY_DATABASE_INVALID'); }
  if (settings.databases.length !== Object.keys(RECOVERY_ROLES).length || new Set(passwords).size !== 4) {
    throw new Error('NEON_RECOVERY_DATABASE_INVALID');
  }
  const provisionedAt = env.NEON_RECOVERY_PROVISIONED_AT;
  const provisioned = Date.parse(provisionedAt);
  if (typeof provisionedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(provisionedAt)
    || !Number.isFinite(provisioned) || new Date(provisioned).toISOString().replace('.000Z', 'Z') !== provisionedAt
    || now < provisioned || now >= provisioned + 30 * 60_000) throw new Error('NEON_RECOVERY_TIME_INVALID');
  return { ...settings, phase: env.NEON_RECOVERY_CONNECTION_PHASE, provisioned,
    preparationDeadline: provisioned + 30 * 60_000, outerExpiry: provisioned + 90 * 60_000 };
}

async function bounded(operation, timeout, code) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(code)), Math.max(1, timeout));
    })]);
  } finally { clearTimeout(timer); }
}

function clockGuard(settings, wallNow, monotonicNow, started) {
  // Leave two seconds of the entrypoint's 60-second watchdog for report retention.
  const deadline = started + Math.min(58_000, settings.preparationDeadline - wallNow());
  return () => {
    const wall = wallNow();
    // Reserve one second for bounded connection closure inside the hard limit.
    const remaining = Math.min(deadline - monotonicNow(), settings.preparationDeadline - wall) - 1000;
    if (!Number.isFinite(remaining) || remaining <= 0 || wall < settings.provisioned) {
      throw new Error('NEON_RECOVERY_DEADLINE');
    }
    return remaining;
  };
}

function validateIdentity(result, role, settings) {
  const row = result.rows[0];
  if (result.rows.length !== 1 || row?.login !== role || row?.role !== role
    || row?.database !== 'conference_manager_demo_shared') throw new Error('NEON_RECOVERY_IDENTITY_INVALID');
  if (row.read_only !== 'on') throw new Error('NEON_RECOVERY_READ_ONLY_INVALID');
  const observed = new Date(row.observed_at).getTime();
  if (!Number.isFinite(observed) || observed < settings.provisioned || observed >= settings.preparationDeadline) {
    throw new Error('NEON_RECOVERY_TIME_INVALID');
  }
  return observed;
}

async function inspectMarker(query, settings, role, wallNow, previousMarker) {
  if (settings.phase === 'before-marker') {
    const result = await query("SELECT to_regclass('public.neon_recovery_acceptance') AS marker");
    if (result.rows.length !== 1 || result.rows[0]?.marker !== null) throw new Error('NEON_RECOVERY_MARKER_INVALID');
    return null;
  }
  let marker;
  const guarded = { async query(sql) {
    const result = await query(sql);
    if (sql.includes('FROM public.neon_recovery_acceptance')) marker = result.rows[0];
    return result;
  } };
  await assertNeonRecoveryIdentity(guarded, role, settings.branch, wallNow());
  const created = new Date(marker?.created_at).getTime();
  const expires = new Date(marker?.expires_at).getTime();
  if (created < settings.provisioned || created >= settings.preparationDeadline || expires > settings.outerExpiry
    || (previousMarker && (previousMarker.created !== created || previousMarker.expires !== expires))) {
    throw new Error('NEON_RECOVERY_MARKER_INVALID');
  }
  return { created, expires };
}

// This runner only inspects the independently bound child; a passed report is
// neither provider-identity evidence nor permission to dispatch recovery.
export async function runNeonRecoveryConnections({ env, clientFactory,
  wallNow = Date.now, monotonicNow = () => performance.now() }) {
  const started = monotonicNow();
  const report = { schemaVersion: 1, scope: 'recovery-connections-read-only-not-acceptance', outcome: 'failed',
    sourceRuntimeRef: /^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '') ? env.GITHUB_SHA : null,
    phase: PHASES.has(env.NEON_RECOVERY_CONNECTION_PHASE) ? env.NEON_RECOVERY_CONNECTION_PHASE : null,
    completedRoles: [], failedRole: null, failedStage: null, code: null, cleanupErrors: [] };
  let stage = 'configuration';
  let activeRole = null;
  try {
    const settings = configuration(env, wallNow());
    const check = clockGuard(settings, wallNow, monotonicNow, started);
    report.branch = settings.branch;
    report.host = env.NEON_RECOVERY_HOST;
    report.providerBinding = 'requires-independent-provider-verification';
    report.provisionedAt = new Date(settings.provisioned).toISOString();
    report.preparationDeadline = new Date(settings.preparationDeadline).toISOString();
    report.outerExpiry = new Date(settings.outerExpiry).toISOString();
    let marker = null;
    for (const database of settings.databases) {
      activeRole = database.role;
      stage = 'connect';
      check();
      let client;
      let originalFailure;
      let originalStage;
      let asynchronousError;
      let asynchronousStage;
      try {
        client = clientFactory({ connectionString: database.url, ssl: { rejectUnauthorized: true },
          connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 5000,
          idle_in_transaction_session_timeout: 5000, options: '-c default_transaction_read_only=on' });
        client.on('error', (error) => {
          if (asynchronousStage === undefined) { asynchronousError = error; asynchronousStage = stage; }
        });
        await bounded(() => client.connect(), Math.min(5000, check()), 'NEON_RECOVERY_OPERATION_TIMEOUT');
        check();
        const query = async (sql) => {
          if (asynchronousStage !== undefined) throw asynchronousError;
          const result = await bounded(() => client.query(sql), Math.min(5000, check()), 'NEON_RECOVERY_OPERATION_TIMEOUT');
          check();
          if (asynchronousStage !== undefined) throw asynchronousError;
          return result;
        };
        stage = 'begin';
        await query('BEGIN READ ONLY');
        stage = 'identity';
        validateIdentity(await query(IDENTITY_SQL), database.role, settings);
        stage = 'schema';
        const versions = await query(SCHEMA_SQL);
        if (versions.rows.length !== 1 || versions.rows[0]?.runtime !== 52 || versions.rows[0]?.overlay !== 18) {
          throw new Error('NEON_RECOVERY_SCHEMA_INVALID');
        }
        stage = 'marker';
        marker = await inspectMarker(query, settings, database.role, wallNow, marker);
        stage = 'rollback';
        await query('ROLLBACK');
        stage = 'identity';
        const observed = validateIdentity(await query(IDENTITY_SQL), database.role, settings);
        if (marker && (marker.created > observed || marker.expires <= observed)) {
          throw new Error('NEON_RECOVERY_MARKER_INVALID');
        }
      } catch (error) { originalFailure = error; originalStage = stage; }
      if (client) {
        stage = 'close';
        try {
          // Close even after the preparation deadline; never issue another SQL operation.
          await bounded(() => client.end(), 1000, 'NEON_RECOVERY_CLOSE_TIMEOUT');
        } catch (error) {
          report.cleanupErrors.push({ role: database.role, stage: 'close', code: safeConnectionCode(error) });
          if (originalStage === undefined) { originalFailure = error; originalStage = 'close'; }
        }
      }
      if (asynchronousStage === 'close' && !report.cleanupErrors.some(({ role }) => role === database.role)) {
        report.cleanupErrors.push({ role: database.role, stage: 'close', code: safeConnectionCode(asynchronousError) });
      }
      if (asynchronousStage !== undefined && originalStage === undefined) {
        originalFailure = asynchronousError;
        originalStage = asynchronousStage;
      }
      if (originalStage !== undefined) { stage = originalStage; throw originalFailure; }
      stage = 'deadline';
      check();
      report.completedRoles.push(database.role);
    }
    stage = 'deadline';
    check();
    if (marker) {
      if (wallNow() >= marker.expires) throw new Error('NEON_RECOVERY_MARKER_INVALID');
      report.markerCreatedAt = new Date(marker.created).toISOString();
      report.markerExpiresAt = new Date(marker.expires).toISOString();
    }
    report.outcome = 'passed';
  } catch (error) {
    report.failedRole = activeRole;
    report.failedStage = stage;
    report.code = safeConnectionCode(error);
  }
  report.elapsedMs = Math.max(0, Math.floor(monotonicNow() - started));
  report.completedAt = new Date(wallNow()).toISOString();
  return report;
}
