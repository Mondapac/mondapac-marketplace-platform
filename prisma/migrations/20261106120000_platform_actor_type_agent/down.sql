-- Reverse of migration.sql. It fails while any row with actor type AGENT exists (never deletes audit rows).
ALTER TABLE "platform"."audit_log"
  ADD CONSTRAINT "audit_log_actor_type_check_v1" CHECK ("actor_type" IN ('USER', 'SYSTEM', 'ANONYMOUS')) NOT VALID,
  ADD CONSTRAINT "audit_log_actor_check_v1" CHECK (("actor_type" = 'USER') = ("actor_id" IS NOT NULL)) NOT VALID;
ALTER TABLE "platform"."audit_log" VALIDATE CONSTRAINT "audit_log_actor_type_check_v1";
ALTER TABLE "platform"."audit_log" VALIDATE CONSTRAINT "audit_log_actor_check_v1";
ALTER TABLE "platform"."audit_log"
  DROP CONSTRAINT "audit_log_actor_type_check",
  DROP CONSTRAINT "audit_log_actor_check";
ALTER TABLE "platform"."audit_log" RENAME CONSTRAINT "audit_log_actor_type_check_v1" TO "audit_log_actor_type_check";
ALTER TABLE "platform"."audit_log" RENAME CONSTRAINT "audit_log_actor_check_v1" TO "audit_log_actor_check";

ALTER TABLE "platform"."security_events"
  ADD CONSTRAINT "security_events_actor_type_check_v1" CHECK ("actor_type" IN ('USER', 'SYSTEM', 'ANONYMOUS')) NOT VALID,
  ADD CONSTRAINT "security_events_actor_check_v1" CHECK (("actor_type" = 'USER') = ("actor_id" IS NOT NULL)) NOT VALID;
ALTER TABLE "platform"."security_events" VALIDATE CONSTRAINT "security_events_actor_type_check_v1";
ALTER TABLE "platform"."security_events" VALIDATE CONSTRAINT "security_events_actor_check_v1";
ALTER TABLE "platform"."security_events"
  DROP CONSTRAINT "security_events_actor_type_check",
  DROP CONSTRAINT "security_events_actor_check";
ALTER TABLE "platform"."security_events" RENAME CONSTRAINT "security_events_actor_type_check_v1" TO "security_events_actor_type_check";
ALTER TABLE "platform"."security_events" RENAME CONSTRAINT "security_events_actor_check_v1" TO "security_events_actor_check";

ALTER TABLE "platform"."security_events_archive"
  ADD CONSTRAINT "security_events_archive_actor_type_check_v1" CHECK ("actor_type" IN ('USER', 'SYSTEM', 'ANONYMOUS')) NOT VALID,
  ADD CONSTRAINT "security_events_archive_actor_check_v1" CHECK (("actor_type" = 'USER') = ("actor_id" IS NOT NULL)) NOT VALID;
ALTER TABLE "platform"."security_events_archive" VALIDATE CONSTRAINT "security_events_archive_actor_type_check_v1";
ALTER TABLE "platform"."security_events_archive" VALIDATE CONSTRAINT "security_events_archive_actor_check_v1";
ALTER TABLE "platform"."security_events_archive"
  DROP CONSTRAINT "security_events_archive_actor_type_check",
  DROP CONSTRAINT "security_events_archive_actor_check";
ALTER TABLE "platform"."security_events_archive" RENAME CONSTRAINT "security_events_archive_actor_type_check_v1" TO "security_events_archive_actor_type_check";
ALTER TABLE "platform"."security_events_archive" RENAME CONSTRAINT "security_events_archive_actor_check_v1" TO "security_events_archive_actor_check";

