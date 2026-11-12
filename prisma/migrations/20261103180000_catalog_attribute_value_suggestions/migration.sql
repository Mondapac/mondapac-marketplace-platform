SET lock_timeout = '5s';
SET statement_timeout = '60s';
-- CreateTable
CREATE TABLE "catalog"."attribute_value_suggestions" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "definition_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "option_code" TEXT,
    "reject_reason" TEXT,
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "notice_state" TEXT NOT NULL,
    "notice_attempts" INTEGER NOT NULL,
    "notice_next_attempt_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "attribute_value_suggestions_pkey" PRIMARY KEY ("market_id","id")
);

-- CreateIndex
CREATE INDEX "attribute_value_suggestions_market_id_status_created_at_idx" ON "catalog"."attribute_value_suggestions"("market_id", "status", "created_at", "id");

-- CreateIndex
CREATE INDEX "attribute_value_suggestions_market_id_seller_id_status_idx" ON "catalog"."attribute_value_suggestions"("market_id", "seller_id", "status");

-- CreateIndex
CREATE INDEX "attribute_value_suggestions_market_id_product_id_idx" ON "catalog"."attribute_value_suggestions"("market_id", "product_id");

-- AddForeignKey
ALTER TABLE "catalog"."attribute_value_suggestions" ADD CONSTRAINT "attribute_value_suggestions_market_id_definition_id_fkey" FOREIGN KEY ("market_id", "definition_id") REFERENCES "catalog"."attribute_definitions"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."attribute_value_suggestions" ADD CONSTRAINT "attribute_value_suggestions_market_id_product_id_fkey" FOREIGN KEY ("market_id", "product_id") REFERENCES "catalog"."products"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (database-designer): catalog data design 3.30, attributes package A5. A seller's
-- suggestion of a new value for a select attribute: born open, decided once (approved, mapped or
-- rejected), then the seller's mail is marked sent, skipped or failed. Nothing is deleted.

ALTER TABLE "catalog"."attribute_value_suggestions"
  ADD CONSTRAINT "attribute_value_suggestions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "attribute_value_suggestions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  -- The seller's own text: trimmed, 1 to 120 characters, no control character.
  ADD CONSTRAINT "attribute_value_suggestions_label_check" CHECK (
    "label" = btrim("label") AND char_length("label") BETWEEN 1 AND 120 AND "label" !~ '[[:cntrl:]]'),
  ADD CONSTRAINT "attribute_value_suggestions_status_check" CHECK (
    "status" IN ('open', 'approved', 'mapped', 'rejected')),
  ADD CONSTRAINT "attribute_value_suggestions_option_code_check" CHECK (
    "option_code" IS NULL OR "option_code" ~ '^[a-z][a-z0-9_-]{0,63}$'),
  ADD CONSTRAINT "attribute_value_suggestions_reject_reason_check" CHECK (
    "reject_reason" IS NULL OR (
      "reject_reason" = btrim("reject_reason") AND char_length("reject_reason") BETWEEN 1 AND 300
      AND "reject_reason" !~ '[[:cntrl:]]')),
  -- The decision's shape: open has none; approved and mapped name a value; rejected gives a reason;
  -- every decided row names the deciding admin and the time.
  ADD CONSTRAINT "attribute_value_suggestions_decision_check" CHECK (
    ("status" = 'open'
       AND "option_code" IS NULL AND "reject_reason" IS NULL
       AND "decided_by_account_id" IS NULL AND "decided_at" IS NULL)
    OR ("status" IN ('approved', 'mapped')
       AND "option_code" IS NOT NULL AND "reject_reason" IS NULL
       AND "decided_by_account_id" IS NOT NULL AND "decided_at" IS NOT NULL)
    OR ("status" = 'rejected'
       AND "option_code" IS NULL AND "reject_reason" IS NOT NULL
       AND "decided_by_account_id" IS NOT NULL AND "decided_at" IS NOT NULL)),
  ADD CONSTRAINT "attribute_value_suggestions_notice_state_check" CHECK (
    "notice_state" IN ('none', 'pending', 'sent', 'skipped', 'failed')),
  -- An open suggestion has no notice yet; a decided one always has one.
  ADD CONSTRAINT "attribute_value_suggestions_notice_open_check" CHECK (
    ("status" = 'open') = ("notice_state" = 'none')),
  ADD CONSTRAINT "attribute_value_suggestions_notice_attempts_check" CHECK (
    "notice_attempts" BETWEEN 0 AND 10),
  -- Only a pending notice waits for a time.
  ADD CONSTRAINT "attribute_value_suggestions_notice_next_check" CHECK (
    ("notice_state" = 'pending') = ("notice_next_attempt_at" IS NOT NULL)),
  ADD CONSTRAINT "attribute_value_suggestions_version_check" CHECK ("version" >= 1);

-- A field holds one waiting suggestion: one open suggestion per product and attribute.
CREATE UNIQUE INDEX "attribute_value_suggestions_open_product_definition_key"
  ON "catalog"."attribute_value_suggestions" ("market_id", "product_id", "definition_id")
  WHERE "status" = 'open';

-- The notice job's selection: pending notices by time.
CREATE INDEX "attribute_value_suggestions_notice_due_idx"
  ON "catalog"."attribute_value_suggestions" ("market_id", "notice_next_attempt_at", "id")
  WHERE "notice_state" = 'pending';

CREATE FUNCTION "catalog"."attribute_value_suggestions_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog.attribute_value_suggestions: DELETE is not allowed' USING ERRCODE = 'restrict_violation';
  END IF;
  -- A suggestion is born open at version 1, with no decision and no notice.
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.version <> 1 OR NEW.notice_attempts <> 0 THEN
      RAISE EXCEPTION 'catalog.attribute_value_suggestions: a new suggestion is open at version 1' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.created_at > statement_timestamp() + interval '5 minutes' THEN
      RAISE EXCEPTION 'catalog.attribute_value_suggestions: created_at is in the future' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.market_id, NEW.tenant_id, NEW.definition_id, NEW.seller_id, NEW.product_id, NEW.label, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.market_id, OLD.tenant_id, OLD.definition_id, OLD.seller_id, OLD.product_id, OLD.label, OLD.created_at) THEN
    RAISE EXCEPTION 'catalog.attribute_value_suggestions: immutable column changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'catalog.attribute_value_suggestions: version must rise by one' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'open' THEN
    -- The decision: the one move out of open; the notice starts pending.
    IF NEW.status = 'open' OR NEW.notice_state <> 'pending' OR NEW.notice_attempts <> 0 THEN
      RAISE EXCEPTION 'catalog.attribute_value_suggestions: an open suggestion is decided, and its notice starts pending' USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.decided_at < statement_timestamp() - interval '5 minutes'
       OR NEW.decided_at > statement_timestamp() + interval '5 minutes' THEN
      RAISE EXCEPTION 'catalog.attribute_value_suggestions: decided_at outside tolerance' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- A decided suggestion never changes its decision; only its notice moves, and only from pending.
  IF (NEW.status, NEW.option_code, NEW.reject_reason, NEW.decided_by_account_id, NEW.decided_at)
     IS DISTINCT FROM
     (OLD.status, OLD.option_code, OLD.reject_reason, OLD.decided_by_account_id, OLD.decided_at) THEN
    RAISE EXCEPTION 'catalog.attribute_value_suggestions: a decided suggestion never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.notice_state <> 'pending' THEN
    RAISE EXCEPTION 'catalog.attribute_value_suggestions: a settled notice never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.notice_attempts < OLD.notice_attempts THEN
    RAISE EXCEPTION 'catalog.attribute_value_suggestions: notice attempts never go down' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "attribute_value_suggestions_guard" BEFORE INSERT OR UPDATE OR DELETE
  ON "catalog"."attribute_value_suggestions"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."attribute_value_suggestions_guard"();
CREATE TRIGGER "attribute_value_suggestions_no_truncate" BEFORE TRUNCATE
  ON "catalog"."attribute_value_suggestions"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();

-- Grants (data design 7): the decision and the notice marker move; nothing else is updated and
-- nothing is deleted.
GRANT SELECT, INSERT, UPDATE ("status", "option_code", "reject_reason", "decided_by_account_id",
  "decided_at", "notice_state", "notice_attempts", "notice_next_attempt_at", "version")
  ON TABLE "catalog"."attribute_value_suggestions" TO "mondapac_app";
