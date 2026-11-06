-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';
-- ADR-0045 decision 1: an authenticated agent is audited as actor type AGENT, with its account id.
-- Hand-written; no Prisma model changes (the columns are TEXT). Each swap adds the new CHECK
-- NOT VALID, validates it, then drops the old one. Prisma runs this file in one transaction, so
-- each table's ACCESS EXCLUSIVE lock is held through its VALIDATE: fine while these tables are
-- small; a live database would need the VALIDATE statements in a separate migration.
ALTER TABLE "platform"."audit_log"
  ADD CONSTRAINT "audit_log_actor_type_check_v2" CHECK ("actor_type" IN ('USER', 'SYSTEM', 'ANONYMOUS', 'AGENT')) NOT VALID,
  ADD CONSTRAINT "audit_log_actor_check_v2" CHECK (("actor_type" IN ('USER', 'AGENT')) = ("actor_id" IS NOT NULL)) NOT VALID;
ALTER TABLE "platform"."audit_log" VALIDATE CONSTRAINT "audit_log_actor_type_check_v2";
ALTER TABLE "platform"."audit_log" VALIDATE CONSTRAINT "audit_log_actor_check_v2";
ALTER TABLE "platform"."audit_log"
  DROP CONSTRAINT "audit_log_actor_type_check",
  DROP CONSTRAINT "audit_log_actor_check";
ALTER TABLE "platform"."audit_log" RENAME CONSTRAINT "audit_log_actor_type_check_v2" TO "audit_log_actor_type_check";
ALTER TABLE "platform"."audit_log" RENAME CONSTRAINT "audit_log_actor_check_v2" TO "audit_log_actor_check";

ALTER TABLE "platform"."security_events"
  ADD CONSTRAINT "security_events_actor_type_check_v2" CHECK ("actor_type" IN ('USER', 'SYSTEM', 'ANONYMOUS', 'AGENT')) NOT VALID,
  ADD CONSTRAINT "security_events_actor_check_v2" CHECK (("actor_type" IN ('USER', 'AGENT')) = ("actor_id" IS NOT NULL)) NOT VALID;
ALTER TABLE "platform"."security_events" VALIDATE CONSTRAINT "security_events_actor_type_check_v2";
ALTER TABLE "platform"."security_events" VALIDATE CONSTRAINT "security_events_actor_check_v2";
ALTER TABLE "platform"."security_events"
  DROP CONSTRAINT "security_events_actor_type_check",
  DROP CONSTRAINT "security_events_actor_check";
ALTER TABLE "platform"."security_events" RENAME CONSTRAINT "security_events_actor_type_check_v2" TO "security_events_actor_type_check";
ALTER TABLE "platform"."security_events" RENAME CONSTRAINT "security_events_actor_check_v2" TO "security_events_actor_check";

ALTER TABLE "platform"."security_events_archive"
  ADD CONSTRAINT "security_events_archive_actor_type_check_v2" CHECK ("actor_type" IN ('USER', 'SYSTEM', 'ANONYMOUS', 'AGENT')) NOT VALID,
  ADD CONSTRAINT "security_events_archive_actor_check_v2" CHECK (("actor_type" IN ('USER', 'AGENT')) = ("actor_id" IS NOT NULL)) NOT VALID;
ALTER TABLE "platform"."security_events_archive" VALIDATE CONSTRAINT "security_events_archive_actor_type_check_v2";
ALTER TABLE "platform"."security_events_archive" VALIDATE CONSTRAINT "security_events_archive_actor_check_v2";
ALTER TABLE "platform"."security_events_archive"
  DROP CONSTRAINT "security_events_archive_actor_type_check",
  DROP CONSTRAINT "security_events_archive_actor_check";
ALTER TABLE "platform"."security_events_archive" RENAME CONSTRAINT "security_events_archive_actor_type_check_v2" TO "security_events_archive_actor_type_check";
ALTER TABLE "platform"."security_events_archive" RENAME CONSTRAINT "security_events_archive_actor_check_v2" TO "security_events_archive_actor_check";
