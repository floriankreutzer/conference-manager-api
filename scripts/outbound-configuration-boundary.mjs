const EXISTING_URL_BOUNDARIES = new Set(['src/config.js', 'src/domain/site-guest-information.js']);
const NEON_CONFIG_FILE = 'src/media/neon-storage-config.js';
const NEON_ENDPOINT_TEMPLATE = 'https://${branch}.storage.c-5.eu-central-1.aws.neon.tech';
const PROVIDER_CONFIG_AUTHORITY = /\b(?:import|require|process|fetch|globalThis)\b|\b(?:request|connect|createConnection)\s*\(/;

export function outboundConfigurationViolation(file, content) {
  const urls = content.match(/https?:\/\/[^\s'"`]*/g) || [];
  if (file === NEON_CONFIG_FILE) {
    // This one pure provider module may derive only the reviewed Frankfurt URL.
    // No SDK, module import, environment access or transport authority is admitted.
    if (PROVIDER_CONFIG_AUTHORITY.test(content) || urls.some((url) => url !== NEON_ENDPOINT_TEMPLATE)) {
      return `${file} must remain pure Neon configuration with only the reviewed Frankfurt storage endpoint.`;
    }
    return null;
  }
  if (urls.length && !EXISTING_URL_BOUNDARIES.has(file)) {
    return `${file} contains a hard-coded outbound URL; provider destinations require an approved integration boundary.`;
  }
  return null;
}
