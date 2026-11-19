-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261105200000_catalog_tag_request_reopen. The application can no longer reopen a
-- request; nothing stored changes.
REVOKE UPDATE ("created_at") ON TABLE "catalog"."tag_reevaluation_requests" FROM "mondapac_app";
