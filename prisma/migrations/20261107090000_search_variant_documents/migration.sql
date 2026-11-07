-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable: the sell units of a document (variants V8), all derived by the indexer.
CREATE TABLE "search"."offer_variant_documents" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "offer_id" UUID NOT NULL,
    "variant_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,
    "facet_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "gtin" VARCHAR(14),
    "in_stock" BOOLEAN NOT NULL,
    "price_amount" BIGINT,
    "price_currency" CHAR(3),

    CONSTRAINT "offer_variant_documents_pkey" PRIMARY KEY ("market_id","offer_id","variant_id")
);

-- AddForeignKey: a sell unit lives and dies with its document (a projection, never a source of truth).
ALTER TABLE "search"."offer_variant_documents" ADD CONSTRAINT "offer_variant_documents_market_id_offer_id_fkey" FOREIGN KEY ("market_id", "offer_id") REFERENCES "search"."offer_documents"("market_id", "offer_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Hand-written: value checks.
ALTER TABLE "search"."offer_variant_documents"
  ADD CONSTRAINT "offer_variant_documents_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "offer_variant_documents_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "offer_variant_documents_position_check" CHECK ("position" >= 0),
  ADD CONSTRAINT "offer_variant_documents_facet_codes_check" CHECK (
    cardinality("facet_codes") <= 4
    AND array_position("facet_codes", NULL) IS NULL),
  ADD CONSTRAINT "offer_variant_documents_gtin_check" CHECK ("gtin" IS NULL OR "gtin" ~ '^[0-9]{14}$'),
  ADD CONSTRAINT "offer_variant_documents_price_check" CHECK (
    ("price_amount" IS NULL) = ("price_currency" IS NULL)
    AND ("price_amount" IS NULL OR "price_amount" >= 0)
    AND ("price_currency" IS NULL OR "price_currency" ~ '^[A-Z]{3}$'));

-- Hand-written: the exact-GTIN lookup of a text search (only units that have one). Invisible to Prisma.
CREATE INDEX "offer_variant_documents_gtin_idx" ON "search"."offer_variant_documents" ("market_id", "gtin") WHERE "gtin" IS NOT NULL;

-- Grants: written by the indexer as a set per document (delete, then insert), read by the queries.
GRANT SELECT, INSERT, DELETE ON TABLE "search"."offer_variant_documents" TO "mondapac_app";
