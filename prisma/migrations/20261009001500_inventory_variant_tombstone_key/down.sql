-- Reverses 20261009001500_inventory_variant_tombstone_key. A Variant tombstone has no Offer, so
-- it cannot satisfy the old key: the variant rows are deleted. This is the development rollback;
-- a database that holds real tombstones is not rolled back (the Variant would be sellable again).
DROP INDEX "inventory"."stock_items_market_id_variant_id_active_idx";
DROP INDEX "inventory"."retirements_market_id_variant_id_variant_key";
DELETE FROM "inventory"."retirements" WHERE "scope" = 'variant';
ALTER TABLE "inventory"."retirements" DROP CONSTRAINT "retirements_offer_id_check";
ALTER TABLE "inventory"."retirements" ALTER COLUMN "offer_id" SET NOT NULL;
CREATE UNIQUE INDEX "retirements_market_id_offer_id_variant_id_variant_key" ON "inventory"."retirements" ("market_id", "offer_id", "variant_id") WHERE "scope" = 'variant';
