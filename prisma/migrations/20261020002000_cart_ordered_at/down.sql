-- Reverses 20261020002000_cart_ordered_at: the grant, the check, then the column. The order marks
-- are lost, so carts ordered from before the down may get a cart reminder.
SET lock_timeout = '5s';

REVOKE UPDATE ("ordered_at") ON TABLE "cart"."carts" FROM "mondapac_app";
ALTER TABLE "cart"."carts" DROP CONSTRAINT "carts_ordered_at_check";
ALTER TABLE "cart"."carts" DROP COLUMN "ordered_at";
