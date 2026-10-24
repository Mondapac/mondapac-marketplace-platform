-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reordering the live slides of a position needs no approval (john, 24 Oct). The order is the
-- sort order of the projection rows; it is saved here as well, because the projection of a slide
-- is rebuilt when it is approved or resumed and removed when it is paused, and the version it
-- is built from is write-once. The next projection starts from the saved order.

-- CreateTable
CREATE TABLE "storefront"."slide_saved_orders" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "slide_id" UUID NOT NULL,
    "position_key" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scope_key" UUID NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "saved_at" TIMESTAMPTZ(6) NOT NULL,
    "saved_by" UUID NOT NULL,

    CONSTRAINT "slide_saved_orders_pkey" PRIMARY KEY ("market_id","slide_id","position_key","scope","scope_key")
);

-- AddForeignKey
ALTER TABLE "storefront"."slide_saved_orders" ADD CONSTRAINT "slide_saved_orders_market_id_slide_id_fkey" FOREIGN KEY ("market_id", "slide_id") REFERENCES "storefront"."slides"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: value checks, as on the placements the rows mirror. The nil uuid stands for "no
-- scope id" (the scope all), as in the unique index of the placements.
ALTER TABLE "storefront"."slide_saved_orders"
  ADD CONSTRAINT "slide_saved_orders_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "slide_saved_orders_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "slide_saved_orders_position_key_check" CHECK (
    "position_key" ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$' AND char_length("position_key") <= 40),
  ADD CONSTRAINT "slide_saved_orders_scope_check" CHECK (
    ("scope" = 'all' AND "scope_key" = '00000000-0000-0000-0000-000000000000'::uuid)
    OR ("scope" IN ('category', 'product', 'seller', 'page')
        AND "scope_key" <> '00000000-0000-0000-0000-000000000000'::uuid)),
  ADD CONSTRAINT "slide_saved_orders_sort_order_check" CHECK ("sort_order" BETWEEN 0 AND 1000);

-- Grants. The reorder rewrites the sort order of the projection rows (and nothing else of them)
-- and replaces the saved order of a slide's placement (deleted and inserted, never updated).
GRANT UPDATE ("sort_order") ON TABLE "storefront"."slide_placements" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "storefront"."slide_saved_orders" TO "mondapac_app";
