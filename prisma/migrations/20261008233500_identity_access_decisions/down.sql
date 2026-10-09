-- Reverses 20261008233500_identity_access_decisions (docs/design/data/identity.md 8.2): the
-- partial index on invitations first, then the grant, then the table. CHECKs, the table's
-- indexes and the foreign key go with the table. No column of an existing table was changed.
DROP INDEX "identity"."invitations_market_id_email_seller_owner_pending_key";
REVOKE SELECT, INSERT ON TABLE "identity"."access_decisions" FROM "mondapac_app";
DROP TABLE "identity"."access_decisions";
