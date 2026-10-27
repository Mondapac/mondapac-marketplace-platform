-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Delivery models, package 3: the fleet router. A seller order is booked with the fleet the
-- router picks (Mondapac Drive, Uber Direct, Zoom2u, Australia Post, or the fake for tests), by
-- the admin's active selection model for the Market and delivery method.

-- The booking row names the fleet that booked it. `carrier` becomes `fleet` (existing rows are
-- Mondapac Drive); the tracking reference is no longer always a UUID (other fleets use their own).
ALTER TABLE "shipping"."carrier_bookings" DROP CONSTRAINT "carrier_bookings_carrier_check";
ALTER TABLE "shipping"."carrier_bookings" DROP CONSTRAINT "carrier_bookings_carrier_reference_check";
ALTER TABLE "shipping"."carrier_bookings" RENAME COLUMN "carrier" TO "fleet";
UPDATE "shipping"."carrier_bookings" SET "fleet" = 'mondapac_drive' WHERE "fleet" = 'mondapac-drive';
ALTER INDEX "shipping"."carrier_bookings_market_id_carrier_carrier_reference_key"
  RENAME TO "carrier_bookings_market_id_fleet_carrier_reference_key";
ALTER TABLE "shipping"."carrier_bookings"
  ADD CONSTRAINT "carrier_bookings_fleet_check" CHECK ("fleet" IN ('mondapac_drive', 'uber_direct', 'zoom2u', 'auspost', 'fake_test')),
  ADD CONSTRAINT "carrier_bookings_carrier_reference_check" CHECK (char_length("carrier_reference") BETWEEN 1 AND 200 AND "carrier_reference" ~ '^[\x21-\x7e]+$'),
  -- A fleet's status words are its own: upper case with digits, or the like, up to 40.
  DROP CONSTRAINT "carrier_bookings_carrier_status_check",
  ADD CONSTRAINT "carrier_bookings_carrier_status_check" CHECK (char_length("carrier_status") BETWEEN 1 AND 60 AND "carrier_status" ~ '^[\x21-\x7e]+$');

-- A webhook event is taken per fleet (the column keeps the name `carrier`).
ALTER TABLE "shipping"."carrier_events" DROP CONSTRAINT "carrier_events_carrier_check";
UPDATE "shipping"."carrier_events" SET "carrier" = 'mondapac_drive' WHERE "carrier" = 'mondapac-drive';
ALTER TABLE "shipping"."carrier_events"
  ADD CONSTRAINT "carrier_events_carrier_check" CHECK ("carrier" IN ('mondapac_drive', 'uber_direct', 'zoom2u', 'auspost', 'fake_test'));

-- CreateTable
CREATE TABLE "shipping"."fleet_selection_models" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "rule" JSONB NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "fleet_selection_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipping"."fleet_selection_assignments" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "model_id" UUID,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "fleet_selection_assignments_pkey" PRIMARY KEY ("market_id","method")
);

-- CreateTable
CREATE TABLE "shipping"."fleet_reliability" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "fleet" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by" UUID NOT NULL,

    CONSTRAINT "fleet_reliability_pkey" PRIMARY KEY ("market_id","fleet")
);

-- CreateTable
CREATE TABLE "shipping"."fleet_booking_attempts" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_order_id" UUID NOT NULL,
    "fleet" TEXT NOT NULL,
    "attempted_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fleet_booking_attempts_pkey" PRIMARY KEY ("market_id","seller_order_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fleet_selection_models_market_id_id_key" ON "shipping"."fleet_selection_models"("market_id", "id");

-- Hand-written: a model name is unique within a Market, whatever its case.
CREATE UNIQUE INDEX "fleet_selection_models_market_id_lower_name_key" ON "shipping"."fleet_selection_models"("market_id", lower("name"));

-- AddForeignKey
ALTER TABLE "shipping"."fleet_selection_assignments" ADD CONSTRAINT "fleet_selection_assignments_market_id_model_id_fkey" FOREIGN KEY ("market_id", "model_id") REFERENCES "shipping"."fleet_selection_models"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: scope and value checks of the new tables (empty, so no NOT VALID step).
ALTER TABLE "shipping"."fleet_selection_models"
  ADD CONSTRAINT "fleet_selection_models_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "fleet_selection_models_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "fleet_selection_models_name_check" CHECK (char_length("name") BETWEEN 1 AND 60),
  ADD CONSTRAINT "fleet_selection_models_kind_check" CHECK ("kind" IN ('cheapest', 'weighted', 'fixed_priority')),
  ADD CONSTRAINT "fleet_selection_models_rule_check" CHECK (jsonb_typeof("rule") = 'object' AND "rule"->>'kind' = "kind"),
  ADD CONSTRAINT "fleet_selection_models_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "fleet_selection_models_updated_at_check" CHECK ("updated_at" >= "created_at");
ALTER TABLE "shipping"."fleet_selection_assignments"
  ADD CONSTRAINT "fleet_selection_assignments_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "fleet_selection_assignments_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "fleet_selection_assignments_method_check" CHECK ("method" IN ('instant', 'same_day', 'scheduled'));
ALTER TABLE "shipping"."fleet_reliability"
  ADD CONSTRAINT "fleet_reliability_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "fleet_reliability_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "fleet_reliability_fleet_check" CHECK ("fleet" IN ('mondapac_drive', 'uber_direct', 'zoom2u', 'auspost', 'fake_test')),
  ADD CONSTRAINT "fleet_reliability_score_check" CHECK ("score" BETWEEN 0 AND 100);
ALTER TABLE "shipping"."fleet_booking_attempts"
  ADD CONSTRAINT "fleet_booking_attempts_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "fleet_booking_attempts_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "fleet_booking_attempts_fleet_check" CHECK ("fleet" IN ('mondapac_drive', 'uber_direct', 'zoom2u', 'auspost', 'fake_test'));

-- Hand-written: the platform-attention reasons of a seller order. `carrier-unknown`: a booking
-- whose answer was lost at a fleet that cannot dedupe, so it may exist; `cancel-unknown`: a cancel
-- whose answer was lost at such a fleet. Both need an admin to check with the fleet.
ALTER TABLE "ordering"."seller_orders" DROP CONSTRAINT "seller_orders_delivery_attention_check";
ALTER TABLE "ordering"."seller_orders"
  ADD CONSTRAINT "seller_orders_delivery_attention_check" CHECK ("delivery_attention" IS NULL OR "delivery_attention" IN ('no-carrier', 'carrier-unknown', 'cancel-unknown')) NOT VALID;
ALTER TABLE "ordering"."seller_orders" VALIDATE CONSTRAINT "seller_orders_delivery_attention_check";

-- Grants. Models are created and edited, never deleted; an assignment and a reliability score are
-- written once and changed; an attempt is written, moved to another fleet and removed.
GRANT SELECT, INSERT, UPDATE ("name", "kind", "rule", "version", "updated_at", "updated_by") ON TABLE "shipping"."fleet_selection_models" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("model_id", "updated_at", "updated_by") ON TABLE "shipping"."fleet_selection_assignments" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("score", "updated_at", "updated_by") ON TABLE "shipping"."fleet_reliability" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("fleet", "attempted_at"), DELETE ON TABLE "shipping"."fleet_booking_attempts" TO "mondapac_app";
