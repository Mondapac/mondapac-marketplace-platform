-- Reverses 20261018120000_ordering_ship_to: the check and the column go. The sealed addresses are
-- lost with them.
ALTER TABLE "ordering"."orders"
  DROP CONSTRAINT "orders_ship_to_ciphertext_check",
  DROP COLUMN "ship_to_ciphertext";
