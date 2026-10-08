-- CreateTable
CREATE TABLE "identity"."one_time_links" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "requested_at" TIMESTAMPTZ(6) NOT NULL,
    "token_hash" BYTEA,
    "issued_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "consumed_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL,

    CONSTRAINT "one_time_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."inbox" (
    "event_id" UUID NOT NULL,
    "handler" TEXT NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inbox_pkey" PRIMARY KEY ("event_id","handler")
);

-- CreateIndex
CREATE UNIQUE INDEX "one_time_links_market_id_account_id_purpose_key" ON "identity"."one_time_links"("market_id", "account_id", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "one_time_links_market_id_token_hash_key" ON "identity"."one_time_links"("market_id", "token_hash");

-- AddForeignKey
ALTER TABLE "identity"."one_time_links" ADD CONSTRAINT "one_time_links_market_id_account_id_fkey" FOREIGN KEY ("market_id", "account_id") REFERENCES "identity"."accounts"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Hand-written (database-designer): docs/design/data/identity.md sections 2 (C1, C5, C6) and 3.7.
-- All four purposes are in the CHECK from slice 3, so no later slice alters it.
ALTER TABLE "identity"."one_time_links"
  ADD CONSTRAINT "one_time_links_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "one_time_links_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "one_time_links_purpose_check" CHECK ("purpose" IN (
    'verify-email', 'reset-password', 'enrol-second-factor', 'confirm-second-factor-reset')),
  ADD CONSTRAINT "one_time_links_token_hash_check" CHECK (octet_length("token_hash") = 32),
  ADD CONSTRAINT "one_time_links_issued_check" CHECK (("token_hash" IS NULL) = ("issued_at" IS NULL)),
  ADD CONSTRAINT "one_time_links_expires_check" CHECK (("issued_at" IS NULL) = ("expires_at" IS NULL)),
  ADD CONSTRAINT "one_time_links_expires_at_check" CHECK ("expires_at" > "issued_at"),
  ADD CONSTRAINT "one_time_links_consumed_check" CHECK ("consumed_at" IS NULL OR "issued_at" IS NOT NULL),
  ADD CONSTRAINT "one_time_links_version_check" CHECK ("version" >= 1);

-- Hand-written (database-designer): docs/design/data/identity.md sections 2 (C1) and 3.8.
ALTER TABLE "identity"."inbox"
  ADD CONSTRAINT "inbox_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "inbox_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "inbox_handler_check" CHECK ("handler" ~ '^identity\.[a-z0-9-]+$');

-- Grants (database-designer): docs/design/data/identity.md section 7. The inbox's DELETE arrives
-- with the prune job (P 7).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."one_time_links" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "identity"."inbox" TO "mondapac_app";
