-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable: one row per public store that has indexed Offers (search 1a), a projection of
-- sellers' published-store state, rebuilt from it at any time; never a source of truth.
CREATE TABLE "search"."store_documents" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "text_search_config" TEXT NOT NULL,
    "search_vector" tsvector,
    "indexed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "store_documents_pkey" PRIMARY KEY ("market_id","seller_id")
);

-- CreateIndex: a store address names one store.
CREATE UNIQUE INDEX "store_documents_market_id_slug_key" ON "search"."store_documents"("market_id", "slug");

-- Hand-written: value checks. The vector is never empty: the trigger below always sets it.
ALTER TABLE "search"."store_documents"
  ADD CONSTRAINT "store_documents_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "store_documents_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "store_documents_slug_check" CHECK (
    "slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("slug") BETWEEN 3 AND 50),
  ADD CONSTRAINT "store_documents_name_check" CHECK (char_length("name") BETWEEN 1 AND 200),
  -- The built-in configurations only; the same closed list as the Market file schema.
  ADD CONSTRAINT "store_documents_text_search_config_check" CHECK ("text_search_config" IN (
    'simple', 'arabic', 'danish', 'dutch', 'english', 'finnish', 'french', 'german', 'hungarian',
    'indonesian', 'irish', 'italian', 'lithuanian', 'nepali', 'norwegian', 'portuguese',
    'romanian', 'russian', 'spanish', 'swedish', 'tamil', 'turkish')),
  ADD CONSTRAINT "store_documents_search_vector_check" CHECK ("search_vector" IS NOT NULL);

-- Hand-written: the full-text index of the store query. Invisible to Prisma.
CREATE INDEX "store_documents_search_vector_idx" ON "search"."store_documents" USING GIN ("search_vector");

-- Hand-written: the vector is built in the database from the row's own name and configuration.
CREATE FUNCTION "search"."store_documents_set_vector"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  NEW."search_vector" := setweight(to_tsvector(NEW."text_search_config"::regconfig, NEW."name"), 'A');
  RETURN NEW;
END; $$;

CREATE TRIGGER "store_documents_set_vector"
  BEFORE INSERT OR UPDATE ON "search"."store_documents"
  FOR EACH ROW EXECUTE FUNCTION "search"."store_documents_set_vector"();

-- Grants: upserted with the Offers' sync, deleted when the seller has no public store any more,
-- by a rebuild for stale rows. Identity columns (market, tenant, seller) never change.
GRANT SELECT, INSERT, UPDATE ("slug", "name", "text_search_config", "indexed_at"), DELETE ON TABLE "search"."store_documents" TO "mondapac_app";
