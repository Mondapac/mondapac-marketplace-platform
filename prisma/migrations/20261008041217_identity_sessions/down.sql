-- Reverses 20261008041217_identity_sessions (docs/design/data/identity.md 8.2): the grants
-- first, in reverse order, then the tables. CHECKs, indexes (the partial one included) and the
-- foreign key to accounts go with their tables.
REVOKE SELECT, INSERT, DELETE ON TABLE "identity"."sign_in_records" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."sign_in_throttles" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."sessions" FROM "mondapac_app";
DROP TABLE "identity"."sign_in_records";
DROP TABLE "identity"."sign_in_throttles";
DROP TABLE "identity"."sessions";
