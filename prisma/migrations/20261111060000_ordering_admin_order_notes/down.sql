-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261111060000_ordering_admin_order_notes: every admin note on an order is lost.
DROP TABLE "ordering"."admin_order_notes";
