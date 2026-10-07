-- CreateTable
CREATE TABLE "identity"."accounts" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "population" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_normalized" TEXT NOT NULL,
    "display_name" TEXT,
    "status" TEXT NOT NULL,
    "email_verified_at" TIMESTAMPTZ(6),
    "existing_account_notice_at" TIMESTAMPTZ(6),
    "signed_up_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."password_credentials" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "password_hash" TEXT NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "password_credentials_pkey" PRIMARY KEY ("market_id","account_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_market_id_population_email_normalized_key" ON "identity"."accounts"("market_id", "population", "email_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_market_id_id_key" ON "identity"."accounts"("market_id", "id");

-- AddForeignKey
ALTER TABLE "identity"."password_credentials" ADD CONSTRAINT "password_credentials_market_id_account_id_fkey" FOREIGN KEY ("market_id", "account_id") REFERENCES "identity"."accounts"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Hand-written (database-designer): docs/design/data/identity.md sections 2 (C1, C5) and 3.3,
-- with N1 (11.5): display_name is NULL only for a customer.
ALTER TABLE "identity"."accounts"
  ADD CONSTRAINT "accounts_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "accounts_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "accounts_population_check" CHECK ("population" IN ('customer', 'seller', 'admin')),
  ADD CONSTRAINT "accounts_email_check" CHECK (char_length("email") BETWEEN 3 AND 254),
  ADD CONSTRAINT "accounts_email_normalized_check" CHECK (
    "email_normalized" = lower("email_normalized" COLLATE "C")
    AND "email_normalized" = btrim("email_normalized")
    AND "email_normalized" IS NFC NORMALIZED
    AND char_length("email_normalized") BETWEEN 3 AND 254
    AND position('@' in "email_normalized") > 1),
  ADD CONSTRAINT "accounts_display_name_check" CHECK (
    char_length("display_name") BETWEEN 1 AND 100
    AND "display_name" = btrim("display_name")
    AND "display_name" !~ '[\u0001-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]'),
  ADD CONSTRAINT "accounts_display_name_required_check" CHECK (
    "population" = 'customer' OR "display_name" IS NOT NULL),
  ADD CONSTRAINT "accounts_status_check" CHECK ("status" IN ('active', 'disabled')),
  ADD CONSTRAINT "accounts_signed_up_at_check" CHECK ("signed_up_at" >= "created_at"),
  ADD CONSTRAINT "accounts_version_check" CHECK ("version" >= 1);

ALTER TABLE "identity"."password_credentials"
  ADD CONSTRAINT "password_credentials_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "password_credentials_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "password_credentials_password_hash_check" CHECK (
    "password_hash" ~ '^\$[a-z0-9-]+\$' AND char_length("password_hash") <= 255);

-- Hand-written (database-designer): docs/design/data/identity.md section 8.4, the unverified
-- purge (D 3.1). Invisible to Prisma; checked by the partial-index catalog test.
CREATE INDEX "accounts_market_id_signed_up_at_unverified_idx" ON "identity"."accounts" ("market_id", "signed_up_at") WHERE "email_verified_at" IS NULL;

-- Grants (database-designer): docs/design/data/identity.md section 7
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."accounts" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE ON TABLE "identity"."password_credentials" TO "mondapac_app";
