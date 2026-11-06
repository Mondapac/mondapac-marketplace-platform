-- Reverses 20261106130000_ordering_saved_filters. The saved filters go with the table; a
-- development rollback.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT, UPDATE ("visibility", "name", "updated_at"), DELETE
  ON TABLE "ordering"."saved_filters" FROM "mondapac_app";
DROP TABLE "ordering"."saved_filters";
