-- Reverses 20261025090000_ordering_offer_pairs: the grant first, then the table. The pairs are a
-- derived table that the nightly job rebuilds, so nothing is lost for good.
SET lock_timeout = '5s';

REVOKE SELECT, INSERT, DELETE ON TABLE "ordering"."offer_pairs" FROM "mondapac_app";

DROP TABLE "ordering"."offer_pairs";
