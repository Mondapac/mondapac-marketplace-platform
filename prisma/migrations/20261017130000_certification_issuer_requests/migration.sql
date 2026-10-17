-- Certification slice 6, "my issuer is not listed" (data design 3.8, 6.1, section 8; D 2.1, 3.3,
-- 7.2): a seller's request for a missing issuer of a registry type, with the typed name encrypted
-- under the seller's key, and its files. There is no column or key from `issuers` to a request, so
-- the typed name has no path into the registry or a submission (AC 11). An admin answers a request
-- once: the issuer was added (an active issuer of the request's own type) or not accepted (a
-- reason code of the Market).

-- Safety (docs/design/data/certification.md 9.2): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "certification"."issuer_requests" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "typed_name_ciphertext" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "answer_reason_code" TEXT,
    "issuer_id" UUID,
    "answered_at" TIMESTAMPTZ(6),
    "answered_by_account_id" UUID,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "issuer_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certification"."issuer_request_documents" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "issuer_request_id" UUID NOT NULL,
    "type_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,

    CONSTRAINT "issuer_request_documents_pkey" PRIMARY KEY ("market_id","issuer_request_id","document_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "issuer_requests_market_id_id_key" ON "certification"."issuer_requests"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "issuer_requests_market_id_id_type_id_seller_id_key" ON "certification"."issuer_requests"("market_id", "id", "type_id", "seller_id");

-- CreateIndex
CREATE UNIQUE INDEX "issuer_request_documents_market_id_document_id_key" ON "certification"."issuer_request_documents"("market_id", "document_id");

-- CreateIndex
CREATE UNIQUE INDEX "issuer_request_documents_market_id_issuer_request_id_positi_key" ON "certification"."issuer_request_documents"("market_id", "issuer_request_id", "position");

-- AddForeignKey
ALTER TABLE "certification"."issuer_requests" ADD CONSTRAINT "issuer_requests_market_id_type_id_fkey" FOREIGN KEY ("market_id", "type_id") REFERENCES "certification"."certification_types"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."issuer_requests" ADD CONSTRAINT "issuer_requests_market_id_issuer_id_type_id_fkey" FOREIGN KEY ("market_id", "issuer_id", "type_id") REFERENCES "certification"."issuers"("market_id", "id", "type_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."issuer_request_documents" ADD CONSTRAINT "issuer_request_documents_request_fkey" FOREIGN KEY ("market_id", "issuer_request_id", "type_id", "seller_id") REFERENCES "certification"."issuer_requests"("market_id", "id", "type_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "certification"."issuer_request_documents" ADD CONSTRAINT "issuer_request_documents_document_fkey" FOREIGN KEY ("market_id", "document_id", "type_id", "seller_id") REFERENCES "certification"."uploaded_documents"("market_id", "id", "type_id", "owner_seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written CHECKs (data design 3.8, 4.4; S4, S8, C4, CE1).
ALTER TABLE "certification"."issuer_requests"
  ADD CONSTRAINT "issuer_requests_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "issuer_requests_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "issuer_requests_typed_name_ciphertext_check" CHECK (
    "typed_name_ciphertext" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("typed_name_ciphertext") BETWEEN 41 AND 2048),
  ADD CONSTRAINT "issuer_requests_state_check" CHECK (
    "state" IN ('open', 'issuer-added', 'not-accepted')),
  ADD CONSTRAINT "issuer_requests_answer_reason_code_check" CHECK (
    "answer_reason_code" ~ '^[a-z][a-z0-9-]{0,63}$'),
  ADD CONSTRAINT "issuer_requests_reason_pair_check" CHECK (
    ("state" = 'not-accepted') = ("answer_reason_code" IS NOT NULL)),
  ADD CONSTRAINT "issuer_requests_issuer_pair_check" CHECK (
    ("state" = 'issuer-added') = ("issuer_id" IS NOT NULL)),
  ADD CONSTRAINT "issuer_requests_answered_pair_check" CHECK (
    ("state" = 'open') = ("answered_at" IS NULL)
    AND ("state" = 'open') = ("answered_by_account_id" IS NULL)),
  ADD CONSTRAINT "issuer_requests_version_check" CHECK ("version" >= 1);

ALTER TABLE "certification"."issuer_request_documents"
  ADD CONSTRAINT "issuer_request_documents_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "issuer_request_documents_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "issuer_request_documents_position_check" CHECK ("position" >= 1);

-- Partial indexes (data design 3.8), invisible to Prisma: the admin queue of open requests, oldest
-- first; and at most one open request per seller and type (Hassan L2; the use case answers
-- `issuer-request.already-open`), which also serves the seller's `draft-issuer-not-listed` code
-- (D 3.3).
CREATE INDEX "issuer_requests_market_id_created_at_open_idx"
  ON "certification"."issuer_requests" ("market_id", "created_at", "id") WHERE "state" = 'open';
CREATE UNIQUE INDEX "issuer_requests_market_id_seller_id_type_id_open_key"
  ON "certification"."issuer_requests" ("market_id", "seller_id", "type_id") WHERE "state" = 'open';

-- A request is born open at version 1 (Hassan L1): an INSERT cannot write an answered row, which
-- would skip the answer's checks, event and audit. A trigger function: no grant.
CREATE FUNCTION "certification"."issuer_requests_guard_insert"() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."state" <> 'open' OR NEW."version" <> 1 THEN
    RAISE EXCEPTION 'certification.issuer_requests: a request is inserted open at version 1'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "issuer_requests_insert_open"
  BEFORE INSERT ON "certification"."issuer_requests"
  FOR EACH ROW EXECUTE FUNCTION "certification"."issuer_requests_guard_insert"();

-- An answer is given once (D 2.1): only an open request moves, to a final state, version + 1. The
-- typed name, the seller and the type are outside the column-level UPDATE grant. A trigger
-- function: no grant.
CREATE FUNCTION "certification"."issuer_requests_guard_update"() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."state" <> 'open' THEN
    RAISE EXCEPTION 'certification.issuer_requests: an answered request is frozen'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."state" = 'open' OR NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'certification.issuer_requests: an open request moves to a final state, version + 1'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "issuer_requests_answer_once"
  BEFORE UPDATE ON "certification"."issuer_requests"
  FOR EACH ROW EXECUTE FUNCTION "certification"."issuer_requests_guard_update"();

-- Only a clean file of the issuer-request purpose joins a request (AC 21, L2), as the certificate
-- links (migration 20261017090000): no row lock, the link's own foreign key takes FOR KEY SHARE.
CREATE FUNCTION "certification"."issuer_request_document_link_clean"() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "certification"."uploaded_documents"
    WHERE "market_id" = NEW."market_id" AND "id" = NEW."document_id" AND "state" = 'clean'
      AND "purpose" = 'issuer-request'
  ) THEN
    RAISE EXCEPTION 'certification.%: only a clean issuer-request document can be linked', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "issuer_request_documents_clean" BEFORE INSERT
  ON "certification"."issuer_request_documents"
  FOR EACH ROW EXECUTE FUNCTION "certification"."issuer_request_document_link_clean"();

-- Append-only link table (CE3, data design 6.1): the shared function of migration 1.
CREATE TRIGGER "issuer_request_documents_no_update_delete"
  BEFORE UPDATE OR DELETE ON "certification"."issuer_request_documents"
  FOR EACH ROW EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "issuer_request_documents_no_truncate"
  BEFORE TRUNCATE ON "certification"."issuer_request_documents"
  FOR EACH STATEMENT EXECUTE FUNCTION "certification"."reject_mutation"();

-- Grants (database-designer): docs/design/data/certification.md section 8. The typed name is
-- immutable; a request is never deleted.
GRANT SELECT, INSERT ON TABLE "certification"."issuer_requests" TO "mondapac_app";
GRANT UPDATE ("state", "answer_reason_code", "issuer_id", "answered_at", "answered_by_account_id", "version")
  ON TABLE "certification"."issuer_requests" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "certification"."issuer_request_documents" TO "mondapac_app";
