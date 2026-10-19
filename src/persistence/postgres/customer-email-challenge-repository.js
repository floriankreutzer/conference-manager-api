import { randomBytes, randomUUID } from 'node:crypto';
import { isInternalUuid } from '../../domain/identifiers.js';
import { normalizeInvitationRecipient } from '../../domain/invitation-recipient.js';
import { normalizeCustomerEmailAdmissionSnapshot } from '../../identity/customer-email-admission.js';
import { isCustomerEmailBrowserToken } from '../../identity/customer-email-browser-token.js';
import { withCustomerEmailBudget } from './customer-email-budget.js';

function uuid(value) {
  if (!isInternalUuid(value)) throw new TypeError('CUSTOMER_EMAIL_CHALLENGE_INPUT_INVALID');
  return value.toLowerCase();
}
const rejected = () => Object.freeze({ status: 'rejected' });
const ADMISSIONS = `SELECT member.id AS "membershipId",member.tenant_id AS "tenantId",member.user_id AS "userId",
  CASE WHEN member.user_id IS NOT NULL THEN person.security_version ELSE NULL END AS "userSecurityVersion",
  CASE WHEN member.user_id IS NULL THEN invitation.id ELSE NULL END AS "invitationId",
  CASE WHEN member.user_id IS NULL THEN invitation.revision ELSE NULL END AS "invitationRevision"
  FROM customer_access_memberships member JOIN tenants tenant ON tenant.id=member.tenant_id
  LEFT JOIN users person ON person.tenant_id=member.tenant_id AND person.id=member.user_id
  LEFT JOIN customer_member_invitations invitation ON invitation.environment=member.environment
    AND invitation.tenant_id=member.tenant_id AND invitation.membership_id=member.id
    AND member.user_id IS NULL AND invitation.accepted_at IS NULL AND invitation.revoked_at IS NULL
  WHERE member.environment=$1 AND member.mailbox_id=$2 AND tenant.status IN ('pending','onboarding','ready','active')
    AND ((member.user_id IS NOT NULL AND person.active=true)
      OR (member.user_id IS NULL AND invitation.accepted_at IS NULL AND invitation.revoked_at IS NULL AND invitation.expires_at>$3))
  ORDER BY member.tenant_id,member.id LIMIT 101`;

// Preauthentication custody only. No method creates a User, changes roles, links
// providers or issues a business session. Admission remains a separate transaction.
export function createPostgresCustomerEmailChallengeRepository(pool, {
  environment,cipher,proofFactory,flowBinding,content,identifierFactory = randomUUID,
} = {}) {
  if (!pool || typeof pool.connect !== 'function' || !['dev','int','prod'].includes(environment)
    || !cipher || ['recipientLookup','seal'].some(method => typeof cipher[method] !== 'function')
    || !proofFactory || ['issue','matches'].some(method => typeof proofFactory[method] !== 'function')
    || !flowBinding || ['issue','bind','matchesBrowser','csrfFor','verifyCsrf'].some(method => typeof flowBinding[method] !== 'function')
    || typeof content?.mailboxSignInCode !== 'function' || typeof identifierFactory !== 'function') {
    throw new TypeError('CUSTOMER_EMAIL_CHALLENGE_CONFIGURATION_INVALID');
  }
  const nextId = () => uuid(identifierFactory());
  async function row(challengeId,client = pool,lock = false) {
    const result = await client.query({ name: lock ? 'customer-email-challenge-lock' : 'customer-email-challenge-read',
      text: lock ? 'SELECT * FROM customer_email_challenges WHERE environment=$1 AND id=$2 FOR UPDATE'
        : 'SELECT * FROM customer_email_challenges WHERE environment=$1 AND id=$2',values: [environment,uuid(challengeId)] });
    return result.rows[0] ?? null;
  }
  function active(value,now,purpose) {
    return value && value.consumed_at === null && value.expires_at instanceof Date && value.expires_at.getTime()>now.getTime()
      && (purpose === 'request' ? value.verified_at === null && value.attempt_count<5
        : value.verified_at instanceof Date && now.getTime()<value.verified_at.getTime()+300_000);
  }
  function browser(value,browserToken,csrfToken,purpose) {
    const context = { challengeId: value.id,purpose };
    const browserVerifier = purpose === 'request' ? value.flow_browser_verifier : value.choice_verifier;
    return flowBinding.matchesBrowser({ context,browserToken,browserVerifier })
      && (csrfToken === undefined || flowBinding.verifyCsrf({ context,browserVerifier,csrfToken }));
  }
  return Object.freeze({
    async request({ recipient,locale,sourceKey } = {}) {
      recipient = normalizeInvitationRecipient(recipient);
      if (!['de','en'].includes(locale)) throw new TypeError('CUSTOMER_EMAIL_CHALLENGE_INPUT_INVALID');
      const recipientKey = cipher.recipientLookup(recipient);
      return withCustomerEmailBudget(pool,{ environment,sourceKey,recipientKey,operation: 'issue' },async ({ client,now }) => {
        const challengeId = nextId(),expiresAt = new Date(now.getTime()+600_000);
        const mailbox = (await client.query({ name: 'customer-email-mailbox-lookup',
          text: 'SELECT id FROM customer_access_mailboxes WHERE environment=$1 AND lookup_hash=$2',
          values: [environment,recipientKey] })).rows[0];
        let snapshot = [];
        if (mailbox) {
          const found = await client.query({ name: 'customer-email-admission-snapshot',
            text: ADMISSIONS,values: [environment,mailbox.id,now] });
          if (found.rows.length<=100) snapshot = normalizeCustomerEmailAdmissionSnapshot(found.rows.map(item => ({ ...item,
            userSecurityVersion: item.userSecurityVersion === null ? null : Number(item.userSecurityVersion),
            invitationRevision: item.invitationRevision === null ? null : Number(item.invitationRevision) })));
        }
        const mailboxId = snapshot.length ? mailbox.id : null;
        const context = { challengeId,purpose: 'request' };
        const proof = mailboxId ? proofFactory.issue({ challengeId,mailboxId }) : null;
        const flow = proof ? { browserToken: proof.browserToken,...flowBinding.bind(context,proof.browserToken) }
          : flowBinding.issue(context);
        // Invalidate older challenges under the shared recipient lock; neither a
        // replacement code nor an old provider retry can retain acceptance rights.
        await client.query({ name: 'customer-email-challenge-replace',text: `UPDATE customer_email_challenges
          SET consumed_at=$3 WHERE environment=$1 AND recipient_lookup_hash=$2 AND consumed_at IS NULL`,
        values: [environment,recipientKey,now] });
        await client.query({ name: 'customer-email-code-cancel-queued',text: `UPDATE customer_access_deliveries delivery
          SET status='cancelled' FROM customer_email_challenges challenge WHERE delivery.environment=$1
          AND delivery.challenge_id=challenge.id AND challenge.environment=delivery.environment
          AND challenge.recipient_lookup_hash=$2 AND delivery.status='queued'`,values: [environment,recipientKey] });
        await client.query({ name: 'customer-email-challenge-insert',text: `INSERT INTO customer_email_challenges
          (environment,id,mailbox_id,recipient_lookup_hash,flow_browser_verifier,code_verifier,browser_verifier,
           admission_snapshot,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
        values: [environment,challengeId,mailboxId,recipientKey,flow.browserVerifier,proof?.codeVerifier ?? randomBytes(32).toString('hex'),
          proof?.browserVerifier ?? randomBytes(32).toString('hex'),JSON.stringify(snapshot),now,expiresAt] });
        if (proof) {
          const deliveryId = nextId(),message = content.mailboxSignInCode({ recipient,locale,deliveryId,
            code: proof.code,issuedAt: now.toISOString(),expiresAt: expiresAt.toISOString() });
          const bytes = Buffer.from(JSON.stringify(message),'utf8'); let envelope;
          try { envelope = cipher.seal(bytes,{ environment,mailboxId,recordId: deliveryId,
            purpose: 'mailbox_code',tenantId: null }); }
          finally { bytes.fill(0); }
          await client.query({ name: 'customer-email-code-enqueue',text: `INSERT INTO customer_access_deliveries
            (environment,id,mailbox_id,challenge_id,purpose,payload_envelope,created_at,expires_at,next_attempt_at)
            VALUES($1,$2,$3,$4,'mailbox_code',$5::jsonb,$6,$7,$6)`,
          values: [environment,deliveryId,mailboxId,challengeId,JSON.stringify(envelope),now,expiresAt] });
        }
        return Object.freeze({ status: 'code_required',challengeId,browserToken: flow.browserToken,
          csrfToken: flow.csrfToken,expiresAt: expiresAt.toISOString() });
      });
    },
    async pending({ challengeId,browserToken } = {}) {
      if (!isCustomerEmailBrowserToken(browserToken)) return rejected();
      const value = await row(challengeId),now = (await pool.query('SELECT clock_timestamp() AS now')).rows[0].now;
      const purpose = value?.verified_at === null ? 'request' : 'choice';
      if (!active(value,now,purpose) || !browser(value,browserToken,undefined,purpose)) return rejected();
      return Object.freeze({ status: purpose === 'request' ? 'code_required' : 'membership_required',
        expiresAt: new Date(Math.min(value.expires_at.getTime(),purpose === 'choice'
          ? value.verified_at.getTime()+300_000 : value.expires_at.getTime())).toISOString(),
        csrfToken: flowBinding.csrfFor({ context: { challengeId: value.id,purpose },
          browserVerifier: purpose === 'request' ? value.flow_browser_verifier : value.choice_verifier }) });
    },
    async verify({ challengeId,browserToken,csrfToken,code,sourceKey } = {}) {
      if (!isCustomerEmailBrowserToken(browserToken) || typeof csrfToken !== 'string' || !/^[a-f0-9]{64}$/.test(csrfToken)
        || typeof code !== 'string' || !/^\d{8}$/.test(code)) return rejected();
      const lookup = await row(challengeId);
      if (!lookup) return rejected();
      return withCustomerEmailBudget(pool,{ environment,sourceKey,recipientKey: lookup.recipient_lookup_hash,operation: 'verify' },
        async ({ client,recordFailure }) => {
          const value = await row(challengeId,client,true);
          const now = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now;
          if (!active(value,now,'request') || !browser(value,browserToken,csrfToken,'request')) return rejected();
          const matches = value.mailbox_id !== null && proofFactory.matches({
            context: { challengeId: value.id,mailboxId: value.mailbox_id },
            code,browserToken,codeVerifier: value.code_verifier,browserVerifier: value.browser_verifier });
          if (!matches) {
            await client.query({ name: 'customer-email-code-failure',text: `UPDATE customer_email_challenges
              SET attempt_count=attempt_count+1
              WHERE environment=$1 AND id=$2`,values: [environment,value.id] });
            await recordFailure(); return rejected();
          }
          const choice = flowBinding.issue({ challengeId: value.id,purpose: 'choice' });
          await client.query({ name: 'customer-email-code-verified',text: `UPDATE customer_email_challenges
            SET verified_at=$3,choice_verifier=$4 WHERE environment=$1 AND id=$2`,
          values: [environment,value.id,now,choice.browserVerifier] });
          return Object.freeze({ status: 'membership_required',challengeId: value.id,browserToken: choice.browserToken,
            csrfToken: choice.csrfToken,expiresAt: new Date(Math.min(value.expires_at.getTime(),now.getTime()+300_000)).toISOString() });
        });
    },
  });
}
