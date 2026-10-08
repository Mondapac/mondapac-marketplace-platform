-- Reverses 20261008051735_identity_links_inbox (docs/design/data/identity.md 8.2): the grants
-- first, in reverse order, then the tables. CHECKs, indexes and the foreign key to accounts go
-- with their tables.
REVOKE SELECT, INSERT ON TABLE "identity"."inbox" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."one_time_links" FROM "mondapac_app";
DROP TABLE "identity"."inbox";
DROP TABLE "identity"."one_time_links";
