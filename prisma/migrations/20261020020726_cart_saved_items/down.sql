-- Reverses 20261020020726_cart_saved_items: the grant first, then the table (its indexes and
-- CHECKs go with it).
REVOKE SELECT, INSERT, UPDATE ("saved_at"), DELETE ON TABLE "cart"."saved_items" FROM "mondapac_app";

DROP TABLE "cart"."saved_items";
