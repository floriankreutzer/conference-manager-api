-- Unreleased: requires the separately reviewed Platform enrollment055 chain.
-- Mailbox identity proves only address ownership; Tenant authority lives in membership/User state.
CREATE FUNCTION customer_access_envelope_valid(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN jsonb_typeof(value)<>'object' THEN false ELSE
    octet_length(value::text)<=45000
    AND (SELECT count(*) FROM jsonb_object_keys(value))=5
    AND value ?& ARRAY['schemaVersion','keyId','nonce','tag','ciphertext']
    AND value->'schemaVersion'='1'::jsonb
    AND jsonb_typeof(value->'keyId')='string' AND value->>'keyId' ~ '^[a-z][a-z0-9_]{1,31}$'
    AND jsonb_typeof(value->'nonce')='string' AND value->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
    AND jsonb_typeof(value->'tag')='string' AND value->>'tag' ~ '^[A-Za-z0-9_-]{22}$'
    AND jsonb_typeof(value->'ciphertext')='string' AND char_length(value->>'ciphertext') BETWEEN 2 AND 43691
    AND value->>'ciphertext' ~ '^[A-Za-z0-9_-]+$'
    END
$$;
REVOKE ALL ON FUNCTION customer_access_envelope_valid(jsonb) FROM PUBLIC;

CREATE TABLE customer_access_mailboxes (
  environment varchar(4) NOT NULL CHECK (environment IN ('dev','int','prod')),
  id uuid NOT NULL,
  lookup_hash varchar(64) NOT NULL CHECK (lookup_hash ~ '^[a-f0-9]{64}$'),
  recipient_envelope jsonb NOT NULL CHECK (customer_access_envelope_valid(recipient_envelope)),
  custody_version bigint NOT NULL DEFAULT 1 CHECK (custody_version BETWEEN 1 AND 9007199254740990),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(environment,id), UNIQUE(environment,lookup_hash)
);

CREATE TABLE customer_access_memberships (
  environment varchar(4) NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  mailbox_id uuid NOT NULL,
  user_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  accepted_at timestamptz,
  PRIMARY KEY(environment,tenant_id,id), UNIQUE(environment,id),
  UNIQUE(environment,tenant_id,mailbox_id), UNIQUE(environment,tenant_id,user_id),
  UNIQUE(environment,tenant_id,id,mailbox_id),
  FOREIGN KEY(environment,mailbox_id) REFERENCES customer_access_mailboxes(environment,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  CHECK ((user_id IS NULL)=(accepted_at IS NULL)),
  CHECK (accepted_at IS NULL OR accepted_at>=created_at)
);

CREATE TABLE customer_member_invitations (
  environment varchar(4) NOT NULL,
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  membership_id uuid NOT NULL,
  mailbox_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 9007199254740990),
  elevated_roles varchar(64)[] NOT NULL CHECK (array_position(elevated_roles,NULL) IS NULL AND elevated_roles IN (
    ARRAY[]::varchar[],ARRAY['conference_manager']::varchar[],ARRAY['tenant_admin']::varchar[],
    ARRAY['conference_manager','tenant_admin']::varchar[])),
  locale varchar(2) NOT NULL CHECK (locale IN ('de','en')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  last_audit_event_id bigint NOT NULL CHECK(last_audit_event_id>0),
  PRIMARY KEY(environment,tenant_id,id), UNIQUE(environment,id), UNIQUE(environment,tenant_id,id,mailbox_id),
  FOREIGN KEY(environment,tenant_id,membership_id,mailbox_id) REFERENCES customer_access_memberships(environment,tenant_id,id,mailbox_id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,last_audit_event_id) REFERENCES audit_events(tenant_id,id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (issued_at>=created_at AND expires_at>issued_at AND expires_at<=issued_at+interval '7 days'),
  CHECK (accepted_at IS NULL OR (accepted_at>=issued_at AND accepted_at<expires_at)),
  CHECK (revoked_at IS NULL OR revoked_at>=created_at),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
CREATE UNIQUE INDEX customer_member_one_open_invitation_idx
  ON customer_member_invitations(environment,tenant_id,membership_id) WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE FUNCTION customer_invitation_receipt_valid(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN jsonb_typeof(value)<>'array' THEN false ELSE
    jsonb_array_length(value) BETWEEN 1 AND 20 AND octet_length(value::text)<=16384
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(value) entry WHERE
      CASE WHEN jsonb_typeof(entry)<>'object' THEN true ELSE NOT COALESCE(
        (SELECT count(*) FROM jsonb_object_keys(entry))=7
        AND entry ?& ARRAY['id','revision','roles','locale','state','expiresAt','delivery']
        AND jsonb_typeof(entry->'id')='string'
        AND entry->>'id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
        AND entry->'revision'='1'::jsonb
        AND entry->'roles' IN ('[]'::jsonb,'["conference_manager"]'::jsonb,'["tenant_admin"]'::jsonb,
          '["conference_manager","tenant_admin"]'::jsonb)
        AND entry->>'locale' IN ('de','en') AND entry->>'state'='pending' AND entry->>'delivery'='queued'
        AND jsonb_typeof(entry->'expiresAt')='string'
        AND entry->>'expiresAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$', false) END)
    END
$$;
REVOKE ALL ON FUNCTION customer_invitation_receipt_valid(jsonb) FROM PUBLIC;

CREATE TABLE customer_access_commands (
  environment varchar(4) NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  actor_user_id uuid,
  actor_operator_id uuid,
  command_hash varchar(64) NOT NULL CHECK(command_hash ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK(customer_invitation_receipt_valid(result)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(environment,tenant_id,id),
  FOREIGN KEY(tenant_id,actor_user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(actor_operator_id) REFERENCES platform_operators(id) ON DELETE RESTRICT,
  CHECK ((actor_user_id IS NULL)<>(actor_operator_id IS NULL)),
  CHECK(environment IN ('dev','int','prod'))
);

CREATE TABLE customer_email_challenges (
  environment varchar(4) NOT NULL,
  id uuid NOT NULL,
  mailbox_id uuid,
  recipient_lookup_hash varchar(64) NOT NULL CHECK(recipient_lookup_hash ~ '^[a-f0-9]{64}$'),
  flow_browser_verifier varchar(64) NOT NULL CHECK(flow_browser_verifier ~ '^[a-f0-9]{64}$'),
  code_verifier varchar(64) NOT NULL CHECK(code_verifier ~ '^[a-f0-9]{64}$'),
  browser_verifier varchar(64) NOT NULL CHECK(browser_verifier ~ '^[a-f0-9]{64}$'),
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 5),
  admission_snapshot jsonb NOT NULL CHECK(jsonb_typeof(admission_snapshot)='array'
    AND jsonb_array_length(admission_snapshot) BETWEEN 0 AND 100 AND octet_length(admission_snapshot::text)<=32768),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  choice_verifier varchar(64) CHECK(choice_verifier ~ '^[a-f0-9]{64}$'),
  consumed_at timestamptz,
  PRIMARY KEY(environment,id), UNIQUE(environment,id,mailbox_id),
  FOREIGN KEY(environment,mailbox_id) REFERENCES customer_access_mailboxes(environment,id) ON DELETE RESTRICT,
  CHECK(expires_at>=created_at+interval '2 minutes' AND expires_at<=created_at+interval '15 minutes'),
  CHECK((mailbox_id IS NULL AND admission_snapshot='[]'::jsonb AND verified_at IS NULL)
    OR (mailbox_id IS NOT NULL AND jsonb_array_length(admission_snapshot)>0)),
  CHECK((verified_at IS NULL)=(choice_verifier IS NULL)),
  CHECK(verified_at IS NULL OR (verified_at>=created_at AND verified_at<expires_at)),
  CHECK(consumed_at IS NULL OR consumed_at>=created_at)
);
CREATE INDEX customer_email_challenge_mailbox_idx ON customer_email_challenges(environment,mailbox_id,created_at DESC);

CREATE TABLE customer_access_deliveries (
  environment varchar(4) NOT NULL,
  id uuid NOT NULL,
  mailbox_id uuid NOT NULL,
  tenant_id uuid,
  invitation_id uuid,
  invitation_revision bigint,
  challenge_id uuid,
  purpose varchar(32) NOT NULL CHECK(purpose IN ('membership_invitation','mailbox_code')),
  payload_envelope jsonb NOT NULL CHECK(customer_access_envelope_valid(payload_envelope)),
  status varchar(16) NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','claimed','accepted','failed','cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_id uuid,
  lease_until timestamptz,
  provider_message_id uuid,
  accepted_at timestamptz,
  PRIMARY KEY(environment,id), UNIQUE(environment,id,mailbox_id),
  FOREIGN KEY(environment,mailbox_id) REFERENCES customer_access_mailboxes(environment,id) ON DELETE RESTRICT,
  FOREIGN KEY(environment,tenant_id,invitation_id,mailbox_id) REFERENCES customer_member_invitations(environment,tenant_id,id,mailbox_id) ON DELETE RESTRICT,
  FOREIGN KEY(environment,challenge_id,mailbox_id) REFERENCES customer_email_challenges(environment,id,mailbox_id) ON DELETE RESTRICT,
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '23 hours'),
  CHECK(next_attempt_at>=created_at),
  CHECK((status='claimed')=(lease_id IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK((lease_id IS NULL)=(lease_until IS NULL)),
  CHECK(lease_until IS NULL OR (lease_until>created_at AND lease_until<=expires_at)),
  CHECK((status='accepted')=(accepted_at IS NOT NULL AND provider_message_id IS NOT NULL)),
  CHECK((accepted_at IS NULL)=(provider_message_id IS NULL)),
  CHECK(accepted_at IS NULL OR accepted_at>=created_at),
  CHECK((purpose='membership_invitation' AND tenant_id IS NOT NULL AND invitation_id IS NOT NULL
      AND invitation_revision IS NOT NULL AND invitation_revision BETWEEN 1 AND 9007199254740990 AND challenge_id IS NULL)
    OR (purpose='mailbox_code' AND tenant_id IS NULL AND invitation_id IS NULL AND invitation_revision IS NULL AND challenge_id IS NOT NULL))
);
CREATE INDEX customer_access_delivery_queue_idx ON customer_access_deliveries(environment,next_attempt_at,id) WHERE status IN ('queued','claimed');

-- Opaque recipient/source budgets include unknown addresses and survive challenge replacement.
CREATE TABLE customer_access_abuse_budgets (
  environment varchar(4) NOT NULL CHECK(environment IN ('dev','int','prod')),
  kind varchar(16) NOT NULL CHECK(kind IN ('recipient','source')),
  key_hash varchar(64) NOT NULL CHECK(key_hash ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  issue_count integer NOT NULL DEFAULT 0 CHECK(issue_count BETWEEN 0 AND 100),
  failure_count integer NOT NULL DEFAULT 0 CHECK(failure_count BETWEEN 0 AND 100),
  last_issued_at timestamptz,
  PRIMARY KEY(environment,kind,key_hash),
  CHECK(last_issued_at IS NULL OR last_issued_at>=window_started_at)
);

CREATE FUNCTION guard_customer_access_custody() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE allowed text[];
BEGIN
  IF TG_OP='INSERT' THEN
    IF TG_TABLE_NAME<>'customer_access_memberships' OR NEW.user_id IS NOT NULL OR NEW.accepted_at IS NOT NULL THEN
      RAISE EXCEPTION 'CUSTOMER_MEMBERSHIP_MUST_BEGIN_PENDING' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'CUSTOMER_ACCESS_REQUIRES_VERIFIED_RETENTION' USING ERRCODE='55000';
  END IF;
  CASE TG_TABLE_NAME
    WHEN 'customer_access_mailboxes' THEN
      allowed:=ARRAY['recipient_envelope','custody_version'];
      IF NEW.custody_version<>OLD.custody_version+1 THEN
        RAISE EXCEPTION 'CUSTOMER_ACCESS_CUSTODY_VERSION_INVALID' USING ERRCODE='23514';
      END IF;
    WHEN 'customer_access_memberships' THEN
      allowed:=ARRAY['user_id','accepted_at'];
      IF OLD.user_id IS NOT NULL OR NEW.user_id IS NULL OR NEW.accepted_at IS NULL THEN
        RAISE EXCEPTION 'CUSTOMER_ACCESS_MEMBERSHIP_IMMUTABLE' USING ERRCODE='23514';
      END IF;
    WHEN 'customer_member_invitations' THEN
      allowed:=ARRAY['revision','issued_at','expires_at','accepted_at','revoked_at','last_audit_event_id'];
      IF OLD.accepted_at IS NOT NULL OR OLD.revoked_at IS NOT NULL OR NEW.revision<>OLD.revision+1
        OR NEW.last_audit_event_id=OLD.last_audit_event_id OR NEW.issued_at<OLD.issued_at
        OR ((NEW.accepted_at IS NOT NULL OR NEW.revoked_at IS NOT NULL)
          AND (NEW.issued_at<>OLD.issued_at OR NEW.expires_at<>OLD.expires_at))
      THEN RAISE EXCEPTION 'CUSTOMER_INVITATION_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
    WHEN 'customer_email_challenges' THEN
      allowed:=ARRAY['attempt_count','verified_at','choice_verifier','consumed_at'];
      IF OLD.consumed_at IS NOT NULL OR NEW.attempt_count<OLD.attempt_count
        OR (OLD.verified_at IS NOT NULL AND (NEW.verified_at IS DISTINCT FROM OLD.verified_at
          OR NEW.choice_verifier IS DISTINCT FROM OLD.choice_verifier))
      THEN RAISE EXCEPTION 'CUSTOMER_EMAIL_PROOF_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
    WHEN 'customer_access_deliveries' THEN
      allowed:=ARRAY['status','attempt_count','next_attempt_at','lease_id','lease_until','provider_message_id','accepted_at'];
      IF OLD.status IN ('accepted','failed','cancelled') OR NEW.attempt_count<OLD.attempt_count
        OR NEW.next_attempt_at<OLD.next_attempt_at
      THEN RAISE EXCEPTION 'CUSTOMER_EMAIL_DELIVERY_TRANSITION_INVALID' USING ERRCODE='23514'; END IF;
    ELSE
      RAISE EXCEPTION 'CUSTOMER_ACCESS_RECORD_IMMUTABLE' USING ERRCODE='23514';
  END CASE;
  IF to_jsonb(NEW)-allowed IS DISTINCT FROM to_jsonb(OLD)-allowed THEN
    RAISE EXCEPTION 'CUSTOMER_ACCESS_SCOPE_IMMUTABLE' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_customer_access_custody() FROM PUBLIC;

CREATE TRIGGER customer_mailbox_custody_guard BEFORE UPDATE OR DELETE ON customer_access_mailboxes
  FOR EACH ROW EXECUTE FUNCTION guard_customer_access_custody();
CREATE TRIGGER customer_membership_custody_guard BEFORE INSERT OR UPDATE OR DELETE ON customer_access_memberships
  FOR EACH ROW EXECUTE FUNCTION guard_customer_access_custody();
CREATE TRIGGER customer_invitation_custody_guard BEFORE UPDATE OR DELETE ON customer_member_invitations
  FOR EACH ROW EXECUTE FUNCTION guard_customer_access_custody();
CREATE TRIGGER customer_command_custody_guard BEFORE UPDATE OR DELETE ON customer_access_commands
  FOR EACH ROW EXECUTE FUNCTION guard_customer_access_custody();
CREATE TRIGGER customer_email_proof_custody_guard BEFORE UPDATE OR DELETE ON customer_email_challenges
  FOR EACH ROW EXECUTE FUNCTION guard_customer_access_custody();
CREATE TRIGGER customer_email_delivery_custody_guard BEFORE UPDATE OR DELETE ON customer_access_deliveries
  FOR EACH ROW EXECUTE FUNCTION guard_customer_access_custody();

CREATE FUNCTION verify_customer_invitation_audit() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.audit_events event
    WHERE event.tenant_id=NEW.tenant_id AND event.id=NEW.last_audit_event_id
      AND event.action='tenant.onboarding.invited' AND event.target_type='customer_invitation'
      AND event.target_id=NEW.id::text AND event.outcome='success'
      AND event.new_state->>'revision'=NEW.revision::text
      AND event.metadata->>'operation'=CASE WHEN NEW.accepted_at IS NOT NULL THEN 'accept'
        WHEN NEW.revoked_at IS NOT NULL THEN 'revoke' WHEN NEW.revision=1 THEN 'issue' ELSE 'reissue' END)
  THEN RAISE EXCEPTION 'CUSTOMER_INVITATION_AUDIT_REQUIRED' USING ERRCODE='23514'; END IF;
  IF NEW.accepted_at IS NULL AND NEW.revoked_at IS NULL AND NOT EXISTS(SELECT 1 FROM public.customer_access_deliveries delivery
    WHERE delivery.environment=NEW.environment AND delivery.tenant_id=NEW.tenant_id AND delivery.invitation_id=NEW.id
      AND delivery.invitation_revision=NEW.revision AND delivery.mailbox_id=NEW.mailbox_id
      AND delivery.purpose='membership_invitation')
  THEN RAISE EXCEPTION 'CUSTOMER_INVITATION_DELIVERY_REQUIRED' USING ERRCODE='23514'; END IF;
  IF NEW.accepted_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.customer_access_memberships membership
    WHERE membership.environment=NEW.environment AND membership.tenant_id=NEW.tenant_id
      AND membership.id=NEW.membership_id AND membership.mailbox_id=NEW.mailbox_id
      AND membership.user_id IS NOT NULL AND membership.accepted_at=NEW.accepted_at)
  THEN RAISE EXCEPTION 'CUSTOMER_INVITATION_MEMBERSHIP_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION verify_customer_invitation_audit() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER customer_invitation_audit_required AFTER INSERT OR UPDATE ON customer_member_invitations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_customer_invitation_audit();

CREATE FUNCTION verify_customer_membership_acceptance() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.user_id IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.customer_member_invitations invitation
    JOIN public.users member ON member.tenant_id=invitation.tenant_id AND member.id=NEW.user_id
    JOIN public.user_identity_bindings identity ON identity.tenant_id=member.tenant_id AND identity.user_id=member.id
      AND identity.provider='email_code' AND identity.provider_tenant_reference=NEW.environment
      AND identity.provider_user_reference=NEW.mailbox_id::text
    JOIN public.audit_events accepted ON accepted.tenant_id=invitation.tenant_id AND accepted.id=invitation.last_audit_event_id
    WHERE invitation.environment=NEW.environment AND invitation.tenant_id=NEW.tenant_id
      AND invitation.membership_id=NEW.id AND invitation.mailbox_id=NEW.mailbox_id
      AND invitation.accepted_at=NEW.accepted_at AND invitation.revoked_at IS NULL
      AND member.active=true AND member.security_version=1 AND member.created_at>=NEW.created_at
      AND invitation.elevated_roles=COALESCE((SELECT array_agg(role ORDER BY CASE role
        WHEN 'conference_manager' THEN 1 WHEN 'tenant_admin' THEN 2 ELSE 99 END)
        FROM public.tenant_user_roles WHERE tenant_id=NEW.tenant_id AND user_id=NEW.user_id),ARRAY[]::varchar[])
      AND EXISTS(SELECT 1 FROM public.audit_events provisioned WHERE provisioned.tenant_id=NEW.tenant_id
        AND provisioned.action='tenant.user.provisioned' AND provisioned.target_type='user'
        AND provisioned.target_id=NEW.user_id::text AND provisioned.outcome='success'
        AND provisioned.metadata->>'provider'='email_code' AND provisioned.correlation_id=accepted.correlation_id))
  THEN RAISE EXCEPTION 'CUSTOMER_MEMBERSHIP_ACCEPTANCE_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION verify_customer_membership_acceptance() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER customer_membership_acceptance_required AFTER INSERT OR UPDATE ON customer_access_memberships
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_customer_membership_acceptance();
