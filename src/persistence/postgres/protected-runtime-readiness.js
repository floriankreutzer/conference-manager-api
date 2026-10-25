import { createPostgresProtectedRuntimeExecutionScopes } from './protected-runtime-execution-scopes.js';
import { protectedRuntimeRoleRequirements } from './protected-runtime-role-requirements.js';
import { isPostgresSchemaReady } from './pool.js';

const ROLE_POSTURE=`SELECT role.rolname=$1 AND role.rolname=current_user AND role.rolcanlogin
    AND NOT (role.rolsuper OR role.rolcreatedb OR role.rolcreaterole OR role.rolreplication OR role.rolbypassrls)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members member WHERE member.member=role.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_database owned WHERE owned.datdba=role.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace owned WHERE owned.nspowner=role.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class owned WHERE owned.relowner=role.oid)
    AND NOT pg_catalog.has_database_privilege(current_user,current_database(),'CREATE')
    AND NOT pg_catalog.has_database_privilege(current_user,current_database(),'TEMPORARY')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace namespace
      WHERE pg_catalog.has_schema_privilege(current_user,namespace.oid,'CREATE'))
    AND pg_catalog.has_schema_privilege(current_user,'public','USAGE')
    AND NOT EXISTS(SELECT 1 FROM unnest($2::text[]) required(name)
      WHERE NOT pg_catalog.has_table_privilege(current_user,'public.'||required.name,'SELECT'))
    AND NOT EXISTS(SELECT 1 FROM unnest($3::text[]) required(name)
      CROSS JOIN unnest(ARRAY['INSERT','UPDATE','DELETE']) permission(name)
      WHERE NOT pg_catalog.has_table_privilege(current_user,'public.'||required.name,permission.name))
    AND NOT EXISTS(SELECT 1 FROM unnest($4::text[]) forbidden(name)
      CROSS JOIN unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) permission(name)
      WHERE pg_catalog.has_table_privilege(current_user,'public.'||forbidden.name,permission.name)
        OR CASE WHEN permission.name IN ('INSERT','UPDATE','REFERENCES') THEN
          pg_catalog.has_any_column_privilege(current_user,'public.'||forbidden.name,permission.name) ELSE false END)
    AND NOT EXISTS(SELECT 1 FROM unnest($5::text[]) forbidden(name)
      WHERE pg_catalog.has_table_privilege(current_user,'public.'||forbidden.name,'INSERT')
        OR pg_catalog.has_any_column_privilege(current_user,'public.'||forbidden.name,'INSERT'))
    AND NOT EXISTS(SELECT 1 FROM unnest($6::text[]) required(name)
      WHERE NOT pg_catalog.has_column_privilege(current_user,'public.'||split_part(required.name,'.',1),
        split_part(required.name,'.',2),'SELECT'))
    AND NOT EXISTS(SELECT 1 FROM unnest($7::text[]) forbidden(name)
      WHERE pg_catalog.has_column_privilege(current_user,'public.'||split_part(forbidden.name,'.',1),
        split_part(forbidden.name,'.',2),'SELECT'))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace
      ON namespace.oid=relation.relnamespace WHERE namespace.nspname='public' AND relation.relkind IN ('r','p')
        AND (pg_catalog.has_table_privilege(current_user,relation.oid,'TRUNCATE')
          OR pg_catalog.has_table_privilege(current_user,relation.oid,'TRIGGER'))) AS allowed
  FROM pg_catalog.pg_roles role WHERE role.rolname=current_user`;

// Readiness is an observation, not identity/permission/lease authority. It owns
// no GRANT/role mutation and never substitutes for current request/provider checks.
export function createPostgresProtectedRuntimeReadiness(pool,{ leasePool,environment,securityEpoch,surface }={}) {
  const policy=protectedRuntimeRoleRequirements(surface);
  const scopes=createPostgresProtectedRuntimeExecutionScopes({ pool,leasePool,environment,securityEpoch });
  const role=`cm_protected_${environment}_${surface}`;
  return Object.freeze({ async isReady() {
    try {
      return await scopes.withShared(async()=>{
        if (!await isPostgresSchemaReady(pool)) return false;
        const result=await pool.query({ name: `protected-runtime-role-posture-${surface}`,text: ROLE_POSTURE,
          values: [role,policy.read,policy.write,policy.forbiddenMutation,policy.forbiddenInsert,
            policy.readColumns,policy.forbiddenReadColumns] });
        return result.rowCount===1 && result.rows[0]?.allowed===true;
      });
    } catch { return false; }
  } });
}
