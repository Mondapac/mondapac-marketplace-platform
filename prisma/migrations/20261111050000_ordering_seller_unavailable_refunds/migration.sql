-- A seller marks units of a line of its own paid seller order unavailable before it is ready
-- (order detail decision 6): the units are refunded at once, through the same refund rows as an
-- admin refund. The refund's actor may now be the seller, only with the reason `item-unavailable`
-- and with the loss on the seller (the seller ledger reverses it). An admin refund keeps its
-- reasons. Nothing is backfilled: every stored refund is an admin's, and satisfies the new checks.
-- A plain ADD is safe: no deployed environment holds refunds (the switch is off everywhere); a
-- populated table would need ADD ... NOT VALID, then VALIDATE. Safety: a blocked statement fails
-- instead of queueing.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

ALTER TABLE "ordering"."refunds"
  DROP CONSTRAINT "refunds_reason_check",
  DROP CONSTRAINT "refunds_actor_population_check";

ALTER TABLE "ordering"."refunds"
  ADD CONSTRAINT "refunds_reason_check" CHECK (
    "reason" IN ('not-received', 'damaged', 'wrong-item', 'not-as-described', 'seller-cancelled',
      'other', 'item-unavailable')),
  ADD CONSTRAINT "refunds_actor_population_check" CHECK ("actor_population" IN ('admin', 'seller')),
  -- A seller refund is only ever an unavailable item, borne by the seller; the reason is the
  -- seller's alone, so an admin refund never carries it.
  ADD CONSTRAINT "refunds_seller_actor_check" CHECK (
    ("actor_population" = 'admin' AND "reason" <> 'item-unavailable')
    OR ("actor_population" = 'seller' AND "reason" = 'item-unavailable'
      AND "loss_bearer" = 'seller' AND "loss_reason_code" IS NULL));
