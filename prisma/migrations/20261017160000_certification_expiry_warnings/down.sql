-- Reverses 20261017160000_certification_expiry_warnings: the grant, the triggers, then the table.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT ON TABLE "certification"."expiry_warnings" FROM "mondapac_app";

DROP TRIGGER "expiry_warnings_no_truncate" ON "certification"."expiry_warnings";
DROP TRIGGER "expiry_warnings_no_update_delete" ON "certification"."expiry_warnings";

DROP TABLE "certification"."expiry_warnings";
