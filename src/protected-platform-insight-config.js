import { createNeonBranchStorageConfig } from './media/neon-storage-config.js';

export const PROTECTED_DAILY_INSIGHT_KEYS = Object.freeze(['DAILY_INSIGHTS_ENABLED', 'DAILY_INSIGHTS_BRANCH_ID',
  'DAILY_INSIGHTS_DATABASE_HOST', 'DAILY_INSIGHTS_ACCESS_KEY_ID', 'DAILY_INSIGHTS_SECRET_ACCESS_KEY']);

// Configuration only: default off, active INT Operations only, separate read
// credential and the same verified Neon database host. No provider IO at startup.
export function loadProtectedDailyInsightConfig({ values, profile, assuranceMode, forbiddenSecrets }) {
  const [enabled, branch, host, accessKeyId, secretAccessKey] = values;
  const invalid = () => { throw new TypeError('PROTECTED_PLATFORM_DAILY_INSIGHTS_INVALID'); };
  if (![undefined, 'false', 'true'].includes(enabled)) invalid();
  if (enabled !== 'true') {
    if (values.slice(1).some(value => value !== undefined)) invalid();return null;
  }
  const database = new URL(profile.database.databaseUrl);
  if (profile.environment !== 'int' || !['application_passkey', 'microsoft_mfa'].includes(assuranceMode)
    || host !== database.hostname || !/^ep-[a-z0-9-]{5,80}\.c-5\.eu-central-1\.aws\.neon\.tech$/.test(host)
    || database.pathname !== '/conference_manager_demo_shared'
    || accessKeyId === secretAccessKey || [accessKeyId, secretAccessKey].some(value => forbiddenSecrets.includes(value)
      || value === decodeURIComponent(database.password))) invalid();
  try { return createNeonBranchStorageConfig({ branch, bucket: 'conference-manager-media', accessKeyId, secretAccessKey }); }
  catch { invalid(); }
}
