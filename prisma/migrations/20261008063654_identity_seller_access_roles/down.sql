-- Reverses 20261008063654_identity_seller_access_roles (docs/design/data/identity.md 8.2): the
-- grants first, in reverse order; then the foreign key on sessions, the one change to an
-- existing table; then the tables, children before parents. CHECKs, indexes (the partial ones
-- included) and the foreign keys of the new tables go with their tables.
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."role_assignments" FROM "mondapac_app";
REVOKE SELECT, INSERT, DELETE ON TABLE "identity"."role_permissions" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."roles" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."seller_memberships" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."seller_access" FROM "mondapac_app";
ALTER TABLE "identity"."sessions" DROP CONSTRAINT "sessions_market_id_seller_id_fkey";
DROP TABLE "identity"."role_assignments";
DROP TABLE "identity"."role_permissions";
DROP TABLE "identity"."roles";
DROP TABLE "identity"."seller_memberships";
DROP TABLE "identity"."seller_access";
