SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Reverses 20261112200000_catalog_missing_details_emails. The queued and sent "Email sellers"
-- emails are lost (the audit rows of the requests stay); nothing else refers to them.
REVOKE SELECT, INSERT ON TABLE "catalog"."missing_details_email_products" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("notice_state","notice_attempts","notice_next_attempt_at","sent_at","version") ON TABLE "catalog"."missing_details_emails" FROM "mondapac_app";
DROP TRIGGER "missing_details_email_products_no_truncate" ON "catalog"."missing_details_email_products";
DROP TRIGGER "missing_details_email_products_append_only" ON "catalog"."missing_details_email_products";
DROP TRIGGER "missing_details_emails_no_truncate" ON "catalog"."missing_details_emails";
DROP TRIGGER "missing_details_emails_guard" ON "catalog"."missing_details_emails";
DROP FUNCTION "catalog"."missing_details_emails_guard"();
DROP TABLE "catalog"."missing_details_email_products";
DROP TABLE "catalog"."missing_details_emails";
