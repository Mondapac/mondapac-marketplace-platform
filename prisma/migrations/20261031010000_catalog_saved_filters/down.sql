-- Reverses 20261031010000_catalog_saved_filters (docs/design/data/catalog.md 8.3). The saved
-- filters go with the table; a development rollback.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT, UPDATE ("visibility", "name", "updated_at"), DELETE
  ON TABLE "catalog"."saved_filters" FROM "mondapac_app";
DROP TABLE "catalog"."saved_filters";
