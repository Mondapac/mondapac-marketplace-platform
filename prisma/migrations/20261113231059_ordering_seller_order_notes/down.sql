-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261113231059_ordering_seller_order_notes: every seller note on a seller order is lost.
DROP TABLE "ordering"."seller_order_notes";
