-- Inventory migration 2a (docs/design/data/inventory.md 3.10, 8.1; mini-review 2026-10-09 in
-- docs/modules/inventory/brief.md): a Variant tombstone is keyed by the Variant alone.
-- `catalog.variant-removed.v1` carries (productId, variantId) and no Offer, and a Variant id is
-- never reused (CAT M-1), so (market_id, variant_id) is the whole key and `offer_id` is NULL for
-- scope 'variant'. Slice 2 had no writer of this table, so no variant row exists yet; the two
-- statements below only keep the migration safe if one did.

-- Variant rows lose their Offer; a Variant seen under several Offers keeps its oldest row.
DELETE FROM "inventory"."retirements" AS r
 USING "inventory"."retirements" AS older
 WHERE r."scope" = 'variant' AND older."scope" = 'variant'
   AND r."market_id" = older."market_id" AND r."variant_id" = older."variant_id"
   AND (older."retired_at", older."id") < (r."retired_at", r."id");
ALTER TABLE "inventory"."retirements" ALTER COLUMN "offer_id" DROP NOT NULL;
UPDATE "inventory"."retirements" SET "offer_id" = NULL WHERE "scope" = 'variant';

ALTER TABLE "inventory"."retirements"
  ADD CONSTRAINT "retirements_offer_id_check" CHECK (("scope" = 'offer') = ("offer_id" IS NOT NULL));

DROP INDEX "inventory"."retirements_market_id_offer_id_variant_id_variant_key";
CREATE UNIQUE INDEX "retirements_market_id_variant_id_variant_key" ON "inventory"."retirements" ("market_id", "variant_id") WHERE "scope" = 'variant';

-- The Variant retirement updates the active items of a Variant across Offers; this serves it.
-- retired_at is in the predicate only, so a stock write (on_hand, version) stays a HOT update.
CREATE INDEX "stock_items_market_id_variant_id_active_idx" ON "inventory"."stock_items" ("market_id", "variant_id") WHERE "retired_at" IS NULL;
