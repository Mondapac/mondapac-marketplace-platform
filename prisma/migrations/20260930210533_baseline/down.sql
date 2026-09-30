DROP TRIGGER "audit_log_no_truncate" ON "platform"."audit_log";
DROP TRIGGER "audit_log_no_update_delete" ON "platform"."audit_log";
DROP TABLE "platform"."audit_log";
DROP FUNCTION "platform"."audit_log_reject_mutation"();
