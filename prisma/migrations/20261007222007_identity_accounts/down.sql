-- Reverses 20261007222007_identity_accounts (docs/design/data/identity.md 8.2): the grants
-- first, in reverse order, then the child table before its parent. CHECKs and the partial
-- index go with their tables.
REVOKE SELECT, INSERT, UPDATE ON TABLE "identity"."password_credentials" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."accounts" FROM "mondapac_app";
DROP TABLE "identity"."password_credentials";
DROP TABLE "identity"."accounts";
