REVOKE DELETE ON TABLE "cart"."carts" FROM "mondapac_app";
DROP INDEX "cart"."carts_market_id_last_changed_at_idx";
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "cart"."rate_counters" FROM "mondapac_app";
DROP TABLE "cart"."rate_counters";
