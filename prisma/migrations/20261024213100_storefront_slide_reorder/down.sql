SET lock_timeout = '5s';

-- Reverses 20261024213100_storefront_slide_reorder: the grants first, then the table. The saved
-- orders are lost; the sort order of the projection rows stays as it was last written.
REVOKE SELECT, INSERT, DELETE ON TABLE "storefront"."slide_saved_orders" FROM "mondapac_app";
REVOKE UPDATE ("sort_order") ON TABLE "storefront"."slide_placements" FROM "mondapac_app";

DROP TABLE "storefront"."slide_saved_orders";
