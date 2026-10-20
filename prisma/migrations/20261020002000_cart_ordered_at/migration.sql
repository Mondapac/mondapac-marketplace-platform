-- Personalization package 1c (abandoned-cart email): the order mark of a cart. When `ordering`
-- clears the ordered lines (cart.clear-ordered-lines), the column is set to the same instant as
-- `last_changed_at`; the cart's next change clears it. While it is set, the cart gets no cart
-- reminder ("stop on order"). Nullable, no default: a metadata-only change, no table rewrite.

-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

ALTER TABLE "cart"."carts" ADD COLUMN "ordered_at" TIMESTAMPTZ(6);

-- Hand-written: the order mark is never later than the cart's last change (both are set in the
-- same write).
-- NOT VALID, then VALIDATE: the scan runs under SHARE UPDATE EXCLUSIVE, not ACCESS EXCLUSIVE.
ALTER TABLE "cart"."carts"
  ADD CONSTRAINT "carts_ordered_at_check" CHECK ("ordered_at" IS NULL OR "ordered_at" <= "last_changed_at") NOT VALID;
ALTER TABLE "cart"."carts" VALIDATE CONSTRAINT "carts_ordered_at_check";

GRANT UPDATE ("ordered_at") ON TABLE "cart"."carts" TO "mondapac_app";
