-- Customers management phase 4a: the seller's invite link and the seller a customer signed up
-- through (the exclusive customer). Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- CreateTable
CREATE TABLE "customers"."seller_invite_links" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "token" VARCHAR(26) NOT NULL,
    "created_by_account_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "seller_invite_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers"."seller_attributions" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "link_id" UUID NOT NULL,
    "attributed_at" TIMESTAMPTZ(6) NOT NULL,
    "status" TEXT NOT NULL,
    "reject_reason" TEXT,
    "flags" TEXT[] NOT NULL DEFAULT '{}',
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL,

    CONSTRAINT "seller_attributions_pkey" PRIMARY KEY ("market_id","account_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "seller_invite_links_market_id_token_key" ON "customers"."seller_invite_links"("market_id", "token");

-- CreateIndex
CREATE UNIQUE INDEX "seller_invite_links_market_id_id_key" ON "customers"."seller_invite_links"("market_id", "id");

-- CreateIndex
CREATE INDEX "seller_attributions_market_id_seller_id_attributed_at_accou_idx" ON "customers"."seller_attributions"("market_id", "seller_id", "attributed_at" DESC, "account_id" DESC);

-- CreateIndex
CREATE INDEX "seller_attributions_market_id_attributed_at_account_id_idx" ON "customers"."seller_attributions"("market_id", "attributed_at" DESC, "account_id" DESC);

-- CreateIndex
CREATE INDEX "seller_attributions_market_id_link_id_attributed_at_idx" ON "customers"."seller_attributions"("market_id", "link_id", "attributed_at");

-- AddForeignKey
ALTER TABLE "customers"."seller_attributions" ADD CONSTRAINT "seller_attributions_market_id_account_id_fkey" FOREIGN KEY ("market_id", "account_id") REFERENCES "customers"."customer_directory"("market_id", "account_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "customers"."seller_attributions" ADD CONSTRAINT "seller_attributions_market_id_link_id_fkey" FOREIGN KEY ("market_id", "link_id") REFERENCES "customers"."seller_invite_links"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: one live link per seller.
CREATE UNIQUE INDEX "seller_invite_links_one_live_per_seller_key"
  ON "customers"."seller_invite_links" ("market_id", "seller_id") WHERE "revoked_at" IS NULL;

-- Hand-written: the admin list of rejected and flagged attributions.
CREATE INDEX "seller_attributions_market_id_suspicious_idx"
  ON "customers"."seller_attributions" ("market_id", "attributed_at" DESC, "account_id" DESC)
  -- Written as Prisma writes the suspicious view's filter (NOT flags = '{}'), so the planner
  -- matches it; test/db/customers-seller-invitations.db-spec.ts checks the plan.
  WHERE "status" = 'rejected' OR "flags" <> '{}'::TEXT[];

-- Hand-written: scope and value checks.
ALTER TABLE "customers"."seller_invite_links"
  ADD CONSTRAINT "seller_invite_links_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_invite_links_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_invite_links_token_check" CHECK ("token" ~ '^[0-9A-HJKMNP-TV-Z]{26}$'),
  ADD CONSTRAINT "seller_invite_links_revoked_at_check" CHECK ("revoked_at" IS NULL OR "revoked_at" >= "created_at");

ALTER TABLE "customers"."seller_attributions"
  ADD CONSTRAINT "seller_attributions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_attributions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_attributions_status_check" CHECK ("status" IN ('active', 'rejected')),
  ADD CONSTRAINT "seller_attributions_reject_reason_check" CHECK (
    ("status" = 'active' AND "reject_reason" IS NULL)
    -- IS NOT NULL is needed: NULL IN (...) is NULL, and a CHECK lets NULL through.
    OR ("status" = 'rejected' AND "reject_reason" IS NOT NULL
        AND "reject_reason" IN ('seller-team', 'admin'))),
  ADD CONSTRAINT "seller_attributions_flags_check" CHECK (
    "flags" <@ ARRAY['link-burst']::TEXT[] AND cardinality("flags") <= 1),
  ADD CONSTRAINT "seller_attributions_decided_check" CHECK (
    ("decided_at" IS NULL) = ("decided_by_account_id" IS NULL)
    AND ("decided_at" IS NULL OR "decided_at" >= "attributed_at")),
  ADD CONSTRAINT "seller_attributions_version_check" CHECK ("version" >= 1);

-- Grants. A link is drawn and later revoked (only revoked_at changes). An attribution is recorded
-- by the customer's claim and its status changed by an admin. It goes with the directory row by
-- the foreign key's cascade, which runs with the owner's rights: the application never deletes it.
GRANT SELECT, INSERT, UPDATE ("revoked_at") ON TABLE "customers"."seller_invite_links" TO "mondapac_app";
GRANT SELECT, INSERT ON TABLE "customers"."seller_attributions" TO "mondapac_app";
GRANT UPDATE ("status", "reject_reason", "decided_by_account_id", "decided_at", "version")
  ON TABLE "customers"."seller_attributions" TO "mondapac_app";
