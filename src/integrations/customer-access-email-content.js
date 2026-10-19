import { isInternalUuid } from '../domain/identifiers.js';
import { normalizeInvitationRecipient } from '../domain/invitation-recipient.js';

const LOCALES = Object.freeze({ de: 'de-DE', en: 'en-GB' });
const ENVIRONMENTS = new Set(['dev', 'int', 'prod']);
const LABEL_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

function requireFields(input, fields) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== fields.length
    || Object.keys(input).some((key) => !fields.includes(key))) throw new TypeError('ACCESS_EMAIL_INPUT_INVALID');
}

function requireInstant(value) {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError('ACCESS_EMAIL_INPUT_INVALID');
  }
  return parsed;
}

function normalizeDelivery(input) {
  if (!Object.hasOwn(LOCALES, input.locale) || !isInternalUuid(input.deliveryId)) throw new TypeError('ACCESS_EMAIL_INPUT_INVALID');
  let recipient;
  try { recipient = normalizeInvitationRecipient(input.recipient); }
  catch { throw new TypeError('ACCESS_EMAIL_INPUT_INVALID'); }
  return { recipient, deliveryId: input.deliveryId.toLowerCase() };
}

function normalizeCommon(input) {
  const delivery = normalizeDelivery(input);
  if (typeof input.tenantDisplayName !== 'string' || input.tenantDisplayName.trim() !== input.tenantDisplayName
    || input.tenantDisplayName.length < 1 || input.tenantDisplayName.length > 160
    || LABEL_CONTROL.test(input.tenantDisplayName)) throw new TypeError('ACCESS_EMAIL_INPUT_INVALID');
  return delivery;
}

function expiryText(locale, milliseconds) {
  return new Intl.DateTimeFormat(LOCALES[locale], {
    timeZone: 'UTC', year: 'numeric', month: 'long', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  }).format(milliseconds);
}

// Pure, inactive plain-text templates. Callers must first authorize durable membership and delivery.
export function createCustomerAccessEmailContent({ publicOrigin, environment } = {}) {
  let origin;
  try {
    const parsed = new URL(publicOrigin);
    if (typeof publicOrigin !== 'string' || parsed.protocol !== 'https:' || parsed.origin !== publicOrigin) throw new Error();
    origin = parsed.origin;
  } catch {
    throw new TypeError('ACCESS_EMAIL_CONFIGURATION_INVALID');
  }
  if (!ENVIRONMENTS.has(environment)) throw new TypeError('ACCESS_EMAIL_CONFIGURATION_INVALID');
  const commonFields = ['recipient', 'tenantDisplayName', 'locale', 'deliveryId'];
  const label = environment === 'prod' ? 'Conference Manager' : `Conference Manager [${environment.toUpperCase()}]`;

  function finish(input, normalized, subject, paragraphs) {
    const environmentNotice = environment === 'prod' ? [] : [input.locale === 'de'
      ? `Diese Nachricht gehört zur Testumgebung ${environment.toUpperCase()}.`
      : `This message belongs to the ${environment.toUpperCase()} test environment.`];
    return Object.freeze({ ...normalized, subject: `${label}: ${subject}`,
      text: [...environmentNotice, ...paragraphs].join('\n\n') });
  }

  function codeMessage(input, normalized, introduction) {
    const issued = requireInstant(input.issuedAt), expires = requireInstant(input.expiresAt);
    if (typeof input.code !== 'string' || !/^\d{8}$/.test(input.code)
      || expires - issued < 120_000 || expires - issued > 900_000) throw new TypeError('ACCESS_EMAIL_INPUT_INVALID');
    const expiry = expiryText(input.locale, expires);
    return input.locale === 'de'
      ? finish(input, normalized, 'Dein Anmeldecode', [
        `${introduction}\n${input.code}`,
        `Der Code läuft am ${expiry} ab. Er kann nur einmal und im Browser verwendet werden, in dem du ihn angefordert hast.`,
        'Gib den Code ausschließlich in der geöffneten Conference-Manager-Anmeldung ein. Teile ihn mit niemandem.',
        'Wenn du den Code nicht angefordert hast, ignoriere diese Nachricht. Es wurde dadurch keine Sitzung angemeldet.',
      ])
      : finish(input, normalized, 'Your sign-in code', [
        `${introduction}\n${input.code}`,
        `The code expires on ${expiry}. It can be used once, in the browser where you requested it.`,
        'Enter the code only in the Conference Manager sign-in page you opened. Do not share it with anyone.',
        'If you did not request this code, ignore this message. This message alone has not signed you in.',
      ]);
  }

  return Object.freeze({
    invitation(input) {
      requireFields(input, commonFields);
      const normalized = normalizeCommon(input);
      const tenant = input.tenantDisplayName;
      return input.locale === 'de'
        ? finish(input, normalized, 'Deine Einladung', [
          `Du wurdest zu Conference Manager für „${tenant}“ eingeladen.`,
          `Öffne Conference Manager und melde dich mit der E-Mail-Adresse an, an die diese Einladung gesendet wurde:\n${origin}/`,
          'Deine verfügbaren Funktionen richten sich nach den Berechtigungen, die dir deine Organisation zugewiesen hat.',
          'Falls du diese Einladung nicht erwartet hast, wende dich an deine Kontaktperson in der Organisation.',
        ])
        : finish(input, normalized, 'Your invitation', [
          `You have been invited to Conference Manager for “${tenant}”.`,
          `Open Conference Manager and sign in with the email address that received this invitation:\n${origin}/`,
          'Your available features depend on the permissions assigned by your organisation.',
          'If you were not expecting this invitation, contact your contact person at the organisation.',
        ]);
    },

    signInCode(input) {
      requireFields(input, [...commonFields, 'code', 'issuedAt', 'expiresAt']);
      const normalized = normalizeCommon(input);
      return codeMessage(input, normalized, input.locale === 'de'
        ? `Dein Anmeldecode für „${input.tenantDisplayName}“:` : `Your sign-in code for “${input.tenantDisplayName}”:`);
    },

    mailboxSignInCode(input) {
      requireFields(input, ['recipient', 'locale', 'deliveryId', 'code', 'issuedAt', 'expiresAt']);
      return codeMessage(input, normalizeDelivery(input), input.locale === 'de'
        ? 'Dein Anmeldecode für Conference Manager:' : 'Your Conference Manager sign-in code:');
    },
  });
}
