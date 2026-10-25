-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "wallet";

-- CreateTable
CREATE TABLE "wallet"."accounts" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "customer_account_id" UUID,
    "currency" VARCHAR(3) NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet"."journals" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "actor_kind" TEXT NOT NULL,
    "actor_id" UUID,
    "reason_code" TEXT NOT NULL,
    "order_id" UUID,
    "wallet_account_id" UUID,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "journals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet"."postings" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "journal_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,

    CONSTRAINT "postings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet"."lots" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "wallet_account_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "journal_id" UUID NOT NULL,
    "original_minor" BIGINT NOT NULL,
    "remaining_minor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "lots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet"."holds" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "wallet_account_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "status" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet"."hold_lots" (
    "hold_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,

    CONSTRAINT "hold_lots_pkey" PRIMARY KEY ("market_id","hold_id","lot_id")
);

-- CreateTable
CREATE TABLE "wallet"."balances" (
    "wallet_account_id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "available_minor" BIGINT NOT NULL,
    "held_minor" BIGINT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "balances_pkey" PRIMARY KEY ("wallet_account_id")
);

-- CreateTable
CREATE TABLE "wallet"."market_settings" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason_code" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_account_id" UUID NOT NULL,

    CONSTRAINT "market_settings_pkey" PRIMARY KEY ("market_id")
);

-- CreateIndex
-- Hand-written: NULLS NOT DISTINCT, so each internal account kind exists once per Market.
CREATE UNIQUE INDEX "accounts_market_id_kind_customer_account_id_key" ON "wallet"."accounts"("market_id", "kind", "customer_account_id") NULLS NOT DISTINCT;

-- CreateIndex
CREATE INDEX "journals_market_id_wallet_account_id_created_at_id_idx" ON "wallet"."journals"("market_id", "wallet_account_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "journals_market_id_idempotency_key_key" ON "wallet"."journals"("market_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "postings_market_id_journal_id_idx" ON "wallet"."postings"("market_id", "journal_id");

-- CreateIndex
CREATE INDEX "postings_market_id_account_id_idx" ON "wallet"."postings"("market_id", "account_id");

-- CreateIndex
CREATE INDEX "lots_market_id_wallet_account_id_remaining_minor_idx" ON "wallet"."lots"("market_id", "wallet_account_id", "remaining_minor");

-- CreateIndex
CREATE INDEX "lots_market_id_source_expires_at_idx" ON "wallet"."lots"("market_id", "source", "expires_at");

-- CreateIndex
CREATE INDEX "holds_market_id_status_expires_at_idx" ON "wallet"."holds"("market_id", "status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "holds_market_id_order_id_key" ON "wallet"."holds"("market_id", "order_id");

-- CreateIndex
CREATE INDEX "hold_lots_market_id_lot_id_idx" ON "wallet"."hold_lots"("market_id", "lot_id");

-- CreateIndex
CREATE INDEX "balances_market_id_idx" ON "wallet"."balances"("market_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_market_id_id_key" ON "wallet"."accounts"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "journals_market_id_id_key" ON "wallet"."journals"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "lots_market_id_id_key" ON "wallet"."lots"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "holds_market_id_id_key" ON "wallet"."holds"("market_id", "id");

-- AddForeignKey
ALTER TABLE "wallet"."postings" ADD CONSTRAINT "postings_market_id_journal_id_fkey" FOREIGN KEY ("market_id", "journal_id") REFERENCES "wallet"."journals"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "wallet"."postings" ADD CONSTRAINT "postings_market_id_account_id_fkey" FOREIGN KEY ("market_id", "account_id") REFERENCES "wallet"."accounts"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "wallet"."lots" ADD CONSTRAINT "lots_market_id_wallet_account_id_fkey" FOREIGN KEY ("market_id", "wallet_account_id") REFERENCES "wallet"."accounts"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "wallet"."lots" ADD CONSTRAINT "lots_market_id_journal_id_fkey" FOREIGN KEY ("market_id", "journal_id") REFERENCES "wallet"."journals"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "wallet"."holds" ADD CONSTRAINT "holds_market_id_wallet_account_id_fkey" FOREIGN KEY ("market_id", "wallet_account_id") REFERENCES "wallet"."accounts"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "wallet"."hold_lots" ADD CONSTRAINT "hold_lots_market_id_hold_id_fkey" FOREIGN KEY ("market_id", "hold_id") REFERENCES "wallet"."holds"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "wallet"."hold_lots" ADD CONSTRAINT "hold_lots_market_id_lot_id_fkey" FOREIGN KEY ("market_id", "lot_id") REFERENCES "wallet"."lots"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "wallet"."balances" ADD CONSTRAINT "balances_market_id_wallet_account_id_fkey" FOREIGN KEY ("market_id", "wallet_account_id") REFERENCES "wallet"."accounts"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "wallet"."journals" ADD CONSTRAINT "journals_market_id_wallet_account_id_fkey" FOREIGN KEY ("market_id", "wallet_account_id") REFERENCES "wallet"."accounts"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: scope and value checks.
ALTER TABLE "wallet"."accounts"
  ADD CONSTRAINT "accounts_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "accounts_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "accounts_kind_check" CHECK ("kind" IN ('credit_liability', 'promo_expense', 'refund_clearing', 'order_clearing', 'holds', 'breakage_income')),
  ADD CONSTRAINT "accounts_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "accounts_status_check" CHECK ("status" IN ('active', 'frozen', 'closed')),
  ADD CONSTRAINT "accounts_customer_check" CHECK (("kind" = 'credit_liability') = ("customer_account_id" IS NOT NULL));

ALTER TABLE "wallet"."journals"
  ADD CONSTRAINT "journals_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "journals_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "journals_kind_check" CHECK ("kind" IN ('grant-promo', 'grant-refund', 'hold', 'capture', 'release', 'expire', 'reverse')),
  ADD CONSTRAINT "journals_actor_check" CHECK (("actor_kind" IN ('admin', 'customer') AND "actor_id" IS NOT NULL) OR ("actor_kind" = 'system' AND "actor_id" IS NULL)),
  ADD CONSTRAINT "journals_idempotency_key_check" CHECK (char_length("idempotency_key") BETWEEN 8 AND 128),
  ADD CONSTRAINT "journals_reason_code_check" CHECK ("reason_code" ~ '^[a-z][a-z0-9-]{1,39}$');

ALTER TABLE "wallet"."postings"
  ADD CONSTRAINT "postings_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "postings_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "postings_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "postings_amount_check" CHECK ("amount_minor" <> 0);

ALTER TABLE "wallet"."lots"
  ADD CONSTRAINT "lots_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "lots_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "lots_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "lots_source_check" CHECK ("source" IN ('promo', 'refund')),
  ADD CONSTRAINT "lots_original_check" CHECK ("original_minor" > 0),
  ADD CONSTRAINT "lots_remaining_check" CHECK ("remaining_minor" >= 0 AND "remaining_minor" <= "original_minor"),
  -- Promo credit expires; refund credit never does.
  ADD CONSTRAINT "lots_expiry_check" CHECK (("source" = 'promo') = ("expires_at" IS NOT NULL));

ALTER TABLE "wallet"."holds"
  ADD CONSTRAINT "holds_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "holds_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "holds_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "holds_amount_check" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "holds_status_check" CHECK ("status" IN ('held', 'captured', 'released', 'expired')),
  ADD CONSTRAINT "holds_resolved_check" CHECK (("status" = 'held') = ("resolved_at" IS NULL));

ALTER TABLE "wallet"."hold_lots"
  ADD CONSTRAINT "hold_lots_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "hold_lots_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "hold_lots_amount_check" CHECK ("amount_minor" > 0);

ALTER TABLE "wallet"."balances"
  ADD CONSTRAINT "balances_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "balances_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "balances_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "balances_available_check" CHECK ("available_minor" >= 0),
  ADD CONSTRAINT "balances_held_check" CHECK ("held_minor" >= 0);

ALTER TABLE "wallet"."market_settings"
  ADD CONSTRAINT "market_settings_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "market_settings_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "market_settings_status_check" CHECK ("status" IN ('off', 'active', 'paused', 'frozen')),
  -- A wind-down or an emergency always says why.
  ADD CONSTRAINT "market_settings_reason_check" CHECK (("status" IN ('paused', 'frozen')) = ("reason_code" IS NOT NULL)),
  ADD CONSTRAINT "market_settings_reason_code_check" CHECK ("reason_code" IS NULL OR "reason_code" ~ '^[a-z][a-z0-9-]{1,39}$');

-- Hand-written: insert-only tables. No row of the journal, its legs or a hold's lots is ever
-- changed or removed, whoever asks. No wallet table is ever deleted from or truncated. A balance,
-- a lot or a hold can be updated (the columns granted below), but never without the journal that
-- explains it: the deferred constraint triggers further down check the books at COMMIT.
CREATE FUNCTION "wallet"."reject_mutation"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'wallet.%: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END; $$;

CREATE TRIGGER "journals_no_update" BEFORE UPDATE ON "wallet"."journals"
  FOR EACH ROW EXECUTE FUNCTION "wallet"."reject_mutation"();
CREATE TRIGGER "journals_no_delete" BEFORE DELETE ON "wallet"."journals"
  FOR EACH ROW EXECUTE FUNCTION "wallet"."reject_mutation"();
CREATE TRIGGER "journals_no_truncate" BEFORE TRUNCATE ON "wallet"."journals"
  FOR EACH STATEMENT EXECUTE FUNCTION "wallet"."reject_mutation"();
CREATE TRIGGER "postings_no_update" BEFORE UPDATE ON "wallet"."postings"
  FOR EACH ROW EXECUTE FUNCTION "wallet"."reject_mutation"();
CREATE TRIGGER "postings_no_delete" BEFORE DELETE ON "wallet"."postings"
  FOR EACH ROW EXECUTE FUNCTION "wallet"."reject_mutation"();
CREATE TRIGGER "postings_no_truncate" BEFORE TRUNCATE ON "wallet"."postings"
  FOR EACH STATEMENT EXECUTE FUNCTION "wallet"."reject_mutation"();
CREATE TRIGGER "hold_lots_no_update" BEFORE UPDATE ON "wallet"."hold_lots"
  FOR EACH ROW EXECUTE FUNCTION "wallet"."reject_mutation"();
CREATE TRIGGER "hold_lots_no_delete" BEFORE DELETE ON "wallet"."hold_lots"
  FOR EACH ROW EXECUTE FUNCTION "wallet"."reject_mutation"();
CREATE TRIGGER "hold_lots_no_truncate" BEFORE TRUNCATE ON "wallet"."hold_lots"
  FOR EACH STATEMENT EXECUTE FUNCTION "wallet"."reject_mutation"();
CREATE TRIGGER "accounts_no_delete" BEFORE DELETE ON "wallet"."accounts"
  FOR EACH ROW EXECUTE FUNCTION "wallet"."reject_mutation"();
CREATE TRIGGER "accounts_no_truncate" BEFORE TRUNCATE ON "wallet"."accounts"
  FOR EACH STATEMENT EXECUTE FUNCTION "wallet"."reject_mutation"();
CREATE TRIGGER "lots_no_delete" BEFORE DELETE ON "wallet"."lots"
  FOR EACH ROW EXECUTE FUNCTION "wallet"."reject_mutation"();
CREATE TRIGGER "lots_no_truncate" BEFORE TRUNCATE ON "wallet"."lots"
  FOR EACH STATEMENT EXECUTE FUNCTION "wallet"."reject_mutation"();
CREATE TRIGGER "holds_no_delete" BEFORE DELETE ON "wallet"."holds"
  FOR EACH ROW EXECUTE FUNCTION "wallet"."reject_mutation"();
CREATE TRIGGER "holds_no_truncate" BEFORE TRUNCATE ON "wallet"."holds"
  FOR EACH STATEMENT EXECUTE FUNCTION "wallet"."reject_mutation"();
CREATE TRIGGER "balances_no_delete" BEFORE DELETE ON "wallet"."balances"
  FOR EACH ROW EXECUTE FUNCTION "wallet"."reject_mutation"();
CREATE TRIGGER "balances_no_truncate" BEFORE TRUNCATE ON "wallet"."balances"
  FOR EACH STATEMENT EXECUTE FUNCTION "wallet"."reject_mutation"();
CREATE TRIGGER "market_settings_no_delete" BEFORE DELETE ON "wallet"."market_settings"
  FOR EACH ROW EXECUTE FUNCTION "wallet"."reject_mutation"();
CREATE TRIGGER "market_settings_no_truncate" BEFORE TRUNCATE ON "wallet"."market_settings"
  FOR EACH STATEMENT EXECUTE FUNCTION "wallet"."reject_mutation"();

-- Hand-written: the legs of one journal sum to zero and are at least two. Checked at commit
-- (DEFERRABLE INITIALLY DEFERRED), from the journal row and from every posting row, so a journal
-- with no legs is refused too.
CREATE FUNCTION "wallet"."check_journal_balanced"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  target uuid;
  total numeric;
  legs integer;
BEGIN
  IF TG_TABLE_NAME = 'journals' THEN target := NEW."id"; ELSE target := NEW."journal_id"; END IF;
  SELECT COALESCE(SUM("amount_minor"), 0), COUNT(*) INTO total, legs
    FROM "wallet"."postings" WHERE "journal_id" = target;
  IF legs < 2 OR total <> 0 THEN
    RAISE EXCEPTION 'wallet.journal %: unbalanced (% legs, sum %)', target, legs, total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END; $$;

CREATE CONSTRAINT TRIGGER "journals_balanced" AFTER INSERT ON "wallet"."journals"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "wallet"."check_journal_balanced"();
CREATE CONSTRAINT TRIGGER "postings_balanced" AFTER INSERT ON "wallet"."postings"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "wallet"."check_journal_balanced"();

-- Hand-written: a lot changes only in `remaining_minor`, which only decreases, except that a
-- released or expired hold gives back what it took (never more than the lot's original less what
-- other holds still hold or have captured).
CREATE FUNCTION "wallet"."guard_lot_update"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  outstanding numeric;
BEGIN
  IF (to_jsonb(NEW) - 'remaining_minor') <> (to_jsonb(OLD) - 'remaining_minor') THEN
    RAISE EXCEPTION 'wallet.lots: only remaining_minor may change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."remaining_minor" > OLD."remaining_minor" THEN
    IF NOT EXISTS (
      SELECT 1 FROM "wallet"."hold_lots" hl JOIN "wallet"."holds" h ON h."id" = hl."hold_id"
       WHERE hl."lot_id" = NEW."id" AND h."status" IN ('released', 'expired')
    ) THEN
      RAISE EXCEPTION 'wallet.lots: remaining_minor only decreases' USING ERRCODE = 'restrict_violation';
    END IF;
    SELECT COALESCE(SUM(hl."amount_minor"), 0) INTO outstanding
      FROM "wallet"."hold_lots" hl JOIN "wallet"."holds" h ON h."id" = hl."hold_id"
     WHERE hl."lot_id" = NEW."id" AND h."status" IN ('held', 'captured');
    IF NEW."remaining_minor" + outstanding > NEW."original_minor" THEN
      RAISE EXCEPTION 'wallet.lots: restore exceeds what the holds took' USING ERRCODE = 'restrict_violation';
    END IF;
    -- Expired promo credit does not come back, unless this same transaction is releasing a hold
    -- that took from the lot (the next sweep expires the restored credit again).
    IF NEW."expires_at" IS NOT NULL AND NEW."expires_at" <= now() AND NOT EXISTS (
      SELECT 1 FROM "wallet"."hold_lots" hl JOIN "wallet"."holds" h
          ON h."market_id" = hl."market_id" AND h."id" = hl."hold_id"
       WHERE hl."market_id" = NEW."market_id" AND hl."lot_id" = NEW."id"
         AND h."status" IN ('released', 'expired')
         AND h."xmin"::text = pg_current_xact_id()::xid::text
    ) THEN
      RAISE EXCEPTION 'wallet.lots: expired credit does not come back' USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "lots_guard_update" BEFORE UPDATE ON "wallet"."lots"
  FOR EACH ROW EXECUTE FUNCTION "wallet"."guard_lot_update"();

-- Hand-written: a hold leaves `held` once, for captured, released or expired; nothing else changes.
CREATE FUNCTION "wallet"."guard_hold_update"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status' - 'resolved_at') <> (to_jsonb(OLD) - 'status' - 'resolved_at') THEN
    RAISE EXCEPTION 'wallet.holds: only status may change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" <> 'held' OR NEW."status" = 'held' THEN
    RAISE EXCEPTION 'wallet.holds: a settled hold does not change' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "holds_guard_update" BEFORE UPDATE ON "wallet"."holds"
  FOR EACH ROW EXECUTE FUNCTION "wallet"."guard_hold_update"();

-- Hand-written: a hold is born `held`, and its lots are written in the transaction that creates
-- it. So a hold cannot be inserted already settled, nor given lots later.
CREATE FUNCTION "wallet"."guard_hold_insert"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW."status" <> 'held' OR NEW."resolved_at" IS NOT NULL THEN
    RAISE EXCEPTION 'wallet.holds: a hold is created held' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "holds_guard_insert" BEFORE INSERT ON "wallet"."holds"
  FOR EACH ROW EXECUTE FUNCTION "wallet"."guard_hold_insert"();

CREATE FUNCTION "wallet"."guard_hold_lot_insert"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "wallet"."holds" h
     WHERE h."market_id" = NEW."market_id" AND h."id" = NEW."hold_id" AND h."status" = 'held'
       AND h."xmin"::text = pg_current_xact_id()::xid::text
  ) THEN
    RAISE EXCEPTION 'wallet.hold_lots: lots are written with the held hold that takes them'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "hold_lots_guard_insert" BEFORE INSERT ON "wallet"."hold_lots"
  FOR EACH ROW EXECUTE FUNCTION "wallet"."guard_hold_lot_insert"();

-- Hand-written: an account changes only its status, and a closed account never reopens.
CREATE FUNCTION "wallet"."guard_account_update"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - 'status') <> (to_jsonb(OLD) - 'status') THEN
    RAISE EXCEPTION 'wallet.accounts: only status may change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" = 'closed' AND NEW."status" <> 'closed' THEN
    RAISE EXCEPTION 'wallet.accounts: a closed account does not reopen' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "accounts_guard_update" BEFORE UPDATE ON "wallet"."accounts"
  FOR EACH ROW EXECUTE FUNCTION "wallet"."guard_account_update"();

-- Hand-written: the Market switch may not go back to `off` once the Market has any journal;
-- the wind-down state is `paused`.
CREATE FUNCTION "wallet"."guard_market_setting_update"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW."status" = 'off' AND OLD."status" <> 'off'
     AND EXISTS (SELECT 1 FROM "wallet"."journals" WHERE "market_id" = NEW."market_id") THEN
    RAISE EXCEPTION 'wallet.market_settings: cannot turn off with history' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "market_settings_guard_update" BEFORE UPDATE ON "wallet"."market_settings"
  FOR EACH ROW EXECUTE FUNCTION "wallet"."guard_market_setting_update"();

-- Hand-written: a balance, a lot or a hold changes only together with the journal that explains it.
-- Checked at COMMIT (DEFERRABLE INITIALLY DEFERRED), per affected customer wallet, from the
-- balance, lot, hold and posting rows: available = the postings on the wallet account = the
-- lots' remaining credit, and held = the held holds. A direct UPDATE of one of them, by anyone,
-- fails the commit.
CREATE FUNCTION "wallet"."check_wallet_books"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  wallet_id uuid;
  account_kind text;
  available numeric;
  held numeric;
  posted numeric;
  lotted numeric;
  holding numeric;
  held_posted numeric;
BEGIN
  IF TG_TABLE_NAME = 'postings' THEN
    SELECT a."kind" INTO account_kind FROM "wallet"."accounts" a
     WHERE a."market_id" = NEW."market_id" AND a."id" = NEW."account_id";
    IF account_kind = 'credit_liability' THEN
      wallet_id := NEW."account_id";
    ELSIF account_kind = 'holds' THEN
      -- A leg on the Market's holds account belongs to the journal of one customer wallet.
      SELECT j."wallet_account_id" INTO wallet_id FROM "wallet"."journals" j
       WHERE j."market_id" = NEW."market_id" AND j."id" = NEW."journal_id";
      IF wallet_id IS NULL THEN
        RAISE EXCEPTION 'wallet.books: a holds leg needs a journal of a customer wallet'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      RETURN NULL;
    END IF;
  ELSE
    wallet_id := NEW."wallet_account_id";
    SELECT a."kind" INTO account_kind FROM "wallet"."accounts" a
     WHERE a."market_id" = NEW."market_id" AND a."id" = wallet_id;
    IF account_kind IS DISTINCT FROM 'credit_liability' THEN RETURN NULL; END IF;
  END IF;
  SELECT COALESCE(MAX(b."available_minor"), 0), COALESCE(MAX(b."held_minor"), 0) INTO available, held
    FROM "wallet"."balances" b WHERE b."market_id" = NEW."market_id" AND b."wallet_account_id" = wallet_id;
  SELECT COALESCE(SUM(p."amount_minor"), 0) INTO posted FROM "wallet"."postings" p
   WHERE p."market_id" = NEW."market_id" AND p."account_id" = wallet_id;
  SELECT COALESCE(SUM(l."remaining_minor"), 0) INTO lotted FROM "wallet"."lots" l
   WHERE l."market_id" = NEW."market_id" AND l."wallet_account_id" = wallet_id;
  SELECT COALESCE(SUM(h."amount_minor"), 0) INTO holding FROM "wallet"."holds" h
   WHERE h."market_id" = NEW."market_id" AND h."wallet_account_id" = wallet_id AND h."status" = 'held';
  -- What this wallet's journals put on the Market's holds account is what its held holds hold.
  SELECT COALESCE(SUM(p."amount_minor"), 0) INTO held_posted
    FROM "wallet"."journals" j
    JOIN "wallet"."postings" p ON p."market_id" = j."market_id" AND p."journal_id" = j."id"
    JOIN "wallet"."accounts" a ON a."market_id" = p."market_id" AND a."id" = p."account_id"
   WHERE j."market_id" = NEW."market_id" AND j."wallet_account_id" = wallet_id AND a."kind" = 'holds';
  IF available <> posted OR available <> lotted OR held <> holding OR held <> held_posted THEN
    RAISE EXCEPTION 'wallet.books of %: available % postings % lots %, held % holds % holds-account %',
      wallet_id, available, posted, lotted, held, holding, held_posted USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END; $$;

CREATE CONSTRAINT TRIGGER "balances_books" AFTER INSERT OR UPDATE ON "wallet"."balances"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "wallet"."check_wallet_books"();
CREATE CONSTRAINT TRIGGER "lots_books" AFTER INSERT OR UPDATE ON "wallet"."lots"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "wallet"."check_wallet_books"();
CREATE CONSTRAINT TRIGGER "holds_books" AFTER INSERT OR UPDATE ON "wallet"."holds"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "wallet"."check_wallet_books"();
CREATE CONSTRAINT TRIGGER "postings_books" AFTER INSERT ON "wallet"."postings"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "wallet"."check_wallet_books"();

-- Hand-written: a hold leaves `held` only with a capture (for captured) or release (for released
-- and expired) journal of this very hold, written in the same transaction. Checked at COMMIT.
CREATE FUNCTION "wallet"."check_hold_settled"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD."status" = 'held' AND NEW."status" <> 'held' AND NOT EXISTS (
    SELECT 1 FROM "wallet"."journals" j
     WHERE j."market_id" = NEW."market_id" AND j."order_id" = NEW."order_id"
       AND j."wallet_account_id" = NEW."wallet_account_id"
       AND j."kind" = CASE WHEN NEW."status" = 'captured' THEN 'capture' ELSE 'release' END
       AND j."result" ->> 'holdId' = NEW."id"::text
       AND j."xmin"::text = pg_current_xact_id()::xid::text
  ) THEN
    RAISE EXCEPTION 'wallet.holds %: left held without a % journal in this transaction', NEW."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END; $$;

CREATE CONSTRAINT TRIGGER "holds_settled" AFTER UPDATE ON "wallet"."holds"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "wallet"."check_hold_settled"();

-- Hand-written: a leg is in the currency of its account and of the other legs of its journal.
CREATE FUNCTION "wallet"."check_posting_currency"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "wallet"."accounts" a
              WHERE a."market_id" = NEW."market_id" AND a."id" = NEW."account_id"
                AND a."currency" <> NEW."currency")
     OR EXISTS (SELECT 1 FROM "wallet"."postings" p
                 WHERE p."market_id" = NEW."market_id" AND p."journal_id" = NEW."journal_id"
                   AND p."currency" <> NEW."currency") THEN
    RAISE EXCEPTION 'wallet.postings: currency % differs from its account or its journal', NEW."currency"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "postings_currency" BEFORE INSERT ON "wallet"."postings"
  FOR EACH ROW EXECUTE FUNCTION "wallet"."check_posting_currency"();

-- Hand-written: the switch is a fence at the database. A journal is inserted only if the Market's
-- status allows its kind, and the status row is read FOR SHARE: a status change waits for the
-- journals in flight, and a journal waits for a status change in flight and then reads the new
-- status. The same lock makes "never back to off with history" race-free, together with the
-- guard above. A Market with no settings row is `off`.
--   active: everything; paused: capture, release, expire; frozen: release, expire; off: nothing.
CREATE FUNCTION "wallet"."check_market_status"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  current_status text;
BEGIN
  SELECT s."status" INTO current_status FROM "wallet"."market_settings" s
   WHERE s."market_id" = NEW."market_id" FOR SHARE;
  current_status := COALESCE(current_status, 'off');
  IF current_status = 'active'
     OR (current_status = 'paused' AND NEW."kind" IN ('capture', 'release', 'expire'))
     OR (current_status = 'frozen' AND NEW."kind" IN ('release', 'expire')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'wallet.market_status: % refuses a % journal', current_status, NEW."kind"
    USING ERRCODE = 'restrict_violation';
END; $$;

CREATE TRIGGER "journals_market_status" BEFORE INSERT ON "wallet"."journals"
  FOR EACH ROW EXECUTE FUNCTION "wallet"."check_market_status"();

-- Grants. Journals, legs and a hold's lots are read and appended to only; every other table
-- changes only the columns named. Nothing is ever deleted.
GRANT USAGE ON SCHEMA "wallet" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "wallet"."journals" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "wallet"."postings" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "wallet"."hold_lots" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("status") ON TABLE "wallet"."accounts" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("remaining_minor") ON TABLE "wallet"."lots" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("status", "resolved_at") ON TABLE "wallet"."holds" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("available_minor", "held_minor", "updated_at") ON TABLE "wallet"."balances" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("status", "reason_code", "updated_at", "updated_by_account_id") ON TABLE "wallet"."market_settings" TO "mondapac_app";
