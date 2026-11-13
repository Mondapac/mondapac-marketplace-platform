-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- Reverses 20261111050000_ordering_seller_unavailable_refunds. Fails while a seller refund is
-- stored (the old checks refuse it): such rows are money already given back and are never
-- deleted here.
ALTER TABLE "ordering"."refunds"
  DROP CONSTRAINT "refunds_seller_actor_check",
  DROP CONSTRAINT "refunds_actor_population_check",
  DROP CONSTRAINT "refunds_reason_check";

ALTER TABLE "ordering"."refunds"
  ADD CONSTRAINT "refunds_reason_check" CHECK (
    "reason" IN ('not-received', 'damaged', 'wrong-item', 'not-as-described', 'seller-cancelled', 'other')),
  ADD CONSTRAINT "refunds_actor_population_check" CHECK ("actor_population" = 'admin');
