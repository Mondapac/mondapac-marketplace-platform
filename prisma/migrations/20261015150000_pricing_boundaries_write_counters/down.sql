-- Reverses 20261015150000_pricing_boundaries_write_counters: grants, triggers, the tables (their
-- CHECKs, indexes and foreign key go with them), then the two live indexes and the unique index.
REVOKE SELECT, INSERT, UPDATE ("count", "window_started_at"), DELETE ON TABLE "pricing"."write_rate_counters" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "pricing"."special_price_boundaries" FROM "mondapac_app";

DROP TRIGGER "special_price_boundaries_no_truncate" ON "pricing"."special_price_boundaries";
DROP TRIGGER "special_price_boundaries_no_delete" ON "pricing"."special_price_boundaries";
DROP TRIGGER "special_price_boundaries_no_update" ON "pricing"."special_price_boundaries";

DROP TABLE "pricing"."special_price_boundaries";
DROP TABLE "pricing"."write_rate_counters";

DROP INDEX "pricing"."special_price_records_market_id_ends_at_live_idx";
DROP INDEX "pricing"."special_price_records_market_id_effective_from_live_idx";
DROP INDEX "pricing"."special_price_records_market_id_id_key";
