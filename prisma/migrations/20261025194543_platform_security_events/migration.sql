-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Security events (SOC package 1; docs/design/data/platform.md 13): one
-- insert-only table of recent events and its archive (SOC decision T6: 90 days hot, then 12
-- months in the archive). Written only through platform/persistence/audit/.

-- CreateTable
CREATE TABLE "platform"."security_events" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "target_type" TEXT,
    "target_id" TEXT,
    "ip" INET,
    "payload" JSONB NOT NULL,
    "correlation_id" TEXT NOT NULL,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."security_events_archive" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "target_type" TEXT,
    "target_id" TEXT,
    "ip" INET,
    "payload" JSONB NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "archived_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "security_events_archive_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "security_events_market_id_type_occurred_at_idx" ON "platform"."security_events"("market_id", "type", "occurred_at");

-- CreateIndex
CREATE INDEX "security_events_market_id_target_type_target_id_occurred_at_idx" ON "platform"."security_events"("market_id", "target_type", "target_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "security_events_market_id_occurred_at_id_key" ON "platform"."security_events"("market_id", "occurred_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "security_events_archive_market_id_occurred_at_id_key" ON "platform"."security_events_archive"("market_id", "occurred_at", "id");

-- Hand-written (database-designer): CHECKs. Codes and ids only; the payload is a small object.
ALTER TABLE "platform"."security_events"
  ADD CONSTRAINT "security_events_market_id_check" CHECK ("market_id" <> ''),
  ADD CONSTRAINT "security_events_tenant_id_check" CHECK ("tenant_id" <> ''),
  ADD CONSTRAINT "security_events_occurred_at_check" CHECK ("occurred_at" = date_trunc('milliseconds', "occurred_at", 'UTC')),
  ADD CONSTRAINT "security_events_type_check" CHECK ("type" ~ '^[a-z0-9]+([.-][a-z0-9]+)*$' AND char_length("type") <= 128),
  ADD CONSTRAINT "security_events_severity_check" CHECK ("severity" IN ('s1', 's2', 's3', 's4')),
  ADD CONSTRAINT "security_events_actor_type_check" CHECK ("actor_type" IN ('USER', 'SYSTEM', 'ANONYMOUS')),
  ADD CONSTRAINT "security_events_actor_check" CHECK (("actor_type" = 'USER') = ("actor_id" IS NOT NULL)),
  ADD CONSTRAINT "security_events_target_check" CHECK (("target_type" IS NULL) = ("target_id" IS NULL)),
  ADD CONSTRAINT "security_events_target_type_check" CHECK ("target_type" ~ '^[a-z0-9]+([.-][a-z0-9]+)*$' AND char_length("target_type") <= 128),
  ADD CONSTRAINT "security_events_target_id_check" CHECK (char_length("target_id") BETWEEN 1 AND 128),
  ADD CONSTRAINT "security_events_payload_check" CHECK (jsonb_typeof("payload") = 'object' AND octet_length("payload"::text) <= 4096),
  ADD CONSTRAINT "security_events_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$');

ALTER TABLE "platform"."security_events_archive"
  ADD CONSTRAINT "security_events_archive_market_id_check" CHECK ("market_id" <> ''),
  ADD CONSTRAINT "security_events_archive_tenant_id_check" CHECK ("tenant_id" <> ''),
  ADD CONSTRAINT "security_events_archive_occurred_at_check" CHECK ("occurred_at" = date_trunc('milliseconds', "occurred_at", 'UTC')),
  ADD CONSTRAINT "security_events_archive_type_check" CHECK ("type" ~ '^[a-z0-9]+([.-][a-z0-9]+)*$' AND char_length("type") <= 128),
  ADD CONSTRAINT "security_events_archive_severity_check" CHECK ("severity" IN ('s1', 's2', 's3', 's4')),
  ADD CONSTRAINT "security_events_archive_actor_type_check" CHECK ("actor_type" IN ('USER', 'SYSTEM', 'ANONYMOUS')),
  ADD CONSTRAINT "security_events_archive_actor_check" CHECK (("actor_type" = 'USER') = ("actor_id" IS NOT NULL)),
  ADD CONSTRAINT "security_events_archive_target_check" CHECK (("target_type" IS NULL) = ("target_id" IS NULL)),
  ADD CONSTRAINT "security_events_archive_target_type_check" CHECK ("target_type" ~ '^[a-z0-9]+([.-][a-z0-9]+)*$' AND char_length("target_type") <= 128),
  ADD CONSTRAINT "security_events_archive_target_id_check" CHECK (char_length("target_id") BETWEEN 1 AND 128),
  ADD CONSTRAINT "security_events_archive_payload_check" CHECK (jsonb_typeof("payload") = 'object' AND octet_length("payload"::text) <= 4096),
  ADD CONSTRAINT "security_events_archive_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$'),
  ADD CONSTRAINT "security_events_archive_archived_at_check" CHECK ("archived_at" >= "occurred_at");

-- Hand-written (database-designer): insert-only for every role, the owner included. UPDATE and
-- TRUNCATE are always rejected. DELETE is rejected for a row younger than its retention floor,
-- read from the database clock: 89 days in security_events (the job moves rows at 90 days; one
-- day of margin for clock skew between the API and the database) and 454 days in the
-- archive (the job deletes at 90 + 365 days after the event). A row of security_events may
-- be deleted only once an identical copy is in the archive, and an archive row may be inserted
-- only as an identical copy of a row of security_events (Hassan and Mojtaba on #514). So no
-- role can remove a recent event, drop an old one without archiving it, or plant a forged
-- archive copy: the retention job is the only deleter that can succeed.
CREATE FUNCTION "platform"."security_events_guard_mutation"() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- Nested, so OLD is read only for a row-level DELETE (it is NULL for TRUNCATE).
  IF TG_OP = 'DELETE' THEN
    IF OLD.occurred_at < now() - (TG_ARGV[0])::interval THEN
      IF TG_TABLE_NAME <> 'security_events' OR EXISTS (
        SELECT 1 FROM "platform"."security_events_archive" a
        WHERE a.id = OLD.id
          AND (a.market_id, a.tenant_id, a.occurred_at, a.type, a.severity, a.actor_type,
               a.actor_id, a.target_type, a.target_id, a.ip, a.payload, a.correlation_id)
              IS NOT DISTINCT FROM
              (OLD.market_id, OLD.tenant_id, OLD.occurred_at, OLD.type, OLD.severity,
               OLD.actor_type, OLD.actor_id, OLD.target_type, OLD.target_id, OLD.ip, OLD.payload,
               OLD.correlation_id)
      ) THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'platform.security_events: a row is deleted only after it is archived'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RAISE EXCEPTION '%.% is insert-only: % is not allowed', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- An archive row is an identical copy of a row of security_events. A row another run archived
-- already is skipped (the hot row is gone once that run commits), so concurrent runs stay safe.
CREATE FUNCTION "platform"."security_events_archive_guard_insert"() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "platform"."security_events" e
    WHERE e.id = NEW.id
      AND (e.market_id, e.tenant_id, e.occurred_at, e.type, e.severity, e.actor_type,
           e.actor_id, e.target_type, e.target_id, e.ip, e.payload, e.correlation_id)
          IS NOT DISTINCT FROM
          (NEW.market_id, NEW.tenant_id, NEW.occurred_at, NEW.type, NEW.severity,
           NEW.actor_type, NEW.actor_id, NEW.target_type, NEW.target_id, NEW.ip, NEW.payload,
           NEW.correlation_id)
  ) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM "platform"."security_events_archive" a WHERE a.id = NEW.id) THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'platform.security_events_archive: a row must copy a row of security_events'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "security_events_guard_update_delete"
  BEFORE UPDATE OR DELETE ON "platform"."security_events"
  FOR EACH ROW EXECUTE FUNCTION "platform"."security_events_guard_mutation"('89 days');

CREATE TRIGGER "security_events_no_truncate"
  BEFORE TRUNCATE ON "platform"."security_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "platform"."security_events_guard_mutation"('89 days');

CREATE TRIGGER "security_events_archive_guard_insert"
  BEFORE INSERT ON "platform"."security_events_archive"
  FOR EACH ROW EXECUTE FUNCTION "platform"."security_events_archive_guard_insert"();

CREATE TRIGGER "security_events_archive_guard_update_delete"
  BEFORE UPDATE OR DELETE ON "platform"."security_events_archive"
  FOR EACH ROW EXECUTE FUNCTION "platform"."security_events_guard_mutation"('454 days');

CREATE TRIGGER "security_events_archive_no_truncate"
  BEFORE TRUNCATE ON "platform"."security_events_archive"
  FOR EACH STATEMENT EXECUTE FUNCTION "platform"."security_events_guard_mutation"('454 days');

-- Grants (database-designer): docs/design/data/platform.md 13.4. The writer inserts; the
-- retention job reads, copies into the archive and deletes (only rows past the floor succeed).
GRANT SELECT, INSERT, DELETE ON TABLE "platform"."security_events" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "platform"."security_events_archive" TO "mondapac_app";
