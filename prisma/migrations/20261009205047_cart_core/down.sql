-- Reverses 20261009205047_cart_core: the grants first, then the tables, children before parents.
-- Indexes and CHECKs go with their tables. The empty schema "cart" stays, without its USAGE
-- grant, as the leftover check of docs/design/data/platform.md 10.5 (guard 2) expects.
REVOKE SELECT, INSERT, UPDATE ("quantity", "price_at_add_amount", "price_at_add_currency", "added_at"), DELETE ON TABLE "cart"."cart_lines" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("account_id", "guest_token_hash", "status", "last_changed_at", "merged_into_cart_id", "merged_at", "version") ON TABLE "cart"."carts" FROM "mondapac_app";
REVOKE USAGE ON SCHEMA "cart" FROM "mondapac_app";

DROP TABLE "cart"."cart_lines";
DROP TABLE "cart"."carts";
