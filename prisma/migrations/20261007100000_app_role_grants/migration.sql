-- Grants (database-designer): docs/design/data/platform.md section 10.
-- The group role "mondapac_app" is created by the cluster bootstrap, never by a migration
-- (10.1); without it this migration fails with 42704, on purpose (10.3).
GRANT USAGE ON SCHEMA "platform" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "platform"."audit_log" TO "mondapac_app";
