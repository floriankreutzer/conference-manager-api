const HASH_PATTERN = /^[0-9a-f]{64}$/;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;

function assertProvider(value) {
  if (typeof value !== 'string' || !PROVIDER_PATTERN.test(value)) throw new TypeError('OIDC_PROVIDER_INVALID');
}

function assertHash(value, code) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) throw new TypeError(code);
}

function assertDate(value, code) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError(code);
}

export function createPostgresOidcTransactionRepository(pool) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');

  return Object.freeze({
    async create({ provider, stateHash, nonceHash, createdAt, expiresAt }) {
      assertProvider(provider);
      assertHash(stateHash, 'OIDC_STATE_HASH_INVALID');
      assertHash(nonceHash, 'OIDC_NONCE_HASH_INVALID');
      assertDate(createdAt, 'OIDC_CREATED_AT_INVALID');
      assertDate(expiresAt, 'OIDC_EXPIRES_AT_INVALID');
      if (expiresAt <= createdAt) throw new TypeError('OIDC_EXPIRY_INVALID');

      await pool.query({
        name: 'oidc-delete-expired-before-create',
        text: 'DELETE FROM oidc_auth_transactions WHERE expires_at <= $1',
        values: [createdAt],
      });
      await pool.query({
        name: 'oidc-create-transaction',
        text: `
          INSERT INTO oidc_auth_transactions (
            provider,
            state_hash,
            nonce_hash,
            created_at,
            expires_at
          ) VALUES ($1, $2, $3, $4, $5)
        `,
        values: [provider, stateHash, nonceHash, createdAt, expiresAt],
      });
    },

    async consume({ provider, stateHash, consumedAt }) {
      assertProvider(provider);
      assertHash(stateHash, 'OIDC_STATE_HASH_INVALID');
      assertDate(consumedAt, 'OIDC_CONSUMED_AT_INVALID');
      const result = await pool.query({
        name: 'oidc-consume-transaction',
        text: `
          DELETE FROM oidc_auth_transactions
          WHERE provider = $1
            AND state_hash = $2
            AND expires_at > $3
          RETURNING nonce_hash
        `,
        values: [provider, stateHash, consumedAt],
      });
      const row = result.rows[0];
      if (!row) return null;
      assertHash(row.nonce_hash, 'OIDC_NONCE_HASH_INVALID');
      return Object.freeze({ nonceHash: row.nonce_hash });
    },
  });
}
