-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- AlterTable: the waiting period after a bank change, the payout pause and its applied state.
ALTER TABLE "payments"."connected_accounts"
  ADD COLUMN "cooling_off_until" TIMESTAMPTZ(6),
  ADD COLUMN "payouts_paused_until" TIMESTAMPTZ(6),
  ADD COLUMN "payout_schedule_applied" TEXT,
  ADD COLUMN "payout_schedule_revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_change_id" UUID;

-- Hand-written: value checks.
ALTER TABLE "payments"."connected_accounts"
  ADD CONSTRAINT "connected_accounts_payout_schedule_applied_check" CHECK ("payout_schedule_applied" IS NULL OR "payout_schedule_applied" IN ('manual', 'normal')),
  ADD CONSTRAINT "connected_accounts_payout_schedule_revision_check" CHECK ("payout_schedule_revision" >= 0);

-- CreateTable
CREATE TABLE "payments"."payout_account_changes" (
    "market_id" VARCHAR(8) NOT NULL,
    "id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "detected_at" TIMESTAMPTZ(6) NOT NULL,
    "cooling_off_until" TIMESTAMPTZ(6),
    "source_event_id" TEXT NOT NULL,

    CONSTRAINT "payout_account_changes_pkey" PRIMARY KEY ("market_id","id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payout_account_changes_market_id_source_event_id_key" ON "payments"."payout_account_changes"("market_id", "source_event_id");

-- CreateIndex
CREATE INDEX "payout_account_changes_market_id_seller_id_detected_at_idx" ON "payments"."payout_account_changes"("market_id", "seller_id", "detected_at" DESC);

-- AddForeignKey
ALTER TABLE "payments"."payout_account_changes" ADD CONSTRAINT "payout_account_changes_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "payments"."connected_accounts"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-written: scope and value checks.
ALTER TABLE "payments"."payout_account_changes"
  ADD CONSTRAINT "payout_account_changes_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "payout_account_changes_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "payout_account_changes_kind_check" CHECK ("kind" IN ('initial', 'added', 'updated', 'removed')),
  ADD CONSTRAINT "payout_account_changes_source_event_id_check" CHECK ("source_event_id" ~ '^evt_[A-Za-z0-9_]{1,200}$'),
  -- The first destination has no waiting period; every other change has one after it was seen.
  ADD CONSTRAINT "payout_account_changes_cooling_off_check" CHECK (
    ("kind" = 'initial' AND "cooling_off_until" IS NULL)
    OR ("kind" <> 'initial' AND "cooling_off_until" IS NOT NULL AND "cooling_off_until" > "detected_at"));

-- The Stripe events inbox also keeps the external-account events (object is the account).
ALTER TABLE "payments"."stripe_events"
  DROP CONSTRAINT "stripe_events_type_check",
  ADD CONSTRAINT "stripe_events_type_check" CHECK ("type" IN (
    'checkout.session.completed', 'checkout.session.expired',
    'checkout.session.async_payment_failed', 'account.updated', 'capability.updated',
    'account.external_account.created', 'account.external_account.updated',
    'account.external_account.deleted'));

-- Backfill: an account that already has a Stripe id gets one `initial` marker change, so a later
-- bank event on it is a real change and not taken for the onboarding. The id of the marker
-- cannot clash with a Stripe event id.
WITH marker AS (
  SELECT "market_id", "tenant_id", "seller_id", gen_random_uuid() AS "id", "created_at"
  FROM "payments"."connected_accounts" WHERE "account_ref" IS NOT NULL
), written AS (
  INSERT INTO "payments"."payout_account_changes"
    ("market_id", "id", "tenant_id", "seller_id", "kind", "detected_at", "cooling_off_until", "source_event_id")
  SELECT "market_id", "id", "tenant_id", "seller_id", 'initial', "created_at", NULL,
    'evt_backfill_' || replace("seller_id"::text, '-', '')
  FROM marker RETURNING "market_id", "seller_id", "id"
)
UPDATE "payments"."connected_accounts" a SET "last_change_id" = written."id"
FROM written WHERE a."market_id" = written."market_id" AND a."seller_id" = written."seller_id";

-- Hand-written: the waiting period and the pause only move forward. A lower value is refused, and
-- so is clearing one that is still in the future, whoever asks.
CREATE FUNCTION "payments"."connected_accounts_guard_pause"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD."cooling_off_until" IS NOT NULL AND (
       (NEW."cooling_off_until" IS NULL AND OLD."cooling_off_until" > now())
    OR (NEW."cooling_off_until" IS NOT NULL AND NEW."cooling_off_until" < OLD."cooling_off_until")
  ) THEN
    RAISE EXCEPTION 'payments.connected_accounts: cooling_off_until cannot move back'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."payouts_paused_until" IS NOT NULL AND (
       (NEW."payouts_paused_until" IS NULL AND OLD."payouts_paused_until" > now())
    OR (NEW."payouts_paused_until" IS NOT NULL AND NEW."payouts_paused_until" < OLD."payouts_paused_until")
  ) THEN
    RAISE EXCEPTION 'payments.connected_accounts: payouts_paused_until cannot move back'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "connected_accounts_guard_pause" BEFORE UPDATE ON "payments"."connected_accounts"
  FOR EACH ROW EXECUTE FUNCTION "payments"."connected_accounts_guard_pause"();

-- Grants. The change history is insert-only (no UPDATE, no DELETE); the account row gains the
-- waiting-period and schedule columns the application moves.
GRANT SELECT, INSERT ON TABLE "payments"."payout_account_changes" TO "mondapac_app";
GRANT UPDATE ("cooling_off_until", "payouts_paused_until", "payout_schedule_applied", "payout_schedule_revision", "last_change_id") ON TABLE "payments"."connected_accounts" TO "mondapac_app";
