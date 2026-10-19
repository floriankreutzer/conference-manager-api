// Keep local-part case and plus/dot aliases distinct; email equality never links identities.
export function normalizeInvitationRecipient(value) {
  if (typeof value !== 'string' || value.length > 254 || value.trim() !== value) {
    throw new TypeError('INVITATION_RECIPIENT_INVALID');
  }
  const parts = value.split('@');
  if (parts.length !== 2) throw new TypeError('INVITATION_RECIPIENT_INVALID');
  const [local, domain] = parts;
  if (local.length < 1 || local.length > 64
    || !/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)
    || local.startsWith('.') || local.endsWith('.') || local.includes('..')
    || domain.length > 253 || !domain.includes('.')) {
    throw new TypeError('INVITATION_RECIPIENT_INVALID');
  }
  const labels = domain.split('.');
  if (labels.some((label) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))
    || !/^[A-Za-z]{2,63}$/.test(labels.at(-1))) {
    throw new TypeError('INVITATION_RECIPIENT_INVALID');
  }
  return `${local}@${domain.toLowerCase()}`;
}
