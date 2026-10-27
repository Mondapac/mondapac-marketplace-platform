-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261025150000_shipping_delivery_settings. The admin's delivery settings and the
-- methods taken away from sellers are lost: every method is open again, as before the migration.
DROP TABLE "shipping"."seller_delivery_methods";
DROP TABLE "shipping"."delivery_settings";
