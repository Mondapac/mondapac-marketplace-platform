-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "storefront"."seo_settings" (
    "market_id" VARCHAR(8) NOT NULL,
    "version" INTEGER NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "indexing" VARCHAR(3) NOT NULL,
    "site_name" VARCHAR(60) NOT NULL,
    "title_template" VARCHAR(40) NOT NULL,
    "default_description" VARCHAR(160) NOT NULL,
    "share_image_ref" VARCHAR(64),
    "share_image_alt" VARCHAR(125),
    "logo_ref" VARCHAR(64),
    "logo_alt" VARCHAR(125),
    "seller_pages" VARCHAR(13) NOT NULL,
    "trading_name" VARCHAR(100),
    "legal_name" VARCHAR(150),
    "abn" VARCHAR(11),
    "address_street" VARCHAR(100),
    "address_city" VARCHAR(60),
    "address_state" VARCHAR(30),
    "address_postcode" VARCHAR(10),
    "address_country" VARCHAR(2),
    "contact_email" VARCHAR(254),
    "contact_phone" VARCHAR(16),
    "same_as" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "google_verification" VARCHAR(100),
    "bing_verification" VARCHAR(100),
    "analytics_id" VARCHAR(15),
    "page_templates" JSONB NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL,
    "changed_by" UUID NOT NULL,

    CONSTRAINT "seo_settings_pkey" PRIMARY KEY ("market_id","version")
);

-- Hand-written: scope and value checks, the same bounds as the API. The text rule is the API's:
-- controls, format characters except U+200C (Persian), separators and markup are refused.
ALTER TABLE "storefront"."seo_settings"
  ADD CONSTRAINT "seo_settings_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seo_settings_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seo_settings_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "seo_settings_indexing_check" CHECK ("indexing" IN ('off', 'on')),
  ADD CONSTRAINT "seo_settings_site_name_check" CHECK (("site_name" = btrim("site_name") AND char_length("site_name") >= 1 AND "site_name" !~ E'[\\u0001-\\u001F\\u007F-\\u009F\\u00AD\\u0600-\\u0605\\u061C\\u06DD\\u070F\\u08E2\\u180E\\u200B\\u200D-\\u200F\\u2028-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF\\uFFF9-\\uFFFB<>]')),
  ADD CONSTRAINT "seo_settings_title_template_check" CHECK (("title_template" = btrim("title_template") AND char_length("title_template") >= 1 AND "title_template" !~ E'[\\u0001-\\u001F\\u007F-\\u009F\\u00AD\\u0600-\\u0605\\u061C\\u06DD\\u070F\\u08E2\\u180E\\u200B\\u200D-\\u200F\\u2028-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF\\uFFF9-\\uFFFB<>]' AND position('{title}' in "title_template") > 0)),
  ADD CONSTRAINT "seo_settings_default_description_check" CHECK (("default_description" = btrim("default_description") AND char_length("default_description") >= 50 AND "default_description" !~ E'[\\u0001-\\u001F\\u007F-\\u009F\\u00AD\\u0600-\\u0605\\u061C\\u06DD\\u070F\\u08E2\\u180E\\u200B\\u200D-\\u200F\\u2028-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF\\uFFF9-\\uFFFB<>]')),
  ADD CONSTRAINT "seo_settings_seller_pages_check" CHECK ("seller_pages" IN ('with-products', 'none')),
  ADD CONSTRAINT "seo_settings_share_image_check" CHECK ((("share_image_ref" IS NULL AND "share_image_alt" IS NULL)
    OR ("share_image_ref" ~ '^[a-z0-9][a-z0-9-]{0,63}$' AND ("share_image_alt" = btrim("share_image_alt") AND char_length("share_image_alt") >= 1 AND "share_image_alt" !~ E'[\\u0001-\\u001F\\u007F-\\u009F\\u00AD\\u0600-\\u0605\\u061C\\u06DD\\u070F\\u08E2\\u180E\\u200B\\u200D-\\u200F\\u2028-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF\\uFFF9-\\uFFFB<>]')))),
  ADD CONSTRAINT "seo_settings_logo_check" CHECK ((("logo_ref" IS NULL AND "logo_alt" IS NULL)
    OR ("logo_ref" ~ '^[a-z0-9][a-z0-9-]{0,63}$' AND ("logo_alt" = btrim("logo_alt") AND char_length("logo_alt") >= 1 AND "logo_alt" !~ E'[\\u0001-\\u001F\\u007F-\\u009F\\u00AD\\u0600-\\u0605\\u061C\\u06DD\\u070F\\u08E2\\u180E\\u200B\\u200D-\\u200F\\u2028-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF\\uFFF9-\\uFFFB<>]')))),
  ADD CONSTRAINT "seo_settings_trading_name_check" CHECK (("trading_name" IS NULL OR ("trading_name" = btrim("trading_name") AND char_length("trading_name") >= 1 AND "trading_name" !~ E'[\\u0001-\\u001F\\u007F-\\u009F\\u00AD\\u0600-\\u0605\\u061C\\u06DD\\u070F\\u08E2\\u180E\\u200B\\u200D-\\u200F\\u2028-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF\\uFFF9-\\uFFFB<>]'))),
  ADD CONSTRAINT "seo_settings_legal_name_check" CHECK (("legal_name" IS NULL OR ("legal_name" = btrim("legal_name") AND char_length("legal_name") >= 1 AND "legal_name" !~ E'[\\u0001-\\u001F\\u007F-\\u009F\\u00AD\\u0600-\\u0605\\u061C\\u06DD\\u070F\\u08E2\\u180E\\u200B\\u200D-\\u200F\\u2028-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF\\uFFF9-\\uFFFB<>]'))),
  ADD CONSTRAINT "seo_settings_abn_check" CHECK (("abn" IS NULL OR ("abn" ~ '^[0-9]{11}$'
    -- The ABN checksum: first digit less one, weights 10 1 3 5 7 9 11 13 15 17 19, sum divisible by 89.
    AND (((substr("abn", 1, 1)::int - 1) * 10 + substr("abn", 2, 1)::int * 1 + substr("abn", 3, 1)::int * 3
      + substr("abn", 4, 1)::int * 5 + substr("abn", 5, 1)::int * 7 + substr("abn", 6, 1)::int * 9
      + substr("abn", 7, 1)::int * 11 + substr("abn", 8, 1)::int * 13 + substr("abn", 9, 1)::int * 15
      + substr("abn", 10, 1)::int * 17 + substr("abn", 11, 1)::int * 19) % 89) = 0))),
  ADD CONSTRAINT "seo_settings_address_check" CHECK ((("address_street" IS NULL AND "address_city" IS NULL AND "address_state" IS NULL
      AND "address_postcode" IS NULL AND "address_country" IS NULL)
    OR ("address_street" IS NOT NULL AND "address_city" IS NOT NULL AND "address_state" IS NOT NULL
      AND "address_postcode" IS NOT NULL AND "address_country" IS NOT NULL
      AND ("address_street" = btrim("address_street") AND char_length("address_street") >= 1 AND "address_street" !~ E'[\\u0001-\\u001F\\u007F-\\u009F\\u00AD\\u0600-\\u0605\\u061C\\u06DD\\u070F\\u08E2\\u180E\\u200B\\u200D-\\u200F\\u2028-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF\\uFFF9-\\uFFFB<>]') AND ("address_city" = btrim("address_city") AND char_length("address_city") >= 1 AND "address_city" !~ E'[\\u0001-\\u001F\\u007F-\\u009F\\u00AD\\u0600-\\u0605\\u061C\\u06DD\\u070F\\u08E2\\u180E\\u200B\\u200D-\\u200F\\u2028-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF\\uFFF9-\\uFFFB<>]') AND ("address_state" = btrim("address_state") AND char_length("address_state") >= 1 AND "address_state" !~ E'[\\u0001-\\u001F\\u007F-\\u009F\\u00AD\\u0600-\\u0605\\u061C\\u06DD\\u070F\\u08E2\\u180E\\u200B\\u200D-\\u200F\\u2028-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF\\uFFF9-\\uFFFB<>]')
      AND char_length("address_postcode") >= 3 AND "address_postcode" ~ '^[A-Za-z0-9 -]+$' AND ("address_postcode" = btrim("address_postcode") AND char_length("address_postcode") >= 3 AND "address_postcode" !~ E'[\\u0001-\\u001F\\u007F-\\u009F\\u00AD\\u0600-\\u0605\\u061C\\u06DD\\u070F\\u08E2\\u180E\\u200B\\u200D-\\u200F\\u2028-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF\\uFFF9-\\uFFFB<>]')
      AND "address_country" ~ '^[A-Z]{2}$'))),
  ADD CONSTRAINT "seo_settings_contact_email_check" CHECK (("contact_email" IS NULL OR ("contact_email" = lower("contact_email")
    AND "contact_email" ~ '^[a-z0-9._%+-]{1,64}@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'))),
  ADD CONSTRAINT "seo_settings_contact_phone_check" CHECK ("contact_phone" IS NULL OR "contact_phone" ~ '^\+[1-9][0-9]{7,14}$'),
  ADD CONSTRAINT "seo_settings_same_as_check" CHECK (cardinality("same_as") <= 10
    AND (cardinality("same_as") = 0
      -- Joined by a space: every entry is an https URL of at most 200 characters, without a space or hidden character.
      OR (array_to_string("same_as", ' ') ~ '^https://[^ ]+( https://[^ ]+)*$'
        AND array_to_string("same_as", ' ') !~ E'[\\u0001-\\u001F\\u007F-\\u009F\\u00AD\\u0600-\\u0605\\u061C\\u06DD\\u070F\\u08E2\\u180E\\u200B\\u200D-\\u200F\\u2028-\\u202E\\u2060-\\u2064\\u2066-\\u206F\\uFEFF\\uFFF9-\\uFFFB<>]'
        AND char_length(array_to_string("same_as", ' ')) <= 2009))),
  ADD CONSTRAINT "seo_settings_google_verification_check" CHECK ("google_verification" IS NULL OR "google_verification" ~ '^[A-Za-z0-9_-]{10,100}$'),
  ADD CONSTRAINT "seo_settings_bing_verification_check" CHECK ("bing_verification" IS NULL OR "bing_verification" ~ '^[A-Za-z0-9_-]{10,100}$'),
  ADD CONSTRAINT "seo_settings_analytics_id_check" CHECK ("analytics_id" IS NULL OR "analytics_id" ~ '^G-[A-Z0-9]{6,12}$'),
  ADD CONSTRAINT "seo_settings_page_templates_check" CHECK (jsonb_typeof("page_templates") = 'object'
    AND "page_templates" ?& ARRAY['home', 'category', 'product', 'seller', 'sellers', 'landing']
    AND "page_templates" - 'home' - 'category' - 'product' - 'seller' - 'sellers' - 'landing' = '{}'::jsonb
    AND jsonb_typeof("page_templates" -> 'home') = 'object'
    AND jsonb_typeof("page_templates" -> 'category') = 'object'
    AND jsonb_typeof("page_templates" -> 'product') = 'object'
    AND jsonb_typeof("page_templates" -> 'seller') = 'object'
    AND jsonb_typeof("page_templates" -> 'sellers') = 'object'
    AND jsonb_typeof("page_templates" -> 'landing') = 'object'
    AND octet_length("page_templates"::text) <= 8000);

-- Grants. Insert-only: a change is a new version, nothing is updated or deleted.
GRANT SELECT, INSERT ON TABLE "storefront"."seo_settings" TO "mondapac_app";

-- Storefront's outbox (the events the SEO settings write): same table, constraints and grants as every
-- module's outbox (reviews_outbox is the model).
-- CreateTable
CREATE TABLE "storefront"."outbox" (
    "event_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "aggregate_version" INTEGER NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "causation_id" UUID,
    "payload" JSONB NOT NULL,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_market_id_aggregate_id_aggregate_version_key" ON "storefront"."outbox"("market_id", "aggregate_id", "aggregate_version");

ALTER TABLE "storefront"."outbox"
  ADD CONSTRAINT "outbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "outbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "outbox_type_check" CHECK ("type" ~ '^storefront\.[a-z0-9-]+\.v[1-9][0-9]*$'),
  ADD CONSTRAINT "outbox_aggregate_type_check" CHECK ("aggregate_type" ~ '^[a-z][a-z0-9-]*$'),
  ADD CONSTRAINT "outbox_aggregate_version_check" CHECK ("aggregate_version" >= 1),
  ADD CONSTRAINT "outbox_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$'),
  ADD CONSTRAINT "outbox_payload_check" CHECK (jsonb_typeof("payload") = 'object');

-- The relay reads the unpublished rows of a Market in event order.
CREATE INDEX "outbox_market_id_event_id_unpublished_idx"
  ON "storefront"."outbox" ("market_id", "event_id") WHERE "published_at" IS NULL;

GRANT SELECT, INSERT, UPDATE ("published_at") ON TABLE "storefront"."outbox" TO "mondapac_app";
