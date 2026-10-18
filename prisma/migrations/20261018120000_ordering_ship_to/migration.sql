-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable. The delivery address the customer picks at checkout is copied onto the order
-- (customers package 2), sealed under the customer account's subject key, so a later change or
-- removal in the address book never touches a placed order. Orders placed before this migration
-- keep no address.
ALTER TABLE "ordering"."orders" ADD COLUMN "ship_to_ciphertext" TEXT;

-- Hand-written: the ciphertext format and bound of ordering design rule O7 (delivery address:
-- 16384). Null is an order placed before the address was recorded. Every existing row is null.
ALTER TABLE "ordering"."orders"
  ADD CONSTRAINT "orders_ship_to_ciphertext_check" CHECK (
    "ship_to_ciphertext" IS NULL
    OR ("ship_to_ciphertext" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
      AND char_length("ship_to_ciphertext") BETWEEN 41 AND 16384)
  );

-- No grant: the column is written only by the insert, which the app role already holds, and
-- never changes afterwards.
