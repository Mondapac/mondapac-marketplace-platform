-- Personalization package 1c (abandoned-cart email): the cart reminders taken for sending, one row
-- per account, cart change and stage (1 at about 4 hours idle, 2 at about 24 hours). The job
-- inserts the row before it sends, so a stage goes out at most once per cart change. Ids and
-- instants only: no address, no cart content. Retention 30 days (the job deletes older rows).

-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "notifications"."cart_reminders" (
    "market_id" VARCHAR(8) NOT NULL,
    "account_id" UUID NOT NULL,
    "cart_changed_at" TIMESTAMPTZ(6) NOT NULL,
    "stage" SMALLINT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "taken_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cart_reminders_pkey" PRIMARY KEY ("market_id","account_id","cart_changed_at","stage")
);

-- CreateIndex: the retention purge.
CREATE INDEX "cart_reminders_market_id_taken_at_idx" ON "notifications"."cart_reminders"("market_id", "taken_at");

-- Hand-written: scope and value checks.
ALTER TABLE "notifications"."cart_reminders"
  ADD CONSTRAINT "cart_reminders_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "cart_reminders_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "cart_reminders_stage_check" CHECK ("stage" IN (1, 2));

-- Grants. Written once, never updated; deleted by retention.
GRANT SELECT, INSERT, DELETE ON TABLE "notifications"."cart_reminders" TO "mondapac_app";
