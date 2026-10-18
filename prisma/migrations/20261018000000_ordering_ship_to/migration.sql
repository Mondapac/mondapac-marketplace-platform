-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable. The delivery address the customer picks at checkout is copied onto the order
-- (customers package 2), sealed under the customer account's subject key, so a later change or
-- removal in the address book never touches a placed order. Orders placed before this migration
-- keep no address.
ALTER TABLE "ordering"."orders" ADD COLUMN "ship_to_ciphertext" TEXT;

-- No grant: the column is written only by the insert, which the app role already holds, and
-- never changes afterwards.
