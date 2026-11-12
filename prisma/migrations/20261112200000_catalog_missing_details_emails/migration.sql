SET lock_timeout = '5s';
SET statement_timeout = '60s';
-- CreateTable
CREATE TABLE "catalog"."missing_details_emails" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "requested_by_account_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "notice_state" TEXT NOT NULL,
    "notice_attempts" INTEGER NOT NULL,
    "notice_next_attempt_at" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL,

    CONSTRAINT "missing_details_emails_pkey" PRIMARY KEY ("market_id","id")
);

-- CreateTable
CREATE TABLE "catalog"."missing_details_email_products" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "email_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,

    CONSTRAINT "missing_details_email_products_pkey" PRIMARY KEY ("market_id","email_id","product_id")
);

-- CreateIndex
CREATE INDEX "missing_details_email_products_market_id_product_id_idx" ON "catalog"."missing_details_email_products"("market_id", "product_id");

-- AddForeignKey
ALTER TABLE "catalog"."missing_details_email_products" ADD CONSTRAINT "missing_details_email_products_market_id_email_id_fkey" FOREIGN KEY ("market_id", "email_id") REFERENCES "catalog"."missing_details_emails"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "catalog"."missing_details_email_products" ADD CONSTRAINT "missing_details_email_products_market_id_product_id_fkey" FOREIGN KEY ("market_id", "product_id") REFERENCES "catalog"."products"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (reviewed by database-designer, M1 applied): attributes A4-4, the "Email sellers" action of
-- the Missing details report. One email per seller and request, queued by an admin (pending) and
-- settled once by the job (sent, skipped: no usable address, failed: attempts used up). Its text
-- never changes; the products it lists are append-only. Nothing is deleted.

ALTER TABLE "catalog"."missing_details_emails"
  ADD CONSTRAINT "missing_details_emails_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "missing_details_emails_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  -- The rendered plain-text mail: a one-line subject; a body of at most 100 products' lines.
  ADD CONSTRAINT "missing_details_emails_subject_check" CHECK (
    char_length("subject") BETWEEN 1 AND 200 AND "subject" !~ '[[:cntrl:]]'),
  ADD CONSTRAINT "missing_details_emails_body_check" CHECK (char_length("body") BETWEEN 1 AND 200000),
  ADD CONSTRAINT "missing_details_emails_notice_state_check" CHECK (
    "notice_state" IN ('pending', 'sent', 'skipped', 'failed')),
  ADD CONSTRAINT "missing_details_emails_notice_attempts_check" CHECK (
    "notice_attempts" BETWEEN 0 AND 10),
  -- Only a pending email waits for a time; only a sent one has a sent time.
  ADD CONSTRAINT "missing_details_emails_notice_next_check" CHECK (
    ("notice_state" = 'pending') = ("notice_next_attempt_at" IS NOT NULL)),
  ADD CONSTRAINT "missing_details_emails_sent_at_check" CHECK (
    ("notice_state" = 'sent') = ("sent_at" IS NOT NULL)),
  ADD CONSTRAINT "missing_details_emails_version_check" CHECK ("version" >= 1);

ALTER TABLE "catalog"."missing_details_email_products"
  ADD CONSTRAINT "missing_details_email_products_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "missing_details_email_products_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$');

-- One pending email per seller: two admins never queue two at once (the second request waits on
-- this index and is refused as busy).
CREATE UNIQUE INDEX "missing_details_emails_one_pending_key"
  ON "catalog"."missing_details_emails" ("market_id", "seller_id")
  WHERE "notice_state" = 'pending';

-- The job's selection: pending emails by time.
CREATE INDEX "missing_details_emails_notice_due_idx"
  ON "catalog"."missing_details_emails" ("market_id", "notice_next_attempt_at", "id")
  WHERE "notice_state" = 'pending';

CREATE FUNCTION "catalog"."missing_details_emails_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog.missing_details_emails: DELETE is not allowed' USING ERRCODE = 'restrict_violation';
  END IF;
  -- An email is born pending at version 1, never tried, due at once.
  IF TG_OP = 'INSERT' THEN
    IF NEW.notice_state <> 'pending' OR NEW.version <> 1 OR NEW.notice_attempts <> 0 THEN
      RAISE EXCEPTION 'catalog.missing_details_emails: a new email is pending at version 1' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.requested_at < statement_timestamp() - interval '5 minutes'
       OR NEW.requested_at > statement_timestamp() + interval '5 minutes' THEN
      RAISE EXCEPTION 'catalog.missing_details_emails: requested_at outside tolerance' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.market_id, NEW.tenant_id, NEW.seller_id, NEW.requested_by_account_id, NEW.requested_at, NEW.subject, NEW.body)
     IS DISTINCT FROM
     (OLD.id, OLD.market_id, OLD.tenant_id, OLD.seller_id, OLD.requested_by_account_id, OLD.requested_at, OLD.subject, OLD.body) THEN
    RAISE EXCEPTION 'catalog.missing_details_emails: immutable column changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'catalog.missing_details_emails: version must rise by one' USING ERRCODE = 'restrict_violation';
  END IF;
  -- Only a pending email moves; a settled one never changes.
  IF OLD.notice_state <> 'pending' THEN
    RAISE EXCEPTION 'catalog.missing_details_emails: a settled email never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.notice_attempts < OLD.notice_attempts THEN
    RAISE EXCEPTION 'catalog.missing_details_emails: notice attempts never go down' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER "missing_details_emails_guard" BEFORE INSERT OR UPDATE OR DELETE
  ON "catalog"."missing_details_emails"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."missing_details_emails_guard"();
CREATE TRIGGER "missing_details_emails_no_truncate" BEFORE TRUNCATE
  ON "catalog"."missing_details_emails"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();

-- The products of an email are written with it and never change.
CREATE TRIGGER "missing_details_email_products_append_only" BEFORE UPDATE OR DELETE
  ON "catalog"."missing_details_email_products"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "missing_details_email_products_no_truncate" BEFORE TRUNCATE
  ON "catalog"."missing_details_email_products"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();

-- Grants (data design 7): only the notice marker moves; nothing is deleted.
GRANT SELECT, INSERT, UPDATE ("notice_state", "notice_attempts", "notice_next_attempt_at",
  "sent_at", "version")
  ON TABLE "catalog"."missing_details_emails" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "catalog"."missing_details_email_products" TO "mondapac_app";
