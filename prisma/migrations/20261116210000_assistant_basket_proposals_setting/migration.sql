-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- "Basket proposals from a list" (buyer assistant stage 1): off until an admin switches it on.
-- Rows written before this column existed read as off. Insert-only table: no grant changes.
ALTER TABLE "assistant"."settings" ADD COLUMN "basket_proposals" BOOLEAN NOT NULL DEFAULT false;
