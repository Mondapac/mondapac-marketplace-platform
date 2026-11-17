-- Customers management phase 2 (PR 2a): the admin's manual customer groups and their members,
-- internal admin notes about a customer, and the customer's activity timeline. All four tables are
-- new and empty, so no NOT VALID step.

-- Safety (docs/design/data): a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "customers"."customer_groups" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL,
    "archived_at" TIMESTAMPTZ(6),
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,

    CONSTRAINT "customer_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers"."customer_group_members" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "group_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "added_by_account_id" UUID NOT NULL,
    "added_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customer_group_members_pkey" PRIMARY KEY ("market_id","group_id","account_id")
);

-- CreateTable
CREATE TABLE "customers"."customer_notes" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "author_account_id" UUID NOT NULL,
    "body_ciphertext" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customer_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers"."customer_timeline" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "kind" TEXT NOT NULL,
    "ref_type" TEXT,
    "ref_id" UUID,
    "actor_account_id" UUID,
    "detail" TEXT,
    "source_event_id" UUID,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customer_timeline_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_groups_market_id_archived_at_created_at_idx" ON "customers"."customer_groups"("market_id", "archived_at", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "customer_groups_market_id_id_key" ON "customers"."customer_groups"("market_id", "id");

-- CreateIndex
CREATE INDEX "customer_group_members_market_id_account_id_idx" ON "customers"."customer_group_members"("market_id", "account_id");

-- CreateIndex
CREATE INDEX "customer_notes_market_id_account_id_created_at_id_idx" ON "customers"."customer_notes"("market_id", "account_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "customer_timeline_market_id_account_id_occurred_at_id_idx" ON "customers"."customer_timeline"("market_id", "account_id", "occurred_at" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "customer_timeline_market_id_account_id_source_event_id_key" ON "customers"."customer_timeline"("market_id", "account_id", "source_event_id");

-- AddForeignKey
ALTER TABLE "customers"."customer_group_members" ADD CONSTRAINT "customer_group_members_market_id_group_id_fkey" FOREIGN KEY ("market_id", "group_id") REFERENCES "customers"."customer_groups"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "customers"."customer_group_members" ADD CONSTRAINT "customer_group_members_market_id_account_id_fkey" FOREIGN KEY ("market_id", "account_id") REFERENCES "customers"."customer_directory"("market_id", "account_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "customers"."customer_notes" ADD CONSTRAINT "customer_notes_market_id_account_id_fkey" FOREIGN KEY ("market_id", "account_id") REFERENCES "customers"."customer_directory"("market_id", "account_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "customers"."customer_timeline" ADD CONSTRAINT "customer_timeline_market_id_account_id_fkey" FOREIGN KEY ("market_id", "account_id") REFERENCES "customers"."customer_directory"("market_id", "account_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Hand-written: scope and value checks.
ALTER TABLE "customers"."customer_groups"
  ADD CONSTRAINT "customer_groups_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "customer_groups_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "customer_groups_kind_check" CHECK ("kind" IN ('manual')),
  ADD CONSTRAINT "customer_groups_name_check" CHECK (
    "name" = btrim("name") AND char_length("name") BETWEEN 1 AND 80 AND "name" !~ '[[:cntrl:]]'),
  ADD CONSTRAINT "customer_groups_description_check" CHECK (
    "description" IS NULL OR (char_length("description") BETWEEN 1 AND 500 AND "description" !~ '[[:cntrl:]]')),
  ADD CONSTRAINT "customer_groups_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "customer_groups_updated_check" CHECK ("updated_at" >= "created_at");

-- One name per Market, whatever its case (archived groups keep theirs, so a name is never reused
-- under a promotion that still points at the old group).
CREATE UNIQUE INDEX "customer_groups_name_key"
  ON "customers"."customer_groups" ("market_id", lower("name"));

ALTER TABLE "customers"."customer_group_members"
  ADD CONSTRAINT "customer_group_members_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "customer_group_members_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$');

-- The note's plaintext limit (1 to 2000 characters after trimming) is the application's; the
-- database checks the sealed value's shape and bounds, so a body in clear is refused (as
-- ordering.admin_order_notes).
ALTER TABLE "customers"."customer_notes"
  ADD CONSTRAINT "customer_notes_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "customer_notes_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "customer_notes_body_ciphertext_check" CHECK (
    "body_ciphertext" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("body_ciphertext") BETWEEN 41 AND 16384);

-- Codes only: the kind and the detail are short lower-case codes the application owns, so no free
-- text or personal data can land in a timeline row.
ALTER TABLE "customers"."customer_timeline"
  ADD CONSTRAINT "customer_timeline_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "customer_timeline_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "customer_timeline_kind_check" CHECK ("kind" ~ '^[a-z][a-z-]{1,39}$'),
  ADD CONSTRAINT "customer_timeline_ref_check" CHECK (
    ("ref_type" IS NULL AND "ref_id" IS NULL)
    OR ("ref_type" IN ('order', 'refund', 'group', 'note') AND "ref_id" IS NOT NULL)),
  ADD CONSTRAINT "customer_timeline_detail_check" CHECK ("detail" IS NULL OR "detail" ~ '^[a-z0-9][a-z0-9-]{0,39}$');

-- Grants. A group is renamed, described, archived and restored (no delete: a promotion may still
-- name it); members are added and removed; a note is written once and never changed (deleted only
-- by the account's erasure); a timeline entry is never changed (deleted only by the erasure).
GRANT SELECT, INSERT, UPDATE ("name", "description", "archived_at", "updated_at", "version")
  ON TABLE "customers"."customer_groups" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "customers"."customer_group_members" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "customers"."customer_notes" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "customers"."customer_timeline" TO "mondapac_app";
