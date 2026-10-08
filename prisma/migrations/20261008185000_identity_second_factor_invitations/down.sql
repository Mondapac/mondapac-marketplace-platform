-- Reverses 20261008185000_identity_second_factor_invitations (docs/design/data/identity.md 8.2):
-- the grants first, in reverse order; then the tables, children before parents. CHECKs, indexes
-- (the partial ones included) and the foreign keys go with their tables. No existing table was
-- changed, so nothing else is undone.
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."invitations" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."sign_in_challenges" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."recovery_codes" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."second_factors" FROM "mondapac_app";
DROP TABLE "identity"."invitations";
DROP TABLE "identity"."sign_in_challenges";
DROP TABLE "identity"."recovery_codes";
DROP TABLE "identity"."second_factors";
