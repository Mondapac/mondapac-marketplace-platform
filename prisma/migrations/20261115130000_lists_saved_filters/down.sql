-- Reverses 20261115130000_lists_saved_filters. The old catalog and ordering tables still hold the
-- filters as they were at the copy, so a rollback loses only the filters saved after it (a
-- development rollback).
SET lock_timeout = '5s';

REVOKE SELECT, INSERT, UPDATE ("visibility", "name", "updated_at"), DELETE
  ON TABLE "lists"."saved_filters" FROM "mondapac_app";
DROP TABLE "lists"."saved_filters";
REVOKE USAGE ON SCHEMA "lists" FROM "mondapac_app";
DROP SCHEMA "lists";
