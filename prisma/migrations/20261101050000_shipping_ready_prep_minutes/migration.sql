-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Seller health (late ready): the minutes a Market gives a seller to get a paid order ready.
-- The default is 60, so a Market that never saved delivery settings and a Market that did both
-- read 60 until an admin changes it; no backfill is needed.
ALTER TABLE "shipping"."delivery_settings"
    ADD COLUMN "ready_prep_minutes" INTEGER NOT NULL DEFAULT 60;

-- Hand-written: 5 minutes to 2 days.
ALTER TABLE "shipping"."delivery_settings"
  ADD CONSTRAINT "delivery_settings_ready_prep_minutes_check" CHECK ("ready_prep_minutes" BETWEEN 5 AND 2880);

-- Grants: updated on every save, like the other columns (INSERT is table-wide).
GRANT UPDATE ("ready_prep_minutes") ON TABLE "shipping"."delivery_settings" TO "mondapac_app";
