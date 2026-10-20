-- Reverses 20261019233445_identity_external_identities: the grant first, then the table.
REVOKE SELECT, INSERT ON TABLE "identity"."external_identities" FROM "mondapac_app";

DROP TABLE "identity"."external_identities";
