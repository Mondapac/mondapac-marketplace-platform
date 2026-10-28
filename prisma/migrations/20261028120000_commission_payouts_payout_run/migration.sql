-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- The payout run (Phase 5 package 6d; docs/design/domain/commission-payouts.md 3.6, 4.6, 4.7, 4.11;
-- docs/design/data/commission-payouts.md 3.6, 3.7, simplified by the package brief): payouts, their
-- items and the per-seller schedule cursor. Only new tables, so nothing is NOT VALID and no index is
-- built CONCURRENTLY; the one index on an existing table (payout_holds) is small.

-- CreateTable
CREATE TABLE "commission_payouts"."payouts" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "gross_minor" BIGINT NOT NULL,
    "netted_minor" BIGINT NOT NULL,
    "transfer_minor" BIGINT NOT NULL,
    "approval_mode" TEXT NOT NULL,
    "approval_reason" TEXT,
    "minimum_minor" BIGINT NOT NULL,
    "slot_at" TIMESTAMPTZ(6) NOT NULL,
    "state" TEXT NOT NULL,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "approved_transfer_minor" BIGINT,
    "transfer_execution_id" UUID,
    "outcome_code" TEXT,
    "instructing_at" TIMESTAMPTZ(6),
    "abandoned_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "state_changed_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_payouts"."payout_items" (
    "market_id" VARCHAR(8) NOT NULL,
    "payout_id" UUID NOT NULL,
    "seller_order_id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "freed_at" TIMESTAMPTZ(6),

    CONSTRAINT "payout_items_pkey" PRIMARY KEY ("market_id","payout_id","seller_order_id")
);

-- CreateTable
CREATE TABLE "commission_payouts"."payout_schedule_cursors" (
    "market_id" VARCHAR(8) NOT NULL,
    "seller_id" UUID NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "last_slot_at" TIMESTAMPTZ(6) NOT NULL,
    "next_slot_at" TIMESTAMPTZ(6),
    "zone" TEXT,
    "block_reason" TEXT,
    "evaluated_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,

    CONSTRAINT "payout_schedule_cursors_pkey" PRIMARY KEY ("market_id","seller_id")
);

-- CreateIndex
CREATE INDEX "payouts_market_id_state_created_at_id_idx" ON "commission_payouts"."payouts"("market_id", "state", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "payouts_market_id_seller_id_created_at_id_idx" ON "commission_payouts"."payouts"("market_id", "seller_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "payouts_market_id_id_seller_id_currency_key" ON "commission_payouts"."payouts"("market_id", "id", "seller_id", "currency");

-- CreateIndex
CREATE INDEX "payout_schedule_cursors_market_id_next_slot_at_idx" ON "commission_payouts"."payout_schedule_cursors"("market_id", "next_slot_at");

-- AddForeignKey
ALTER TABLE "commission_payouts"."payout_items" ADD CONSTRAINT "payout_items_payout_fkey" FOREIGN KEY ("market_id", "payout_id", "seller_id", "currency") REFERENCES "commission_payouts"."payouts"("market_id", "id", "seller_id", "currency") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------------------------
-- Hand-written: scope and value checks
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "commission_payouts"."payouts"
  ADD CONSTRAINT "payouts_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "payouts_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "payouts_state_check" CHECK ("state" IN
    ('pending', 'awaiting-approval', 'approved', 'instructing', 'instructed', 'paid', 'failed',
     'not-sent', 'voided', 'settled-by-netting')),
  ADD CONSTRAINT "payouts_approval_mode_check" CHECK ("approval_mode" IN ('AUTO', 'MANUAL')),
  -- A MANUAL payout says why it waits; an AUTO one says nothing.
  ADD CONSTRAINT "payouts_approval_reason_check" CHECK (
    ("approval_mode" = 'MANUAL') = ("approval_reason" IS NOT NULL)
    AND ("approval_reason" IS NULL OR "approval_reason" IN ('first-payout', 'terms'))),
  -- E = N + T, with something to pay out of (E >= 1).
  ADD CONSTRAINT "payouts_amounts_check" CHECK (
    "gross_minor" >= 1 AND "netted_minor" >= 0 AND "transfer_minor" >= 0
    AND "transfer_minor" = "gross_minor" - "netted_minor"),
  -- Either everything was netted (nothing to transfer), or the transfer reaches the minimum of the
  -- terms used: a payout under the minimum is never created.
  ADD CONSTRAINT "payouts_minimum_check" CHECK (
    "minimum_minor" >= 1
    AND (("transfer_minor" = 0 AND "netted_minor" > 0) OR "transfer_minor" >= "minimum_minor")),
  -- A payout is settled by netting exactly when there is nothing to transfer, and then it needs no
  -- admin and moves no money.
  ADD CONSTRAINT "payouts_netting_check" CHECK (
    ("state" = 'settled-by-netting') = ("transfer_minor" = 0)
    AND ("transfer_minor" > 0 OR "approval_mode" = 'AUTO')),
  -- Approval binds the amount: the three approval columns are all set or all empty, only a MANUAL
  -- payout has them, the approved amount is the transfer (5,999 for 6,000 is refused), a waiting
  -- payout has none, and a MANUAL payout past the wait has them (a voided one may not).
  ADD CONSTRAINT "payouts_approval_check" CHECK (
    (("approved_by" IS NULL) = ("approved_at" IS NULL))
    AND (("approved_by" IS NULL) = ("approved_transfer_minor" IS NULL))
    AND ("approved_by" IS NULL OR "approval_mode" = 'MANUAL')
    AND ("approved_transfer_minor" IS NULL OR "approved_transfer_minor" = "transfer_minor")
    AND ("state" <> 'awaiting-approval' OR "approved_by" IS NULL)
    AND ("approval_mode" = 'AUTO' OR "state" IN ('awaiting-approval', 'voided')
         OR "approved_by" IS NOT NULL)
    AND ("state" NOT IN ('approved', 'awaiting-approval') OR "approval_mode" = 'MANUAL')
    AND ("state" NOT IN ('pending', 'settled-by-netting') OR "approval_mode" = 'AUTO')),
  -- Once the transfer exists, payments' id is stored with it.
  ADD CONSTRAINT "payouts_transfer_check" CHECK (
    "state" NOT IN ('instructed', 'paid', 'failed') OR "transfer_execution_id" IS NOT NULL),
  -- The send timeout counts from the instant the payout became INSTRUCTING.
  ADD CONSTRAINT "payouts_instructing_check" CHECK (
    "state" NOT IN ('instructing', 'instructed', 'paid', 'failed') OR "instructing_at" IS NOT NULL),
  -- A payout that ends without paying says why, with a code and no free text.
  ADD CONSTRAINT "payouts_outcome_check" CHECK (
    ("outcome_code" IS NULL OR "outcome_code" ~ '^[a-z][a-z0-9.-]{0,63}$')
    AND ("state" NOT IN ('not-sent', 'voided', 'failed') OR "outcome_code" IS NOT NULL)),
  ADD CONSTRAINT "payouts_version_check" CHECK ("version" >= 1);

ALTER TABLE "commission_payouts"."payout_items"
  ADD CONSTRAINT "payout_items_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "payout_items_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "payout_items_amount_check" CHECK ("amount_minor" >= 1);

-- The reasons a seller may be shown (the seller view of "next payout"); the codes of the
-- commission-payouts.payout.blocked.* family without the prefix.
ALTER TABLE "commission_payouts"."payout_schedule_cursors"
  ADD CONSTRAINT "payout_schedule_cursors_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "payout_schedule_cursors_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "payout_schedule_cursors_block_reason_check" CHECK (
    "block_reason" IS NULL OR "block_reason" IN
      ('below-minimum', 'awaiting-approval', 'account-not-ready', 'cooling-off', 'payouts-paused',
       'zone-missing', 'second-factor-required')),
  ADD CONSTRAINT "payout_schedule_cursors_zone_check" CHECK ("zone" IS NULL OR length("zone") BETWEEN 1 AND 64),
  ADD CONSTRAINT "payout_schedule_cursors_version_check" CHECK ("version" >= 1);

-- One live payout per seller: a seller is never paid by two payouts at once. A PENDING,
-- AWAITING_APPROVAL, APPROVED or INSTRUCTING payout is live.
CREATE UNIQUE INDEX "payouts_market_id_seller_id_live_key"
  ON "commission_payouts"."payouts" ("market_id", "seller_id")
  WHERE "state" IN ('pending', 'awaiting-approval', 'approved', 'instructing');

-- The worker pass, the approval list and the reconcile job read the payouts that are not final by
-- state (the live ones, and an instructed one until payments reports it paid or failed).
CREATE INDEX "payouts_market_id_open_idx"
  ON "commission_payouts"."payouts" ("market_id", "state", "state_changed_at", "id")
  WHERE "state" IN ('pending', 'awaiting-approval', 'approved', 'instructing', 'instructed');

-- payments' transfer-changed event names the transfer, not our key: it finds its payout here.
CREATE UNIQUE INDEX "payouts_market_id_transfer_execution_id_key"
  ON "commission_payouts"."payouts" ("market_id", "transfer_execution_id")
  WHERE "transfer_execution_id" IS NOT NULL;

-- One live item per seller order: a seller order is in at most one payout that has not ended
-- without paying (an item is freed only when its payout is voided, not sent or failed).
CREATE UNIQUE INDEX "payout_items_market_id_seller_order_id_unfreed_key"
  ON "commission_payouts"."payout_items" ("market_id", "seller_order_id")
  WHERE "freed_at" IS NULL;

-- The payout run's read of what a seller's payouts hold.
CREATE INDEX "payout_items_market_id_seller_id_unfreed_idx"
  ON "commission_payouts"."payout_items" ("market_id", "seller_id")
  WHERE "freed_at" IS NULL;

-- Carry-over of package 6b: the active holds of a seller order, read by the payout run and the
-- seller's hold list (the seller read had its index "with its reader", package 6d).
CREATE INDEX "payout_holds_active_seller_order_idx"
  ON "commission_payouts"."payout_holds" ("market_id", "seller_order_id")
  WHERE "released_at" IS NULL AND "seller_order_id" IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Hand-written: guards
-- ---------------------------------------------------------------------------------------------

-- A payout changes by its state machine and nothing else: the money, the seller and the terms used
-- never change; the approval and payments' transfer id are written once; a final state never
-- changes. The transitions are those of design 3.6.
CREATE FUNCTION "commission_payouts"."payouts_guard_update"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  mutable text[] := ARRAY['state', 'approved_by', 'approved_at', 'approved_transfer_minor',
    'transfer_execution_id', 'outcome_code', 'instructing_at', 'abandoned_at', 'state_changed_at',
    'version'];
BEGIN
  IF (to_jsonb(NEW) - mutable) IS DISTINCT FROM (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'commission_payouts.payouts: only the state columns of a payout may change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."state" IN ('paid', 'failed', 'not-sent', 'voided', 'settled-by-netting') THEN
    RAISE EXCEPTION 'commission_payouts.payouts: a payout in a final state never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."state" <> OLD."state" AND NOT (
       (OLD."state" = 'pending' AND NEW."state" IN ('instructing', 'voided'))
    OR (OLD."state" = 'awaiting-approval' AND NEW."state" IN ('approved', 'voided'))
    OR (OLD."state" = 'approved' AND NEW."state" IN ('instructing', 'voided'))
    OR (OLD."state" = 'instructing' AND NEW."state" IN ('instructed', 'not-sent'))
    OR (OLD."state" = 'instructed' AND NEW."state" IN ('paid', 'failed'))) THEN
    RAISE EXCEPTION 'commission_payouts.payouts: % -> % is not a transition of a payout',
      OLD."state", NEW."state" USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."approved_by" IS NOT NULL AND (
       NEW."approved_by" IS DISTINCT FROM OLD."approved_by"
    OR NEW."approved_at" IS DISTINCT FROM OLD."approved_at"
    OR NEW."approved_transfer_minor" IS DISTINCT FROM OLD."approved_transfer_minor") THEN
    RAISE EXCEPTION 'commission_payouts.payouts: an approval is written once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."transfer_execution_id" IS NOT NULL
     AND NEW."transfer_execution_id" IS DISTINCT FROM OLD."transfer_execution_id" THEN
    RAISE EXCEPTION 'commission_payouts.payouts: the transfer id is written once'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."state" <> OLD."state" AND NEW."version" <= OLD."version" THEN
    RAISE EXCEPTION 'commission_payouts.payouts: a change of state raises the version'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "payouts_guard_update" BEFORE UPDATE ON "commission_payouts"."payouts"
  FOR EACH ROW EXECUTE FUNCTION "commission_payouts"."payouts_guard_update"();
CREATE TRIGGER "payouts_no_delete" BEFORE DELETE ON "commission_payouts"."payouts"
  FOR EACH ROW EXECUTE FUNCTION "commission_payouts"."reject_mutation"();
CREATE TRIGGER "payouts_no_truncate" BEFORE TRUNCATE ON "commission_payouts"."payouts"
  FOR EACH STATEMENT EXECUTE FUNCTION "commission_payouts"."reject_mutation"();

-- A payout that ends without paying frees its items in the same statement, so the seller orders
-- are proposed again: voided, not sent, or failed (the transfer did not arrive). A payout that is
-- paid, or settled by netting, keeps its items for good.
CREATE FUNCTION "commission_payouts"."payouts_free_items"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE "commission_payouts"."payout_items"
     SET "freed_at" = NEW."state_changed_at"
   WHERE "market_id" = NEW."market_id" AND "payout_id" = NEW."id" AND "freed_at" IS NULL;
  RETURN NULL;
END; $$;

CREATE TRIGGER "payouts_free_items" AFTER UPDATE OF "state" ON "commission_payouts"."payouts"
  FOR EACH ROW WHEN (NEW."state" IN ('voided', 'not-sent', 'failed') AND OLD."state" <> NEW."state")
  EXECUTE FUNCTION "commission_payouts"."payouts_free_items"();

-- The only change an item takes is its release, once.
CREATE FUNCTION "commission_payouts"."payout_items_guard_update"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD."freed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'commission_payouts.payout_items: a freed item never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."freed_at" IS NULL
     OR (to_jsonb(NEW) - 'freed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'freed_at') THEN
    RAISE EXCEPTION 'commission_payouts.payout_items: only the release of an item may change it'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "payout_items_guard_update" BEFORE UPDATE ON "commission_payouts"."payout_items"
  FOR EACH ROW EXECUTE FUNCTION "commission_payouts"."payout_items_guard_update"();
CREATE TRIGGER "payout_items_no_delete" BEFORE DELETE ON "commission_payouts"."payout_items"
  FOR EACH ROW EXECUTE FUNCTION "commission_payouts"."reject_mutation"();
CREATE TRIGGER "payout_items_no_truncate" BEFORE TRUNCATE ON "commission_payouts"."payout_items"
  FOR EACH STATEMENT EXECUTE FUNCTION "commission_payouts"."reject_mutation"();

-- gross = the sum of the items, checked at COMMIT, so a payout cannot be written without its items
-- or with items that do not add up.
CREATE FUNCTION "commission_payouts"."check_payout_items"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  target uuid;
  gross bigint;
  summed bigint;
BEGIN
  IF TG_TABLE_NAME = 'payouts' THEN target := NEW."id"; ELSE target := NEW."payout_id"; END IF;
  SELECT p."gross_minor" INTO gross FROM "commission_payouts"."payouts" p WHERE p."id" = target;
  SELECT COALESCE(SUM(i."amount_minor"), 0) INTO summed
    FROM "commission_payouts"."payout_items" i WHERE i."payout_id" = target;
  IF gross IS DISTINCT FROM summed THEN
    RAISE EXCEPTION 'commission_payouts.payouts: the gross of a payout is the sum of its items'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END; $$;

CREATE CONSTRAINT TRIGGER "payouts_items_sum" AFTER INSERT ON "commission_payouts"."payouts"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "commission_payouts"."check_payout_items"();
CREATE CONSTRAINT TRIGGER "payout_items_sum" AFTER INSERT ON "commission_payouts"."payout_items"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION "commission_payouts"."check_payout_items"();

-- A cursor's last slot only moves forward.
CREATE FUNCTION "commission_payouts"."payout_schedule_cursors_guard_update"() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW."last_slot_at" < OLD."last_slot_at" THEN
    RAISE EXCEPTION 'commission_payouts.payout_schedule_cursors: the last slot only moves forward'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - 'last_slot_at' - 'next_slot_at' - 'zone' - 'block_reason' - 'evaluated_at'
        - 'updated_at' - 'version')
     IS DISTINCT FROM
     (to_jsonb(OLD) - 'last_slot_at' - 'next_slot_at' - 'zone' - 'block_reason' - 'evaluated_at'
        - 'updated_at' - 'version') THEN
    RAISE EXCEPTION 'commission_payouts.payout_schedule_cursors: the identity of a cursor never changes'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "payout_schedule_cursors_guard_update"
  BEFORE UPDATE ON "commission_payouts"."payout_schedule_cursors"
  FOR EACH ROW EXECUTE FUNCTION "commission_payouts"."payout_schedule_cursors_guard_update"();
CREATE TRIGGER "payout_schedule_cursors_no_delete"
  BEFORE DELETE ON "commission_payouts"."payout_schedule_cursors"
  FOR EACH ROW EXECUTE FUNCTION "commission_payouts"."reject_mutation"();
CREATE TRIGGER "payout_schedule_cursors_no_truncate"
  BEFORE TRUNCATE ON "commission_payouts"."payout_schedule_cursors"
  FOR EACH STATEMENT EXECUTE FUNCTION "commission_payouts"."reject_mutation"();

-- ---------------------------------------------------------------------------------------------
-- Data: a cursor for every seller that already has an eligibility anchor
-- ---------------------------------------------------------------------------------------------

-- From now on a cursor is created with the seller's first anchor. The slots before this migration
-- belong to no payout run, so the last slot is now.
INSERT INTO "commission_payouts"."payout_schedule_cursors"
  ("market_id", "seller_id", "tenant_id", "last_slot_at", "updated_at", "version")
SELECT DISTINCT "market_id", "seller_id", "tenant_id", now(), now(), 1
  FROM "commission_payouts"."eligibility_anchors";

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------

-- A payout is inserted and moves through its states; an item is inserted and released (one
-- column); a cursor is inserted and moved (its slot columns, the reason and the version). No
-- DELETE anywhere.
GRANT SELECT, INSERT, UPDATE ("state", "approved_by", "approved_at", "approved_transfer_minor",
  "transfer_execution_id", "outcome_code", "instructing_at", "abandoned_at", "state_changed_at",
  "version") ON TABLE "commission_payouts"."payouts" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("freed_at")
  ON TABLE "commission_payouts"."payout_items" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("last_slot_at", "next_slot_at", "zone", "block_reason",
  "evaluated_at", "updated_at", "version")
  ON TABLE "commission_payouts"."payout_schedule_cursors" TO "mondapac_app";
