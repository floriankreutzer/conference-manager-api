function oneOrNull(result, code) {
  if (result.rowCount === 0) return null;
  if (result.rowCount !== 1) throw new Error(code);
  return result.rows[0];
}

function customerProjection(row) {
  if (!row) return null;
  return Object.freeze({
    tenantId: row.tenant_id,
    tenantStatus: row.tenant_status,
    persona: row.persona,
    userId: row.user_id,
    securityVersion: Number(row.security_version),
    roles: Object.freeze([...row.roles]),
    providerIdentity: Object.freeze({
      provider: row.provider,
      reference: row.provider_subject_reference,
    }),
  });
}

function platformProjection(row) {
  if (!row) return null;
  const securityVersion = Number(row.security_version);
  return Object.freeze({
    persona: row.persona,
    operatorId: row.operator_id,
    securityVersion,
    roles: Object.freeze([...row.roles]),
    tenantIds: Object.freeze([...row.tenant_ids]),
    targetScope: Object.freeze({ mode: row.scope_mode, securityVersion }),
    providerIdentity: Object.freeze({
      provider: row.provider,
      tenantReference: row.provider_tenant_reference,
      subjectReference: row.provider_subject_reference,
    }),
    assurance: Object.freeze({
      level: row.assurance_level,
      authenticationContext: row.authentication_context,
    }),
  });
}

const CUSTOMER_SELECT = `
  SELECT reference.tenant_id, reference.persona, tenant.status AS tenant_status,
         reference.subject_id AS user_id, reference.provider,
         reference.provider_subject_reference, app_user.security_version,
         ARRAY['employee']::text[] || COALESCE(
           array_agg(role.role ORDER BY role.role)
             FILTER (WHERE role.role IS NOT NULL), ARRAY[]::text[]
         ) AS roles
  FROM demo_customer_persona_references AS reference
  JOIN tenants AS tenant
    ON tenant.id = reference.tenant_id
   AND (tenant.status IN ('ready', 'active')
     OR (tenant.status = 'onboarding' AND reference.persona = 'tenant_admin'))
  JOIN users AS app_user
    ON app_user.tenant_id = reference.tenant_id
   AND app_user.id = reference.subject_id
   AND app_user.active = true
  JOIN user_identity_bindings AS binding
    ON binding.tenant_id = app_user.tenant_id
   AND binding.user_id = app_user.id
   AND binding.provider = reference.provider
   AND binding.provider_tenant_reference = reference.tenant_id::text
   AND binding.provider_user_reference = reference.provider_subject_reference
  LEFT JOIN tenant_user_roles AS role
    ON role.tenant_id = app_user.tenant_id AND role.user_id = app_user.id
`;

const CUSTOMER_GROUP = `
  GROUP BY reference.tenant_id, reference.persona, tenant.status, reference.subject_id,
           reference.provider, reference.provider_subject_reference,
           app_user.security_version
`;

const PLATFORM_SELECT = `
  SELECT reference.persona, reference.operator_id,
         reference.provider, reference.provider_tenant_reference,
         reference.provider_subject_reference, reference.assurance_level,
         reference.authentication_context, operator.roles,
         operator.security_version, operator.scope_mode,
         COALESCE(array_agg(scope.tenant_id ORDER BY scope.tenant_id)
           FILTER (WHERE scope.tenant_id IS NOT NULL), ARRAY[]::uuid[]) AS tenant_ids
  FROM demo_platform_persona_references AS reference
  JOIN platform_operators AS operator
    ON operator.id = reference.operator_id AND operator.status = 'active'
  LEFT JOIN platform_operator_tenant_scopes AS scope ON scope.operator_id = operator.id
`;

const PLATFORM_GROUP = `
  GROUP BY reference.persona, reference.operator_id, reference.provider,
           reference.provider_tenant_reference, reference.provider_subject_reference,
           reference.assurance_level, reference.authentication_context,
           operator.roles, operator.security_version, operator.scope_mode
`;

export function createPostgresDemoPersonaRepository({ pool } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('POSTGRES_POOL_REQUIRED');

  async function findCustomer(where, values, name) {
    const result = await pool.query({
      name,
      text: `${CUSTOMER_SELECT} WHERE ${where} ${CUSTOMER_GROUP}`,
      values,
    });
    return customerProjection(oneOrNull(result, 'DEMO_CUSTOMER_PERSONA_AMBIGUOUS'));
  }

  async function findPlatform(where, values, name) {
    const result = await pool.query({
      name,
      text: `${PLATFORM_SELECT} WHERE ${where} ${PLATFORM_GROUP}`,
      values,
    });
    return platformProjection(oneOrNull(result, 'DEMO_PLATFORM_PERSONA_AMBIGUOUS'));
  }

  return Object.freeze({
    async listTenants() {
      const result = await pool.query({
        name: 'demo-persona-list-tenants',
        text: `
          SELECT tenant.id, tenant.display_name, tenant.status, tenant.lifecycle_revision
          FROM tenants AS tenant
          WHERE tenant.status IN ('ready', 'active', 'onboarding')
            AND EXISTS (
              SELECT 1
              FROM demo_customer_persona_references AS reference
              WHERE reference.tenant_id = tenant.id
            )
          ORDER BY tenant.id
        `,
      });
      return Object.freeze(result.rows.map((row) => Object.freeze({
        id: row.id,
        displayName: row.display_name,
        lifecycleStatus: row.status,
        lifecycleRevision: Number(row.lifecycle_revision),
      })));
    },
    findCustomer({ tenantId, persona }) {
      return findCustomer(
        'reference.tenant_id = $1 AND reference.persona = $2',
        [tenantId, persona],
        'demo-persona-find-customer',
      );
    },
    findCustomerForPrincipal({ tenantId, userId }) {
      return findCustomer(
        'reference.tenant_id = $1 AND reference.subject_id = $2',
        [tenantId, userId],
        'demo-persona-find-customer-principal',
      );
    },
    async findDefaultCustomer({ persona }) {
      const result = await pool.query({
        name: 'demo-persona-find-default-customer',
        text: `${CUSTOMER_SELECT}
          WHERE reference.persona = $1
          ${CUSTOMER_GROUP}
          ORDER BY reference.tenant_id
          LIMIT 1
        `,
        values: [persona],
      });
      return customerProjection(oneOrNull(result, 'DEMO_CUSTOMER_PERSONA_AMBIGUOUS'));
    },
    findPlatform({ persona }) {
      return findPlatform(
        'reference.persona = $1',
        [persona],
        'demo-persona-find-platform',
      );
    },
    findPlatformForPrincipal({ operatorId }) {
      return findPlatform(
        'reference.operator_id = $1',
        [operatorId],
        'demo-persona-find-platform-principal',
      );
    },
  });
}

