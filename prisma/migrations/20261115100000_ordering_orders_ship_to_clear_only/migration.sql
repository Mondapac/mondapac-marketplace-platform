-- Hassan (PR #883, Low 1): the app role may UPDATE orders.ship_to_ciphertext only so the ship-to
-- purge can clear it (owner decision 2026-11-15). The grant is column-level, not value-level, so
-- this trigger makes it clear-only: a new non-null value (re-sealing or replacing an address
-- after placement) is refused for every role; the insert still writes the address once.
-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- SECURITY INVOKER with a fixed search_path and schema-qualified names, as the other guards.
CREATE FUNCTION "ordering"."orders_ship_to_clear_only"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW."ship_to_ciphertext" IS NOT NULL
     AND NEW."ship_to_ciphertext" IS DISTINCT FROM OLD."ship_to_ciphertext" THEN
    RAISE EXCEPTION 'ordering.orders: the sealed ship-to may only be cleared'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "orders_ship_to_clear_only" BEFORE UPDATE OF "ship_to_ciphertext" ON "ordering"."orders"
  FOR EACH ROW EXECUTE FUNCTION "ordering"."orders_ship_to_clear_only"();
