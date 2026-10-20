-- Social sign-in: a customer account's identity at a sign-in provider.
-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "identity"."external_identities" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider" VARCHAR(16) NOT NULL,
    "subject" VARCHAR(255) NOT NULL,
    "account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "external_identities_pkey" PRIMARY KEY ("market_id","provider","subject")
);

-- CreateIndex
CREATE UNIQUE INDEX "external_identities_market_id_account_id_provider_key" ON "identity"."external_identities"("market_id", "account_id", "provider");

-- AddForeignKey
ALTER TABLE "identity"."external_identities" ADD CONSTRAINT "external_identities_market_id_account_id_fkey" FOREIGN KEY ("market_id", "account_id") REFERENCES "identity"."accounts"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Hand-written: scope and value checks, the same bounds as the API.
ALTER TABLE "identity"."external_identities"
  ADD CONSTRAINT "external_identities_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "external_identities_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "external_identities_provider_check" CHECK ("provider" IN ('google')),
  ADD CONSTRAINT "external_identities_subject_check" CHECK ("subject" ~ '^[\x21-\x7e]{1,255}$');

-- Grants (database-designer): docs/design/data/identity.md section 7. Written once, never
-- changed by the application; rows go with their account (the cascade needs no DELETE grant).
GRANT SELECT, INSERT ON TABLE "identity"."external_identities" TO "mondapac_app";
