SET lock_timeout = '5s';
SET statement_timeout = '60s';
-- CreateTable
CREATE TABLE "catalog"."variant_requests" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "offer_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "option_values" JSONB NOT NULL,
    "option_key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "resolved_variant_id" UUID,
    "decline_reason" TEXT,
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "notice_state" TEXT NOT NULL,
    "notice_attempts" INTEGER NOT NULL,
    "notice_next_attempt_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "variant_requests_pkey" PRIMARY KEY ("market_id","id")
);

-- CreateIndex
-- The admin queue reads only open requests, oldest first: a partial index, written by hand
-- (Prisma cannot express it), replaces the full one.
CREATE INDEX "variant_requests_open_queue_idx" ON "catalog"."variant_requests"("market_id", "created_at", "id") WHERE "status" = 'open';

-- CreateIndex
CREATE INDEX "variant_requests_market_id_seller_id_status_id_idx" ON "catalog"."variant_requests"("market_id", "seller_id", "status", "id");

-- CreateIndex
-- Backs the foreign key checks on product deletes and updates; no store query reads it.
CREATE INDEX "variant_requests_market_id_product_id_idx" ON "catalog"."variant_requests"("market_id", "product_id");

-- AddForeignKey
ALTER TABLE "catalog"."variant_requests" ADD CONSTRAINT "variant_requests_market_id_offer_id_seller_id_fkey" FOREIGN KEY ("market_id", "offer_id", "seller_id") REFERENCES "catalog"."offers"("market_id", "id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."variant_requests" ADD CONSTRAINT "variant_requests_market_id_product_id_fkey" FOREIGN KEY ("market_id", "product_id") REFERENCES "catalog"."products"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."variant_requests" ADD CONSTRAINT "variant_requests_market_id_product_id_resolved_variant_id_fkey" FOREIGN KEY ("market_id", "product_id", "resolved_variant_id") REFERENCES "catalog"."product_variants"("market_id", "product_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Hand-written (database-designer): variants V7. A seller's request for a new variant (size) on a
-- PLATFORM product they sell: born open, decided once (approved, mapped or declined), then the
-- seller's mail is marked sent, skipped or failed. Nothing is deleted.

ALTER TABLE "catalog"."variant_requests"
  ADD CONSTRAINT "variant_requests_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "variant_requests_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  -- The option values: a non-empty object of option codes by attribute code (the use case keeps
  -- them to the product's axes, at most 2).
  ADD CONSTRAINT "variant_requests_option_values_check" CHECK (
    jsonb_typeof("option_values") = 'object' AND "option_values" <> '{}'::jsonb
    AND pg_column_size("option_values") <= 1024),
  ADD CONSTRAINT "variant_requests_decided_at_check" CHECK (
    "decided_at" IS NULL OR "decided_at" >= "created_at"),
  ADD CONSTRAINT "variant_requests_option_key_check" CHECK (
    char_length("option_key") BETWEEN 3 AND 400 AND "option_key" !~ '[[:cntrl:]]'),
  ADD CONSTRAINT "variant_requests_status_check" CHECK (
    "status" IN ('open', 'approved', 'mapped', 'declined')),
  ADD CONSTRAINT "variant_requests_decline_reason_check" CHECK (
    "decline_reason" IS NULL OR (
      "decline_reason" = btrim("decline_reason") AND char_length("decline_reason") BETWEEN 1 AND 300
      AND "decline_reason" !~ '[[:cntrl:]]')),
  -- The decision's shape: open has none; approved and mapped name a variant; declined gives a
  -- reason; every decided row names the deciding admin and the time.
  ADD CONSTRAINT "variant_requests_decision_check" CHECK (
    ("status" = 'open'
       AND "resolved_variant_id" IS NULL AND "decline_reason" IS NULL
       AND "decided_by_account_id" IS NULL AND "decided_at" IS NULL)
    OR ("status" IN ('approved', 'mapped')
       AND "resolved_variant_id" IS NOT NULL AND "decline_reason" IS NULL
       AND "decided_by_account_id" IS NOT NULL AND "decided_at" IS NOT NULL)
    OR ("status" = 'declined'
       AND "resolved_variant_id" IS NULL AND "decline_reason" IS NOT NULL
       AND "decided_by_account_id" IS NOT NULL AND "decided_at" IS NOT NULL)),
  ADD CONSTRAINT "variant_requests_notice_state_check" CHECK (
    "notice_state" IN ('none', 'pending', 'sent', 'skipped', 'failed')),
  -- An open request has no notice yet; a decided one always has one.
  ADD CONSTRAINT "variant_requests_notice_open_check" CHECK (
    ("status" = 'open') = ("notice_state" = 'none')),
  ADD CONSTRAINT "variant_requests_notice_attempts_check" CHECK ("notice_attempts" BETWEEN 0 AND 10),
  -- Only a pending notice waits for a time.
  ADD CONSTRAINT "variant_requests_notice_next_check" CHECK (
    ("notice_state" = 'pending') = ("notice_next_attempt_at" IS NOT NULL)),
  ADD CONSTRAINT "variant_requests_version_check" CHECK ("version" >= 1);

-- An Offer holds one waiting request per combination of option values.
CREATE UNIQUE INDEX "variant_requests_open_offer_option_key"
  ON "catalog"."variant_requests" ("market_id", "offer_id", "option_key")
  WHERE "status" = 'open';

-- The notice job's selection: pending notices by time.
CREATE INDEX "variant_requests_notice_due_idx"
  ON "catalog"."variant_requests" ("market_id", "notice_next_attempt_at", "id")
  WHERE "notice_state" = 'pending';

CREATE FUNCTION "catalog"."variant_requests_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog.variant_requests: DELETE is not allowed' USING ERRCODE = 'restrict_violation';
  END IF;
  -- A request is born open at version 1, with no decision and no notice, on an Offer that sells
  -- this PLATFORM product.
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.version <> 1 OR NEW.notice_attempts <> 0 THEN
      RAISE EXCEPTION 'catalog.variant_requests: a new request is open at version 1' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.created_at > statement_timestamp() + interval '5 minutes' THEN
      RAISE EXCEPTION 'catalog.variant_requests: created_at is in the future' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM "catalog"."offers" o
        JOIN "catalog"."products" p ON p."market_id" = o."market_id" AND p."id" = o."product_id"
       WHERE o."market_id" = NEW.market_id AND o."id" = NEW.offer_id
         AND o."product_id" = NEW.product_id AND o."status" <> 'deleted'
         AND p."scope" = 'PLATFORM') THEN
      RAISE EXCEPTION 'catalog.variant_requests: the Offer must sell this PLATFORM product' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.market_id, NEW.tenant_id, NEW.seller_id, NEW.offer_id, NEW.product_id,
      NEW.option_values, NEW.option_key, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.market_id, OLD.tenant_id, OLD.seller_id, OLD.offer_id, OLD.product_id,
      OLD.option_values, OLD.option_key, OLD.created_at) THEN
    RAISE EXCEPTION 'catalog.variant_requests: immutable column changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'catalog.variant_requests: version must rise by one' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'open' THEN
    -- The decision: the one move out of open; the notice starts pending.
    IF NEW.status = 'open' OR NEW.notice_state <> 'pending' OR NEW.notice_attempts <> 0 THEN
      RAISE EXCEPTION 'catalog.variant_requests: an open request is decided, and its notice starts pending' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.decided_at < statement_timestamp() - interval '5 minutes'
       OR NEW.decided_at > statement_timestamp() + interval '5 minutes' THEN
      RAISE EXCEPTION 'catalog.variant_requests: decided_at outside tolerance' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- A decided request never changes its decision; only its notice moves, and only from pending.
  IF (NEW.status, NEW.resolved_variant_id, NEW.decline_reason, NEW.decided_by_account_id, NEW.decided_at)
     IS DISTINCT FROM
     (OLD.status, OLD.resolved_variant_id, OLD.decline_reason, OLD.decided_by_account_id, OLD.decided_at) THEN
    RAISE EXCEPTION 'catalog.variant_requests: a decided request never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.notice_state <> 'pending' THEN
    RAISE EXCEPTION 'catalog.variant_requests: a settled notice never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.notice_attempts < OLD.notice_attempts THEN
    RAISE EXCEPTION 'catalog.variant_requests: notice attempts never go down' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "variant_requests_guard" BEFORE INSERT OR UPDATE OR DELETE
  ON "catalog"."variant_requests"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."variant_requests_guard"();
CREATE TRIGGER "variant_requests_no_truncate" BEFORE TRUNCATE
  ON "catalog"."variant_requests"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();

-- Grants (data design 7): the decision and the notice marker move; nothing else is updated and
-- nothing is deleted.
GRANT SELECT, INSERT, UPDATE ("status", "resolved_variant_id", "decline_reason",
  "decided_by_account_id", "decided_at", "notice_state", "notice_attempts",
  "notice_next_attempt_at", "version")
  ON TABLE "catalog"."variant_requests" TO "mondapac_app";
