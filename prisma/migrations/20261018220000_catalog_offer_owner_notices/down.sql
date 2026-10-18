-- Reverses 20261018220000_catalog_offer_owner_notices (docs/design/data/catalog.md 8.3). The
-- pending warnings go with the table; a development rollback.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT, UPDATE ("state", "outcome", "attempts", "next_attempt_at", "settled_at")
  ON TABLE "catalog"."offer_owner_notices" FROM "mondapac_app";
DROP TABLE "catalog"."offer_owner_notices";
