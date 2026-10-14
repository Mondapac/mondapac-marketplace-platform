-- Reverses 20261014120000_shipping_flat_fees: the grants first, then the table. The empty schema
-- "shipping" stays, without its USAGE grant, as the leftover check of
-- docs/design/data/platform.md 10.5 (guard 2) expects.
REVOKE SELECT, INSERT, UPDATE ("amount", "currency", "updated_at", "updated_by") ON TABLE "shipping"."seller_flat_fees" FROM "mondapac_app";
REVOKE USAGE ON SCHEMA "shipping" FROM "mondapac_app";

DROP TABLE "shipping"."seller_flat_fees";
