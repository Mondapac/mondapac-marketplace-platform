-- Reverses 20261018000000_ordering_ship_to: the column goes. The sealed addresses are lost with it.
ALTER TABLE "ordering"."orders" DROP COLUMN "ship_to_ciphertext";
