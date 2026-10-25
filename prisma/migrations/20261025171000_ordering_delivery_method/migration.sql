-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable. The buyer's delivery method per seller order (delivery models, package 1).
-- Backfill: every seller order placed before this migration becomes 'instant', because that is
-- how it was handled (the carrier was booked on demand at payment, or the order is already
-- shipped). A to-ship order that was never booked is booked as an instant delivery when the
-- seller marks it ready; one that was booked answers already-booked. The default is dropped
-- after the backfill, so every new seller order must name its method.
ALTER TABLE "ordering"."seller_orders"
    ADD COLUMN "delivery_method" TEXT NOT NULL DEFAULT 'instant',
    ADD COLUMN "delivery_window_start" TIMESTAMPTZ(6),
    ADD COLUMN "delivery_window_end" TIMESTAMPTZ(6),
    ADD COLUMN "ready_at" TIMESTAMPTZ(6),
    ADD COLUMN "delivery_attention" TEXT;
ALTER TABLE "ordering"."seller_orders" ALTER COLUMN "delivery_method" DROP DEFAULT;

-- Hand-written: the method and its window go together; the attention state is a closed list.
ALTER TABLE "ordering"."seller_orders"
  ADD CONSTRAINT "seller_orders_delivery_method_check" CHECK ("delivery_method" IN ('pickup', 'instant', 'same_day', 'scheduled')),
  ADD CONSTRAINT "seller_orders_delivery_window_check" CHECK (
    ("delivery_method" = 'scheduled' AND "delivery_window_start" IS NOT NULL
      AND "delivery_window_end" IS NOT NULL AND "delivery_window_end" > "delivery_window_start")
    OR ("delivery_method" <> 'scheduled' AND "delivery_window_start" IS NULL
      AND "delivery_window_end" IS NULL)),
  ADD CONSTRAINT "seller_orders_delivery_attention_check" CHECK ("delivery_attention" IS NULL OR "delivery_attention" IN ('no-carrier'));

-- Grants. The method and the window are written at insert and never change; the ready time and
-- the attention state change after payment.
GRANT UPDATE ("ready_at", "delivery_attention") ON TABLE "ordering"."seller_orders" TO "mondapac_app";
