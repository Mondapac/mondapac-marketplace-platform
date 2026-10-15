-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "search";

-- CreateTable
CREATE TABLE "search"."offer_documents" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "offer_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "short_text" TEXT,
    "category_ids" UUID[],
    "text_search_config" TEXT NOT NULL,
    "search_vector" tsvector,
    "indexed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "offer_documents_pkey" PRIMARY KEY ("market_id","offer_id")
);

-- CreateIndex
CREATE INDEX "offer_documents_market_id_product_id_idx" ON "search"."offer_documents"("market_id", "product_id");

-- CreateIndex
CREATE INDEX "offer_documents_market_id_seller_id_idx" ON "search"."offer_documents"("market_id", "seller_id");

-- Hand-written: value checks. The vector is never empty: the trigger below always sets it.
ALTER TABLE "search"."offer_documents"
  ADD CONSTRAINT "offer_documents_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "offer_documents_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "offer_documents_name_check" CHECK (char_length("name") BETWEEN 1 AND 500),
  ADD CONSTRAINT "offer_documents_short_text_check" CHECK (
    "short_text" IS NULL OR char_length("short_text") BETWEEN 1 AND 2000),
  ADD CONSTRAINT "offer_documents_locale_check" CHECK ("locale" ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?-[A-Z]{2}$'),
  ADD CONSTRAINT "offer_documents_category_ids_check" CHECK (
    "category_ids" IS NOT NULL AND cardinality("category_ids") <= 20
    AND array_position("category_ids", NULL) IS NULL),
  -- The built-in configurations only; the same closed list as the Market file schema.
  ADD CONSTRAINT "offer_documents_text_search_config_check" CHECK ("text_search_config" IN (
    'simple', 'arabic', 'danish', 'dutch', 'english', 'finnish', 'french', 'german', 'hungarian',
    'indonesian', 'irish', 'italian', 'lithuanian', 'nepali', 'norwegian', 'portuguese',
    'romanian', 'russian', 'spanish', 'swedish', 'tamil', 'turkish')),
  ADD CONSTRAINT "offer_documents_search_vector_check" CHECK ("search_vector" IS NOT NULL);

-- Hand-written: the full-text index (the text query) and the category index (browse). Invisible
-- to Prisma.
CREATE INDEX "offer_documents_search_vector_idx" ON "search"."offer_documents" USING GIN ("search_vector");
CREATE INDEX "offer_documents_category_ids_idx" ON "search"."offer_documents" USING GIN ("category_ids");

-- Hand-written: the vector is built in the database from the row's own text and configuration,
-- so no caller writes a tsvector and the two cannot disagree. Name weighs more than short text.
CREATE FUNCTION "search"."offer_documents_set_vector"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW."search_vector" :=
    setweight(to_tsvector(NEW."text_search_config"::regconfig, NEW."name"), 'A')
    || setweight(to_tsvector(NEW."text_search_config"::regconfig, coalesce(NEW."short_text", '')), 'B');
  RETURN NEW;
END; $$;

CREATE TRIGGER "offer_documents_set_vector"
  BEFORE INSERT OR UPDATE ON "search"."offer_documents"
  FOR EACH ROW EXECUTE FUNCTION "search"."offer_documents_set_vector"();

-- Grants. A document is a projection: upserted when catalog says so, deleted when the Offer is
-- no longer sellable or by a rebuild. Identity columns (market, tenant, offer) never change.
GRANT USAGE ON SCHEMA "search" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ("product_id", "seller_id", "locale", "name", "short_text", "category_ids", "text_search_config", "indexed_at"), DELETE ON TABLE "search"."offer_documents" TO "mondapac_app";
