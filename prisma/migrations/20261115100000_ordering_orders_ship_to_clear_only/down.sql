-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Reverses 20261115100000_ordering_orders_ship_to_clear_only: the column grant alone governs
-- the ship-to again (the app role could then write any value there).
DROP TRIGGER "orders_ship_to_clear_only" ON "ordering"."orders";
DROP FUNCTION "ordering"."orders_ship_to_clear_only"();
