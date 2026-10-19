-- Explicit Manager review is independent of source receipt and availability.
-- No existing source, offer, order or connection is published by this migration.
CREATE FUNCTION catering_catalogue_review_mapping_valid(value jsonb,variant boolean,bundle boolean)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE field text; entry jsonb; names text[];
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  names:=ARRAY['active','entryId','order','price','sourceId'];
  IF NOT variant THEN names:=names||ARRAY['roomIds','siteIds']; END IF;
  IF bundle THEN names:=names||ARRAY['variants']; END IF;
  IF ARRAY(SELECT jsonb_object_keys(value) ORDER BY 1)<>ARRAY(SELECT unnest(names) ORDER BY 1)
    OR jsonb_typeof(value->'sourceId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(value->'entryId') IS DISTINCT FROM 'string'
    OR value->>'sourceId' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR value->>'entryId' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR jsonb_typeof(value->'active') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(value->'order') IS DISTINCT FROM 'number'
    OR value->>'order' !~ '^(0|[1-9][0-9]{0,5})$'
    OR value->'price'='null'::jsonb
    OR NOT public.catering_provider_catalogue_money_valid(value->'price',false) THEN RETURN false; END IF;
  IF (value->>'order')::integer>100000 THEN RETURN false; END IF;
  IF NOT variant THEN
    FOREACH field IN ARRAY ARRAY['siteIds','roomIds'] LOOP
      IF jsonb_typeof(value->field) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
      IF jsonb_array_length(value->field)>200 OR (SELECT count(DISTINCT x) FROM jsonb_array_elements(value->field) x)
        <>jsonb_array_length(value->field) THEN RETURN false; END IF;
      FOR entry IN SELECT x FROM jsonb_array_elements(value->field) x LOOP
        IF jsonb_typeof(entry) IS DISTINCT FROM 'string' OR entry#>>'{}' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
          THEN RETURN false; END IF;
      END LOOP;
    END LOOP;
  END IF;
  IF bundle THEN
    IF jsonb_typeof(value->'variants') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(value->'variants')>20 THEN RETURN false; END IF;
    FOR entry IN SELECT x FROM jsonb_array_elements(value->'variants') x LOOP
      IF NOT public.catering_catalogue_review_mapping_valid(entry,true,false) THEN RETURN false; END IF;
    END LOOP;
    IF (SELECT count(DISTINCT x->>'sourceId') FROM jsonb_array_elements(value->'variants') x)<>jsonb_array_length(value->'variants')
      OR (SELECT count(DISTINCT x->>'entryId') FROM jsonb_array_elements(value->'variants') x)<>jsonb_array_length(value->'variants')
      THEN RETURN false; END IF;
  END IF;
  RETURN true;
END $$;
CREATE FUNCTION catering_catalogue_review_command_valid(command jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE field text; entry jsonb; lower_bound integer;
BEGIN
  IF jsonb_typeof(command) IS DISTINCT FROM 'object' OR octet_length(command::text)>1048576 THEN RETURN false; END IF;
  IF ARRAY(SELECT jsonb_object_keys(command) ORDER BY 1)<>ARRAY['commandId','decision','expectedAssignmentRevision',
    'expectedCatalogueRevision','expectedConfigurationRevision','expectedPublicationRevision','expectedReviewRevision',
    'expectedSourceRevision','items','justification','packages','schemaVersion']
    OR command->'schemaVersion' IS DISTINCT FROM '1'::jsonb
    OR jsonb_typeof(command->'commandId') IS DISTINCT FROM 'string'
    OR command->>'commandId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR command->>'decision' NOT IN ('published','rejected')
    OR jsonb_typeof(command->'decision') IS DISTINCT FROM 'string'
    OR NOT public.catering_provider_catalogue_text_valid(command->'justification',1000,false)
    OR jsonb_typeof(command->'items') IS DISTINCT FROM 'array'
    OR jsonb_typeof(command->'packages') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['expectedAssignmentRevision','expectedCatalogueRevision','expectedConfigurationRevision',
    'expectedPublicationRevision','expectedReviewRevision','expectedSourceRevision'] LOOP
    IF jsonb_typeof(command->field) IS DISTINCT FROM 'number' OR command->>field !~ '^(0|[1-9][0-9]{0,15})$'
      THEN RETURN false; END IF;
    lower_bound:=CASE WHEN field IN ('expectedAssignmentRevision','expectedPublicationRevision','expectedReviewRevision') THEN 0 ELSE 1 END;
    IF (command->>field)::bigint NOT BETWEEN lower_bound AND 9007199254740989 THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_array_length(command->'items')>300 OR jsonb_array_length(command->'packages')>100
    OR (command->>'decision'='rejected' AND (command->'items'<>'[]'::jsonb OR command->'packages'<>'[]'::jsonb))
    THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['items','packages'] LOOP
    FOR entry IN SELECT x FROM jsonb_array_elements(command->field) x LOOP
      IF NOT public.catering_catalogue_review_mapping_valid(entry,false,field='packages') THEN RETURN false; END IF;
    END LOOP;
    IF (SELECT count(DISTINCT x->>'sourceId') FROM jsonb_array_elements(command->field) x)<>jsonb_array_length(command->field)
      OR (SELECT count(DISTINCT x->>'entryId') FROM jsonb_array_elements(command->field) x)<>jsonb_array_length(command->field)
      THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;
CREATE TABLE catering_catalogue_reviews (
  tenant_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  command_id uuid NOT NULL,
  review_revision bigint NOT NULL CHECK (review_revision BETWEEN 1 AND 9007199254740990),
  source_revision bigint NOT NULL CHECK (source_revision BETWEEN 1 AND 9007199254740990),
  configuration_revision bigint NOT NULL CHECK (configuration_revision BETWEEN 1 AND 9007199254740990),
  publication_revision bigint NOT NULL CHECK (publication_revision BETWEEN 0 AND 9007199254740990),
  catalogue_revision bigint NOT NULL CHECK (catalogue_revision BETWEEN 1 AND 9007199254740990),
  assignment_revision bigint NOT NULL CHECK (assignment_revision BETWEEN 0 AND 9007199254740990),
  assignment_evidence_revision bigint GENERATED ALWAYS AS (nullif(assignment_revision,0)) STORED,
  reviewed_by_user_id uuid NOT NULL,
  actor_security_version bigint NOT NULL CHECK (actor_security_version BETWEEN 1 AND 9007199254740990),
  correlation_id uuid NOT NULL,
  command jsonb NOT NULL,
  bindings jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,integration_id,review_revision),
  UNIQUE (tenant_id,command_id),
  UNIQUE (tenant_id,integration_id,review_revision,publication_revision),
  FOREIGN KEY (tenant_id,integration_id,source_revision)
    REFERENCES catering_provider_catalogue_revisions(tenant_id,integration_id,revision) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,integration_id,configuration_revision)
    REFERENCES catering_integration_configuration_revisions(tenant_id,integration_id,revision) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,catalogue_revision) REFERENCES tenant_catalogue_revisions(tenant_id,revision) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,assignment_evidence_revision)
    REFERENCES catering_catalogue_assignment_revisions(tenant_id,revision) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,reviewed_by_user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE catering_catalogue_review_heads (
  tenant_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  review_revision bigint NOT NULL CHECK (review_revision BETWEEN 1 AND 9007199254740990),
  PRIMARY KEY (tenant_id,integration_id),
  FOREIGN KEY (tenant_id,integration_id,review_revision)
    REFERENCES catering_catalogue_reviews(tenant_id,integration_id,review_revision) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE catering_catalogue_publication_heads (
  tenant_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  publication_revision bigint NOT NULL CHECK (publication_revision BETWEEN 1 AND 9007199254740990),
  review_revision bigint NOT NULL CHECK (review_revision BETWEEN 1 AND 9007199254740990),
  PRIMARY KEY (tenant_id,integration_id),
  FOREIGN KEY (tenant_id,integration_id,review_revision,publication_revision)
    REFERENCES catering_catalogue_reviews(tenant_id,integration_id,review_revision,publication_revision) DEFERRABLE INITIALLY DEFERRED
);
CREATE FUNCTION guard_catering_catalogue_review()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE increment integer; current_review bigint; current_publication bigint; actual_catalogue bigint; actual_assignment bigint;
BEGIN
  SELECT catalog_revision INTO actual_catalogue FROM public.tenants WHERE id=NEW.tenant_id AND status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CATERING_CATALOGUE_REVIEW_TENANT_UNAVAILABLE' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public.users WHERE tenant_id=NEW.tenant_id AND id=NEW.reviewed_by_user_id
    AND active=true AND security_version=NEW.actor_security_version FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CATERING_CATALOGUE_REVIEW_ACTOR_UNAVAILABLE' USING ERRCODE='23514'; END IF;
  IF NOT public.catering_catalogue_review_command_valid(NEW.command) THEN
    RAISE EXCEPTION 'CATERING_CATALOGUE_REVIEW_COMMAND_INVALID' USING ERRCODE='23514'; END IF;
  increment:=CASE WHEN NEW.command->>'decision'='published' THEN 1 ELSE 0 END;
  PERFORM 1 FROM public.catering_integration_configurations configuration
    JOIN public.integrations integration ON integration.tenant_id=configuration.tenant_id AND integration.id=configuration.integration_id
    JOIN public.catering_provider_catalogue_revisions source ON source.tenant_id=integration.tenant_id
      AND source.integration_id=integration.id AND source.revision=NEW.source_revision AND source.provider_id=integration.provider
    JOIN public.catering_provider_catalogue_heads head ON head.tenant_id=source.tenant_id
      AND head.integration_id=source.integration_id AND head.revision=source.revision
    WHERE configuration.tenant_id=NEW.tenant_id AND configuration.integration_id=NEW.integration_id
      AND configuration.revision=NEW.configuration_revision AND configuration.catalogue_mode<>'unsupported'
      AND integration.status IN ('configured','active') FOR SHARE OF configuration,integration,head;
  IF NOT FOUND THEN RAISE EXCEPTION 'CATERING_CATALOGUE_REVIEW_SOURCE_UNAVAILABLE' USING ERRCODE='23514'; END IF;
  SELECT review_revision INTO current_review FROM public.catering_catalogue_review_heads
    WHERE tenant_id=NEW.tenant_id AND integration_id=NEW.integration_id FOR UPDATE;
  SELECT publication_revision INTO current_publication FROM public.catering_catalogue_publication_heads
    WHERE tenant_id=NEW.tenant_id AND integration_id=NEW.integration_id FOR UPDATE;
  SELECT revision INTO actual_assignment FROM public.catering_catalogue_assignment_heads WHERE tenant_id=NEW.tenant_id FOR UPDATE;
  IF NEW.command_id::text<>NEW.command->>'commandId'
    OR NEW.review_revision<>coalesce(current_review,0)+1
    OR (NEW.command->>'expectedReviewRevision')::bigint<>coalesce(current_review,0)
    OR (NEW.command->>'expectedPublicationRevision')::bigint<>coalesce(current_publication,0)
    OR NEW.source_revision<>(NEW.command->>'expectedSourceRevision')::bigint
    OR NEW.configuration_revision<>(NEW.command->>'expectedConfigurationRevision')::bigint
    OR NEW.publication_revision<>coalesce(current_publication,0)+increment
    OR NEW.catalogue_revision<>(NEW.command->>'expectedCatalogueRevision')::bigint+increment
    OR NEW.assignment_revision<>(NEW.command->>'expectedAssignmentRevision')::bigint+increment
    OR NEW.catalogue_revision<>actual_catalogue OR NEW.assignment_revision<>coalesce(actual_assignment,0)
    OR (increment=0 AND NEW.bindings<>'[]'::jsonb) THEN
    RAISE EXCEPTION 'CATERING_CATALOGUE_REVIEW_REVISION_INVALID' USING ERRCODE='23514'; END IF;
  IF (NEW.command->>'expectedAssignmentRevision')::bigint=0 AND EXISTS (
    SELECT 1 FROM public.tenant_catalogue_revisions catalogue WHERE catalogue.tenant_id=NEW.tenant_id
      AND catalogue.revision=(NEW.command->>'expectedCatalogueRevision')::bigint
      AND (jsonb_array_length(catalogue.snapshot->'cateringItems')<>0 OR jsonb_array_length(catalogue.snapshot->'cateringPackages')<>0)
  ) THEN RAISE EXCEPTION 'CATERING_CATALOGUE_REVIEW_ASSIGNMENT_REQUIRED' USING ERRCODE='23514'; END IF;
  NEW.recorded_at:=clock_timestamp(); RETURN NEW;
END $$;
CREATE FUNCTION guard_catering_catalogue_review_head()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE next_revision bigint; previous_revision bigint;
BEGIN
  IF TG_TABLE_NAME='catering_catalogue_review_heads' THEN
    next_revision:=NEW.review_revision;
    IF TG_OP='UPDATE' THEN previous_revision:=OLD.review_revision; ELSE previous_revision:=0; END IF;
  ELSE
    next_revision:=NEW.publication_revision;
    IF TG_OP='UPDATE' THEN
      previous_revision:=OLD.publication_revision;
      IF NEW.review_revision<=OLD.review_revision THEN
        RAISE EXCEPTION 'CATERING_CATALOGUE_PUBLICATION_REVIEW_INVALID' USING ERRCODE='23514'; END IF;
    ELSE previous_revision:=0; END IF;
  END IF;
  IF next_revision<>previous_revision+1 OR (TG_OP='UPDATE'
    AND (NEW.tenant_id,NEW.integration_id) IS DISTINCT FROM (OLD.tenant_id,OLD.integration_id)) THEN
    RAISE EXCEPTION 'CATERING_CATALOGUE_REVIEW_HEAD_INVALID' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION verify_catering_catalogue_review()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
  source jsonb; previous_catalogue jsonb; next_catalogue jsonb; expected_bindings jsonb; retained_bindings jsonb;
  collection text; source_collection text; review_kind text; selected jsonb; product jsonb; expected_entry jsonb; actual_entry jsonb;
  old_entry jsonb; old_variant jsonb; variant jsonb; variant_product jsonb; expected_variants jsonb; expected_ids jsonb;
  component text; mapping jsonb; owner uuid; field text; expected_count integer; catalogue_summary jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.catering_catalogue_review_heads WHERE tenant_id=NEW.tenant_id
    AND integration_id=NEW.integration_id AND review_revision=NEW.review_revision)
    OR NOT EXISTS (SELECT 1 FROM public.audit_events WHERE tenant_id=NEW.tenant_id AND actor_user_id=NEW.reviewed_by_user_id
      AND correlation_id=NEW.correlation_id AND action='catering.catalogue.'||(NEW.command->>'decision')
      AND target_type='integration' AND target_id=NEW.integration_id::text AND outcome='success' AND retention_class='business'
      AND previous_state=jsonb_build_object('revision',NEW.review_revision-1)
      AND new_state=jsonb_build_object('revision',NEW.review_revision)
      AND metadata=jsonb_build_object('assignmentRevision',NEW.assignment_revision,'catalogueRevision',NEW.catalogue_revision,
        'decision',NEW.command->>'decision','operation','catering_catalogue_review','publicationRevision',NEW.publication_revision,
        'sourceRevision',NEW.source_revision)) THEN
    RAISE EXCEPTION 'CATERING_CATALOGUE_REVIEW_COMPLETION_REQUIRED' USING ERRCODE='23514'; END IF;
  IF NEW.command->>'decision'='rejected' THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.catering_catalogue_publication_heads WHERE tenant_id=NEW.tenant_id
    AND integration_id=NEW.integration_id AND review_revision=NEW.review_revision AND publication_revision=NEW.publication_revision)
    THEN RAISE EXCEPTION 'CATERING_CATALOGUE_PUBLICATION_HEAD_REQUIRED' USING ERRCODE='23514'; END IF;
  SELECT snapshot INTO STRICT previous_catalogue FROM public.tenant_catalogue_revisions
    WHERE tenant_id=NEW.tenant_id AND revision=NEW.catalogue_revision-1;
  SELECT snapshot INTO STRICT next_catalogue FROM public.tenant_catalogue_revisions
    WHERE tenant_id=NEW.tenant_id AND revision=NEW.catalogue_revision;
  SELECT s.source INTO STRICT source FROM public.catering_provider_catalogue_revisions s
    WHERE s.tenant_id=NEW.tenant_id AND s.integration_id=NEW.integration_id AND s.revision=NEW.source_revision;
  SELECT review.bindings INTO retained_bindings FROM public.catering_catalogue_reviews review
    WHERE review.tenant_id=NEW.tenant_id AND review.integration_id=NEW.integration_id
      AND review.publication_revision=NEW.publication_revision-1 AND review.command->>'decision'='published';
  retained_bindings:=coalesce(retained_bindings,'[]'::jsonb);
  IF next_catalogue->'services' IS DISTINCT FROM previous_catalogue->'services'
    OR next_catalogue->'equipment' IS DISTINCT FROM previous_catalogue->'equipment'
    OR next_catalogue->'roomPrices' IS DISTINCT FROM previous_catalogue->'roomPrices' THEN
    RAISE EXCEPTION 'CATERING_CATALOGUE_UNRELATED_CHANGE' USING ERRCODE='23514'; END IF;
  SELECT coalesce(jsonb_agg(binding ORDER BY binding->>'kind' COLLATE "C",binding->>'entryId' COLLATE "C"),'[]'::jsonb)
    INTO expected_bindings FROM (
      SELECT jsonb_build_object('kind','item','entryId',x->>'entryId','sourceId',x->>'sourceId','variants','[]'::jsonb) binding
        FROM jsonb_array_elements(NEW.command->'items') x
      UNION ALL SELECT jsonb_build_object('kind','package','entryId',x->>'entryId','sourceId',x->>'sourceId','variants',
        coalesce((SELECT jsonb_agg(jsonb_build_object('entryId',v->>'entryId','sourceId',v->>'sourceId')
          ORDER BY v->>'sourceId' COLLATE "C") FROM jsonb_array_elements(x->'variants') v),'[]'::jsonb))
        FROM jsonb_array_elements(NEW.command->'packages') x
    ) entries;
  IF NEW.bindings IS DISTINCT FROM expected_bindings THEN
    RAISE EXCEPTION 'CATERING_CATALOGUE_BINDING_INVALID' USING ERRCODE='23514'; END IF;
  FOREACH source_collection IN ARRAY ARRAY['items','packages'] LOOP
    review_kind:=CASE WHEN source_collection='items' THEN 'item' ELSE 'package' END;
    collection:=CASE WHEN review_kind='item' THEN 'cateringItems' ELSE 'cateringPackages' END;
    expected_count:=jsonb_array_length(previous_catalogue->collection);
    FOR selected IN SELECT x FROM jsonb_array_elements(NEW.command->source_collection) x LOOP
      SELECT x INTO product FROM jsonb_array_elements(source->source_collection) x WHERE x->>'id'=selected->>'sourceId';
      IF NOT FOUND THEN RAISE EXCEPTION 'CATERING_CATALOGUE_SOURCE_ENTRY_UNKNOWN' USING ERRCODE='23514'; END IF;
      SELECT integration_id INTO owner FROM public.catering_catalogue_assignment_entries
        WHERE tenant_id=NEW.tenant_id AND revision=(NEW.command->>'expectedAssignmentRevision')::bigint
          AND catering_catalogue_assignment_entries.kind=review_kind AND catering_catalogue_assignment_entries.entry_id=selected->>'entryId';
      IF owner IS NOT NULL AND owner<>NEW.integration_id THEN
        RAISE EXCEPTION 'CATERING_CATALOGUE_OWNER_CONFLICT' USING ERRCODE='23514'; END IF;
      SELECT x INTO old_entry FROM jsonb_array_elements(previous_catalogue->collection) x WHERE x->>'id'=selected->>'entryId';
      IF NOT FOUND THEN expected_count:=expected_count+1; END IF;
      expected_entry:=jsonb_build_object('id',selected->>'entryId','name',product->'name','description',product->'description',
        'price',selected->'price','active',selected->'active','order',selected->'order','siteIds',selected->'siteIds','roomIds',selected->'roomIds');
      IF review_kind='package' THEN
        expected_ids:='[]'::jsonb; expected_variants:='[]'::jsonb;
        FOR component IN SELECT x FROM jsonb_array_elements_text(product->'itemIds') x LOOP
          SELECT x INTO mapping FROM jsonb_array_elements(NEW.command->'items') x WHERE x->>'sourceId'=component;
          IF NOT FOUND THEN RAISE EXCEPTION 'CATERING_CATALOGUE_COMPONENT_UNREVIEWED' USING ERRCODE='23514'; END IF;
          expected_ids:=expected_ids||jsonb_build_array(mapping->'entryId');
        END LOOP;
        FOR variant IN SELECT x FROM jsonb_array_elements(selected->'variants') x LOOP
          SELECT x INTO variant_product FROM jsonb_array_elements(product->'variants') x WHERE x->>'id'=variant->>'sourceId';
          IF NOT FOUND THEN RAISE EXCEPTION 'CATERING_CATALOGUE_VARIANT_UNKNOWN' USING ERRCODE='23514'; END IF;
          expected_variants:=expected_variants||jsonb_build_array(jsonb_build_object('id',variant->>'entryId',
            'name',variant_product->'name','description',variant_product->'description','price',variant->'price',
            'active',variant->'active','order',variant->'order'));
        END LOOP;
        FOR old_variant IN SELECT x FROM jsonb_array_elements(coalesce(old_entry->'variants','[]'::jsonb)) x LOOP
          IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(selected->'variants') x WHERE x->>'entryId'=old_variant->>'id') THEN
            expected_variants:=expected_variants||jsonb_build_array(old_variant||jsonb_build_object('active',false));
          END IF;
        END LOOP;
        SELECT coalesce(jsonb_agg(x ORDER BY x->>'id' COLLATE "C"),'[]'::jsonb) INTO expected_variants
          FROM jsonb_array_elements(expected_variants) x;
        SELECT coalesce(jsonb_agg(x ORDER BY x#>>'{}' COLLATE "C"),'[]'::jsonb) INTO expected_ids
          FROM jsonb_array_elements(expected_ids) x;
        expected_entry:=expected_entry||jsonb_build_object('variants',expected_variants,'itemIds',expected_ids);
      END IF;
      SELECT x INTO actual_entry FROM jsonb_array_elements(next_catalogue->collection) x WHERE x->>'id'=selected->>'entryId';
      IF review_kind='package' AND actual_entry IS NOT NULL THEN
        actual_entry:=actual_entry||jsonb_build_object('variants',(SELECT coalesce(jsonb_agg(x ORDER BY x->>'id' COLLATE "C"),'[]'::jsonb)
          FROM jsonb_array_elements(actual_entry->'variants') x));
      END IF;
      IF actual_entry IS DISTINCT FROM expected_entry THEN
        RAISE EXCEPTION 'CATERING_CATALOGUE_REVIEWED_CONTENT_MISMATCH' USING ERRCODE='23514'; END IF;
      IF NOT EXISTS (SELECT 1 FROM public.catering_catalogue_assignment_entries a WHERE a.tenant_id=NEW.tenant_id
        AND a.revision=NEW.assignment_revision AND a.kind=review_kind AND a.entry_id=selected->>'entryId' AND a.integration_id=NEW.integration_id)
        THEN RAISE EXCEPTION 'CATERING_CATALOGUE_REVIEWED_OWNER_MISMATCH' USING ERRCODE='23514'; END IF;
    END LOOP;
    IF jsonb_array_length(next_catalogue->collection)<>expected_count THEN
      RAISE EXCEPTION 'CATERING_CATALOGUE_UNREVIEWED_ENTRY' USING ERRCODE='23514'; END IF;
    FOR old_entry IN SELECT x FROM jsonb_array_elements(previous_catalogue->collection) x LOOP
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.command->source_collection) x WHERE x->>'entryId'=old_entry->>'id') THEN CONTINUE; END IF;
      expected_entry:=old_entry;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(retained_bindings) x WHERE x->>'kind'=review_kind AND x->>'entryId'=old_entry->>'id')
        AND EXISTS (SELECT 1 FROM public.catering_catalogue_assignment_entries a WHERE a.tenant_id=NEW.tenant_id
          AND a.revision=(NEW.command->>'expectedAssignmentRevision')::bigint AND a.kind=review_kind AND a.entry_id=old_entry->>'id'
          AND a.integration_id=NEW.integration_id) THEN
        expected_entry:=expected_entry||jsonb_build_object('active',false);
        IF review_kind='package' THEN
          expected_entry:=expected_entry||jsonb_build_object('variants',(SELECT coalesce(jsonb_agg(x||jsonb_build_object('active',false)
            ORDER BY (x->>'order')::integer,x->>'id'),'[]'::jsonb) FROM jsonb_array_elements(old_entry->'variants') x));
        END IF;
      END IF;
      SELECT x INTO actual_entry FROM jsonb_array_elements(next_catalogue->collection) x WHERE x->>'id'=old_entry->>'id';
      IF review_kind='package' THEN
        expected_entry:=expected_entry||jsonb_build_object('variants',(SELECT coalesce(jsonb_agg(x ORDER BY x->>'id' COLLATE "C"),'[]'::jsonb)
          FROM jsonb_array_elements(expected_entry->'variants') x));
        actual_entry:=actual_entry||jsonb_build_object('variants',(SELECT coalesce(jsonb_agg(x ORDER BY x->>'id' COLLATE "C"),'[]'::jsonb)
          FROM jsonb_array_elements(actual_entry->'variants') x));
      END IF;
      IF actual_entry IS DISTINCT FROM expected_entry THEN
        RAISE EXCEPTION 'CATERING_CATALOGUE_UNRELATED_ENTRY_CHANGED' USING ERRCODE='23514'; END IF;
    END LOOP;
  END LOOP;
  -- Existing ownership may only change where this review explicitly maps a target.
  IF EXISTS (SELECT 1 FROM public.catering_catalogue_assignment_entries old_assignment
    LEFT JOIN public.catering_catalogue_assignment_entries next_assignment ON next_assignment.tenant_id=old_assignment.tenant_id
      AND next_assignment.revision=NEW.assignment_revision AND next_assignment.kind=old_assignment.kind
      AND next_assignment.entry_id=old_assignment.entry_id
    WHERE old_assignment.tenant_id=NEW.tenant_id AND old_assignment.revision=(NEW.command->>'expectedAssignmentRevision')::bigint
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.bindings) b
        WHERE b->>'kind'=old_assignment.kind AND b->>'entryId'=old_assignment.entry_id)
      AND next_assignment.integration_id IS DISTINCT FROM old_assignment.integration_id) THEN
    RAISE EXCEPTION 'CATERING_CATALOGUE_UNRELATED_OWNER_CHANGED' USING ERRCODE='23514'; END IF;
  catalogue_summary:=jsonb_build_object(
    'operation','catering_catalogue_publication',
    'roomPriceCount',jsonb_array_length(next_catalogue->'roomPrices'),
    'serviceCount',jsonb_array_length(next_catalogue->'services'),
    'activeServiceCount',(SELECT count(*) FROM jsonb_array_elements(next_catalogue->'services') x WHERE x->'active'='true'::jsonb),
    'equipmentCount',jsonb_array_length(next_catalogue->'equipment'),
    'activeEquipmentCount',(SELECT count(*) FROM jsonb_array_elements(next_catalogue->'equipment') x WHERE x->'active'='true'::jsonb),
    'packageCount',jsonb_array_length(next_catalogue->'cateringPackages'),
    'activePackageCount',(SELECT count(*) FROM jsonb_array_elements(next_catalogue->'cateringPackages') x WHERE x->'active'='true'::jsonb),
    'cateringItemCount',jsonb_array_length(next_catalogue->'cateringItems'),
    'activeCateringItemCount',(SELECT count(*) FROM jsonb_array_elements(next_catalogue->'cateringItems') x WHERE x->'active'='true'::jsonb));
  FOREACH field IN ARRAY ARRAY['catalogue','assignment'] LOOP
    IF NOT EXISTS (SELECT 1 FROM public.audit_events WHERE tenant_id=NEW.tenant_id AND actor_user_id=NEW.reviewed_by_user_id
      AND correlation_id=NEW.correlation_id AND action='tenant.configuration.changed' AND outcome='success' AND retention_class='administrative'
      AND ((field='catalogue' AND target_type='catalogue' AND target_id='tenant-catalogue'
        AND previous_state=jsonb_build_object('revision',NEW.catalogue_revision-1)
        AND new_state=jsonb_build_object('revision',NEW.catalogue_revision) AND metadata=catalogue_summary)
      OR (field='assignment' AND target_type='tenant_configuration' AND target_id='catering_catalogue_assignments'
        AND previous_state=jsonb_build_object('revision',NEW.assignment_revision-1)
        AND new_state=jsonb_build_object('revision',NEW.assignment_revision,'catalogueRevision',NEW.catalogue_revision)
        AND metadata=jsonb_build_object('operation','catering_catalogue_assignment_replace')))) THEN
      RAISE EXCEPTION 'CATERING_CATALOGUE_PUBLICATION_AUDIT_REQUIRED' USING ERRCODE='23514'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER catering_catalogue_review_guard BEFORE INSERT ON catering_catalogue_reviews
  FOR EACH ROW EXECUTE FUNCTION guard_catering_catalogue_review();
CREATE TRIGGER catering_catalogue_review_immutable BEFORE UPDATE OR DELETE ON catering_catalogue_reviews
  FOR EACH ROW EXECUTE FUNCTION reject_catering_order_history_mutation();
CREATE CONSTRAINT TRIGGER catering_catalogue_review_complete AFTER INSERT ON catering_catalogue_reviews
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION verify_catering_catalogue_review();
CREATE TRIGGER catering_catalogue_review_head_guard BEFORE INSERT OR UPDATE ON catering_catalogue_review_heads
  FOR EACH ROW EXECUTE FUNCTION guard_catering_catalogue_review_head();
CREATE TRIGGER catering_catalogue_review_head_immutable BEFORE DELETE ON catering_catalogue_review_heads
  FOR EACH ROW EXECUTE FUNCTION reject_catering_order_history_mutation();
CREATE TRIGGER catering_catalogue_publication_head_guard BEFORE INSERT OR UPDATE ON catering_catalogue_publication_heads
  FOR EACH ROW EXECUTE FUNCTION guard_catering_catalogue_review_head();
CREATE TRIGGER catering_catalogue_publication_head_immutable BEFORE DELETE ON catering_catalogue_publication_heads
  FOR EACH ROW EXECUTE FUNCTION reject_catering_order_history_mutation();
REVOKE ALL ON TABLE catering_catalogue_reviews,catering_catalogue_review_heads,catering_catalogue_publication_heads FROM PUBLIC;
REVOKE ALL ON FUNCTION catering_catalogue_review_mapping_valid(jsonb,boolean,boolean),catering_catalogue_review_command_valid(jsonb),
  guard_catering_catalogue_review(),guard_catering_catalogue_review_head(),verify_catering_catalogue_review() FROM PUBLIC;

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_valid;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_valid CHECK (action IN (
  'session.issued','session.revoked','session.rotated',
  'authentication.failed','authorization.denied','request.started',
  'request.abandoned','request.created','request.transition',
  'request.transition_failed','request.booking_change','tenant.configuration.changed',
  'tenant.user_permissions.changed','tenant.entitlement.changed','tenant.lifecycle.changed',
  'tenant.onboarding.invited','tenant.identity.claimed','tenant.identity.unbound',
  'tenant.user.provisioned','tenant.user.profile_updated','integration.connected',
  'integration.disconnected','integration.admin_consent.changed','integration.verified',
  'calendar.operation','catering.catalogue.received','catering.catalogue.published','catering.catalogue.rejected','catering.order.prepared',
  'catering.order.quoted','catering.order.decided','catering.delivery.queued',
  'catering.delivery.claimed','catering.delivery.attempted','catering.delivery.observed',
  'catering.delivery.deferred','catering.delivery.recovered','catering.order.version_proposed',
  'catering.order.withdrawn','catering.order.unsent_replaced','catering.manual.transmitted',
  'catering.manual.receipt','audit.read'
));
