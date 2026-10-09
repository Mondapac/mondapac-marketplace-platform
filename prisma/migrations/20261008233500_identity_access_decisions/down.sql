-- Reverses 20261008233500_identity_access_decisions (docs/design/data/identity.md 8.2): the
-- grant first, then the table. CHECKs, the index and the foreign key go with the table. No
-- existing table was changed, so nothing else is undone.
REVOKE SELECT, INSERT ON TABLE "identity"."access_decisions" FROM "mondapac_app";
DROP TABLE "identity"."access_decisions";
