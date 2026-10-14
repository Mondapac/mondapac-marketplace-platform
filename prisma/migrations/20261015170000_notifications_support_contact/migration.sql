-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "notifications";

-- CreateTable
CREATE TABLE "notifications"."support_contacts" (
    "market_id" VARCHAR(8) NOT NULL,
    "version" INTEGER NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "previous_email" VARCHAR(254),
    "changed_at" TIMESTAMPTZ(6) NOT NULL,
    "changed_by" UUID NOT NULL,

    CONSTRAINT "support_contacts_pkey" PRIMARY KEY ("market_id","version")
);

-- Hand-written: scope and value checks.
ALTER TABLE "notifications"."support_contacts"
  ADD CONSTRAINT "support_contacts_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "support_contacts_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "support_contacts_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "support_contacts_email_check" CHECK ("email" ~ '^[a-z0-9._+-]+@[a-z0-9-]+([.][a-z0-9-]+)*[.][a-z]{2,}$');

-- Grants. Insert-only: a change is a new version, nothing is updated or deleted.
GRANT USAGE ON SCHEMA "notifications" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "notifications"."support_contacts" TO "mondapac_app";
