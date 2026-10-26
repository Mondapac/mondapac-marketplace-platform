-- CreateTable
CREATE TABLE "wallet"."admin_credit_requests" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "customer_account_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "reason_code" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL,
    "approval_reason" TEXT,
    "requested_by_account_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "local_day" DATE NOT NULL,
    "expires_at" TIMESTAMPTZ(6),
    "idempotency_key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_reason_code" TEXT,
    "journal_id" UUID,

    CONSTRAINT "admin_credit_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet"."admin_credit_days" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "admin_account_id" UUID NOT NULL,
    "local_day" DATE NOT NULL,
    "locked_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "admin_credit_days_pkey" PRIMARY KEY ("market_id","admin_account_id","local_day")
);

-- CreateIndex
CREATE INDEX "admin_credit_requests_market_id_requested_by_account_id_loc_idx" ON "wallet"."admin_credit_requests"("market_id", "requested_by_account_id", "local_day", "status", "amount_minor");

-- CreateIndex
CREATE INDEX "admin_credit_requests_market_id_status_requested_at_id_idx" ON "wallet"."admin_credit_requests"("market_id", "status", "requested_at" DESC, "id" DESC);

-- CreateIndex
-- Hand-written: partial, the pending requests only (the expiry sweep).
CREATE INDEX "admin_credit_requests_market_id_expires_at_id_idx" ON "wallet"."admin_credit_requests"("market_id", "expires_at", "id") WHERE "status" = 'pending';

-- CreateIndex
CREATE UNIQUE INDEX "admin_credit_requests_market_id_id_key" ON "wallet"."admin_credit_requests"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_credit_requests_market_id_journal_id_key" ON "wallet"."admin_credit_requests"("market_id", "journal_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_credit_requests_market_id_idempotency_key_key" ON "wallet"."admin_credit_requests"("market_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "wallet"."admin_credit_requests" ADD CONSTRAINT "admin_credit_requests_market_id_journal_id_fkey" FOREIGN KEY ("market_id", "journal_id") REFERENCES "wallet"."journals"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: the CHECKs. Every status carries exactly the columns it needs, and the admin who
-- asked never decides (maker-checker).
ALTER TABLE "wallet"."admin_credit_requests"
  ADD CONSTRAINT "admin_credit_requests_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "admin_credit_requests_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "admin_credit_requests_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "admin_credit_requests_amount_check" CHECK ("amount_minor" > 0),
  ADD CONSTRAINT "admin_credit_requests_reason_code_check" CHECK ("reason_code" IN ('goodwill', 'service-recovery', 'promotion', 'correction')),
  ADD CONSTRAINT "admin_credit_requests_note_check" CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 500),
  ADD CONSTRAINT "admin_credit_requests_status_check" CHECK ("status" IN ('granted', 'pending', 'approved', 'rejected', 'expired')),
  ADD CONSTRAINT "admin_credit_requests_approval_reason_check" CHECK (("status" = 'granted') = ("approval_reason" IS NULL) AND ("approval_reason" IS NULL OR "approval_reason" IN ('issue-cap', 'daily-cap'))),
  ADD CONSTRAINT "admin_credit_requests_expires_at_check" CHECK (("status" = 'granted') = ("expires_at" IS NULL) AND ("expires_at" IS NULL OR "expires_at" > "requested_at")),
  ADD CONSTRAINT "admin_credit_requests_journal_check" CHECK (("status" IN ('granted', 'approved')) = ("journal_id" IS NOT NULL)),
  ADD CONSTRAINT "admin_credit_requests_decided_at_check" CHECK (("status" IN ('approved', 'rejected', 'expired')) = ("decided_at" IS NOT NULL)),
  ADD CONSTRAINT "admin_credit_requests_decided_by_check" CHECK (("status" IN ('approved', 'rejected')) = ("decided_by_account_id" IS NOT NULL)),
  ADD CONSTRAINT "admin_credit_requests_maker_checker_check" CHECK ("decided_by_account_id" IS NULL OR "decided_by_account_id" <> "requested_by_account_id"),
  ADD CONSTRAINT "admin_credit_requests_decision_reason_check" CHECK (("status" = 'rejected') = ("decision_reason_code" IS NOT NULL) AND ("decision_reason_code" IS NULL OR "decision_reason_code" IN ('not-justified', 'amount-too-high', 'duplicate', 'wrong-customer', 'policy'))),
  ADD CONSTRAINT "admin_credit_requests_idempotency_key_check" CHECK (char_length("idempotency_key") BETWEEN 8 AND 128);

ALTER TABLE "wallet"."admin_credit_days"
  ADD CONSTRAINT "admin_credit_days_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "admin_credit_days_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$');

-- Hand-written: no request and no day row is ever deleted or truncated, whoever asks.
CREATE TRIGGER "admin_credit_requests_no_delete" BEFORE DELETE ON "wallet"."admin_credit_requests"
  FOR EACH ROW EXECUTE FUNCTION "wallet"."reject_mutation"();
CREATE TRIGGER "admin_credit_requests_no_truncate" BEFORE TRUNCATE ON "wallet"."admin_credit_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION "wallet"."reject_mutation"();
CREATE TRIGGER "admin_credit_days_no_delete" BEFORE DELETE ON "wallet"."admin_credit_days"
  FOR EACH ROW EXECUTE FUNCTION "wallet"."reject_mutation"();
CREATE TRIGGER "admin_credit_days_no_truncate" BEFORE TRUNCATE ON "wallet"."admin_credit_days"
  FOR EACH STATEMENT EXECUTE FUNCTION "wallet"."reject_mutation"();

-- Hand-written: a request is born `granted` (with its grant journal) or `pending` (no journal),
-- only while the Market's wallet is `active` (the switch row read FOR SHARE, as the journals'
-- fence), and the journal it names is a promo grant.
CREATE FUNCTION "wallet"."guard_admin_credit_insert"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  current_status text;
BEGIN
  IF NEW."status" NOT IN ('granted', 'pending') OR NEW."decided_at" IS NOT NULL THEN
    RAISE EXCEPTION 'wallet.admin_credit_requests: a request is born granted or pending'
      USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT s."status" INTO current_status FROM "wallet"."market_settings" s
   WHERE s."market_id" = NEW."market_id" FOR SHARE;
  IF COALESCE(current_status, 'off') <> 'active' THEN
    RAISE EXCEPTION 'wallet.market_status: % refuses an admin credit request', COALESCE(current_status, 'off')
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "admin_credit_requests_guard_insert" BEFORE INSERT ON "wallet"."admin_credit_requests"
  FOR EACH ROW EXECUTE FUNCTION "wallet"."guard_admin_credit_insert"();

-- Hand-written: a pending request is decided once, to approved, rejected or expired; only the
-- decision's columns change. An update that changes nothing (the row lock) is let through.
CREATE FUNCTION "wallet"."guard_admin_credit_update"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF to_jsonb(NEW) = to_jsonb(OLD) THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'decided_by_account_id' - 'decided_at' - 'decision_reason_code' - 'journal_id')
     <> (to_jsonb(OLD) - 'status' - 'decided_by_account_id' - 'decided_at' - 'decision_reason_code' - 'journal_id') THEN
    RAISE EXCEPTION 'wallet.admin_credit_requests: only the decision may change' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" <> 'pending' OR NEW."status" NOT IN ('approved', 'rejected', 'expired') THEN
    RAISE EXCEPTION 'wallet.admin_credit_requests: only a pending request is decided, once' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "admin_credit_requests_guard_update" BEFORE UPDATE ON "wallet"."admin_credit_requests"
  FOR EACH ROW EXECUTE FUNCTION "wallet"."guard_admin_credit_update"();

-- Hand-written: the journal a request names is a promo grant of the same customer's wallet, for
-- the request's amount, written in the same transaction as the decision or the issue.
CREATE FUNCTION "wallet"."guard_admin_credit_journal"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW."journal_id" IS NULL OR (TG_OP = 'UPDATE' AND NEW."journal_id" IS NOT DISTINCT FROM OLD."journal_id") THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "wallet"."journals" j
      JOIN "wallet"."accounts" a ON a."market_id" = j."market_id" AND a."id" = j."wallet_account_id"
      JOIN "wallet"."postings" p ON p."market_id" = j."market_id" AND p."journal_id" = j."id"
       AND p."account_id" = j."wallet_account_id"
     WHERE j."market_id" = NEW."market_id" AND j."id" = NEW."journal_id"
       AND j."kind" = 'grant-promo' AND j."xmin"::text = pg_current_xact_id()::xid::text
       AND a."customer_account_id" = NEW."customer_account_id"
       AND p."amount_minor" = NEW."amount_minor" AND p."currency" = NEW."currency") THEN
    RAISE EXCEPTION 'wallet.admin_credit_requests: the journal is not this request''s grant'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER "admin_credit_requests_guard_journal" BEFORE INSERT OR UPDATE ON "wallet"."admin_credit_requests"
  FOR EACH ROW EXECUTE FUNCTION "wallet"."guard_admin_credit_journal"();

-- Grants. A request is written once and decided once (the decision's columns); a day row is
-- written once and then only locked. Nothing is ever deleted.
GRANT SELECT, INSERT, UPDATE ("status", "decided_by_account_id", "decided_at", "decision_reason_code", "journal_id") ON TABLE "wallet"."admin_credit_requests" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("locked_at") ON TABLE "wallet"."admin_credit_days" TO "mondapac_app";
