-- Reverses 20261014060000_ordering_checkout: the grants first, then the tables, children before
-- parents. Indexes and CHECKs go with their tables. The empty schema "ordering" stays, without
-- its USAGE grant, as the leftover check of docs/design/data/platform.md 10.5 (guard 2) expects.
REVOKE SELECT, INSERT ON TABLE "ordering"."order_lines" FROM "mondapac_app";
REVOKE SELECT, INSERT ON TABLE "ordering"."seller_orders" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ("status", "cancel_reason", "payment_state", "stripe_session_id", "stripe_payment_intent_id", "confirmed_at", "cancelled_at", "version") ON TABLE "ordering"."orders" FROM "mondapac_app";
REVOKE USAGE ON SCHEMA "ordering" FROM "mondapac_app";

DROP TABLE "ordering"."order_lines";
DROP TABLE "ordering"."seller_orders";
DROP TABLE "ordering"."orders";
