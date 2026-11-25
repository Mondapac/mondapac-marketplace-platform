-- Reverses 20261124020000_ordering_buyer_first_orders. The claims and the flags are lost. Applied
-- again, the migration rebuilds both from the paid orders (earliest payment time, ties by order id);
-- a buyer whose two first payments raced may then get the other one as first, and reporting keeps
-- the flags it already recorded.
-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

REVOKE UPDATE ("buyer_first_order", "buyer_first_with_seller") ON TABLE "ordering"."seller_orders" FROM "mondapac_app";

DROP TABLE "ordering"."buyer_first_seller_orders";
DROP TABLE "ordering"."buyer_first_orders";

ALTER TABLE "ordering"."seller_orders"
  DROP CONSTRAINT "seller_orders_buyer_first_check",
  DROP COLUMN "buyer_first_with_seller",
  DROP COLUMN "buyer_first_order";
