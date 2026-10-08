-- CreateTable
CREATE TABLE "identity"."seller_access" (
    "seller_id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "state_changed_at" TIMESTAMPTZ(6) NOT NULL,
    "reapply_count" SMALLINT NOT NULL,
    "registered_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "seller_access_pkey" PRIMARY KEY ("seller_id")
);

-- CreateTable
CREATE TABLE "identity"."seller_memberships" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "seller_id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "removed_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "seller_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."roles" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "seed_code" TEXT,
    "seed_version" INTEGER,
    "name" TEXT,
    "name_normalized" TEXT,
    "seller_id" UUID,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."role_permissions" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "role_id" UUID NOT NULL,
    "permission_key" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("market_id","role_id","permission_key")
);

-- CreateTable
CREATE TABLE "identity"."role_assignments" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "assigned_by_account_id" UUID,
    "assigned_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,

    CONSTRAINT "role_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "seller_access_market_id_state_state_changed_at_idx" ON "identity"."seller_access"("market_id", "state", "state_changed_at");

-- CreateIndex
CREATE UNIQUE INDEX "seller_access_market_id_seller_id_key" ON "identity"."seller_access"("market_id", "seller_id");

-- CreateIndex
CREATE INDEX "seller_memberships_market_id_account_id_idx" ON "identity"."seller_memberships"("market_id", "account_id");

-- CreateIndex
CREATE INDEX "seller_memberships_market_id_seller_id_state_idx" ON "identity"."seller_memberships"("market_id", "seller_id", "state");

-- CreateIndex
CREATE INDEX "roles_market_id_seller_id_idx" ON "identity"."roles"("market_id", "seller_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_market_id_id_key" ON "identity"."roles"("market_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_market_id_scope_seed_code_key" ON "identity"."roles"("market_id", "scope", "seed_code");

-- CreateIndex
CREATE INDEX "role_assignments_market_id_role_id_idx" ON "identity"."role_assignments"("market_id", "role_id");

-- CreateIndex
CREATE UNIQUE INDEX "role_assignments_market_id_account_id_key" ON "identity"."role_assignments"("market_id", "account_id");

-- AddForeignKey
ALTER TABLE "identity"."sessions" ADD CONSTRAINT "sessions_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "identity"."seller_access"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "identity"."seller_memberships" ADD CONSTRAINT "seller_memberships_market_id_account_id_fkey" FOREIGN KEY ("market_id", "account_id") REFERENCES "identity"."accounts"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "identity"."seller_memberships" ADD CONSTRAINT "seller_memberships_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "identity"."seller_access"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "identity"."roles" ADD CONSTRAINT "roles_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "identity"."seller_access"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "identity"."role_permissions" ADD CONSTRAINT "role_permissions_market_id_role_id_fkey" FOREIGN KEY ("market_id", "role_id") REFERENCES "identity"."roles"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "identity"."role_assignments" ADD CONSTRAINT "role_assignments_market_id_account_id_fkey" FOREIGN KEY ("market_id", "account_id") REFERENCES "identity"."accounts"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "identity"."role_assignments" ADD CONSTRAINT "role_assignments_market_id_role_id_fkey" FOREIGN KEY ("market_id", "role_id") REFERENCES "identity"."roles"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (database-designer): docs/design/data/identity.md sections 2 (C1, C5) and 3.9
-- (D 3.3). The foreign key "sessions_market_id_seller_id_fkey" above is the one statement on an
-- existing table (8.2); no deployed environment exists, so it is not NOT VALID.
ALTER TABLE "identity"."seller_access"
  ADD CONSTRAINT "seller_access_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_access_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_access_origin_check" CHECK ("origin" IN ('self', 'invitation')),
  ADD CONSTRAINT "seller_access_state_check" CHECK (
    "state" IN ('pending', 'approved', 'rejected', 'suspended')),
  ADD CONSTRAINT "seller_access_reapply_count_check" CHECK ("reapply_count" >= 0),
  ADD CONSTRAINT "seller_access_version_check" CHECK ("version" >= 1);

ALTER TABLE "identity"."seller_memberships"
  ADD CONSTRAINT "seller_memberships_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_memberships_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_memberships_state_check" CHECK ("state" IN ('active', 'removed')),
  ADD CONSTRAINT "seller_memberships_removed_at_check" CHECK (
    ("state" = 'removed') = ("removed_at" IS NOT NULL)),
  ADD CONSTRAINT "seller_memberships_version_check" CHECK ("version" >= 1);

-- roles: seed_code and seed_version set if and only if the kind is not custom; name and
-- name_normalized if and only if it is; a seller only on a seller-scope custom role (R9). The
-- name CHECK is accounts_display_name_check with 80 (M10, HF13); the normalised name has the
-- conditions of accounts_email_normalized_check.
ALTER TABLE "identity"."roles"
  ADD CONSTRAINT "roles_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "roles_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "roles_scope_check" CHECK ("scope" IN ('platform', 'seller')),
  ADD CONSTRAINT "roles_kind_check" CHECK ("kind" IN ('system', 'default', 'custom')),
  ADD CONSTRAINT "roles_seed_check" CHECK (
    ("seed_code" IS NOT NULL) = ("kind" <> 'custom')
    AND ("seed_version" IS NOT NULL) = ("kind" <> 'custom')),
  ADD CONSTRAINT "roles_seed_code_check" CHECK (
    "seed_code" ~ '^[a-z][a-z0-9-]*$' AND char_length("seed_code") <= 64),
  ADD CONSTRAINT "roles_seed_version_check" CHECK ("seed_version" >= 1),
  ADD CONSTRAINT "roles_name_required_check" CHECK (
    ("name" IS NOT NULL) = ("kind" = 'custom')
    AND ("name_normalized" IS NOT NULL) = ("name" IS NOT NULL)),
  ADD CONSTRAINT "roles_name_check" CHECK (
    char_length("name") BETWEEN 1 AND 80
    AND "name" = btrim("name")
    AND "name" !~ '[\u0001-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]'),
  ADD CONSTRAINT "roles_name_normalized_check" CHECK (
    "name_normalized" = lower("name_normalized" COLLATE "C")
    AND "name_normalized" = btrim("name_normalized")
    AND "name_normalized" IS NFC NORMALIZED
    AND char_length("name_normalized") BETWEEN 1 AND 80),
  ADD CONSTRAINT "roles_seller_id_check" CHECK (
    ("scope" = 'seller' AND "kind" = 'custom') = ("seller_id" IS NOT NULL)),
  ADD CONSTRAINT "roles_version_check" CHECK ("version" >= 1);

ALTER TABLE "identity"."role_permissions"
  ADD CONSTRAINT "role_permissions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "role_permissions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "role_permissions_permission_key_check" CHECK (
    "permission_key" ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2}$'
    AND char_length("permission_key") <= 128);

ALTER TABLE "identity"."role_assignments"
  ADD CONSTRAINT "role_assignments_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "role_assignments_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "role_assignments_version_check" CHECK ("version" >= 1);

-- Hand-written (database-designer): docs/design/data/identity.md section 8.4. Invisible to
-- Prisma; checked by the partial-index catalog test. One active membership per account (ADR-0018
-- decision 3); one system role per scope and Market (R3); a custom role's name unique within its
-- seller, or within its Market's platform scope (M10).
CREATE UNIQUE INDEX "seller_memberships_market_id_account_id_active_key" ON "identity"."seller_memberships" ("market_id", "account_id") WHERE "state" = 'active';
CREATE UNIQUE INDEX "roles_market_id_scope_system_key" ON "identity"."roles" ("market_id", "scope") WHERE "kind" = 'system';
CREATE UNIQUE INDEX "roles_market_id_seller_id_name_custom_key" ON "identity"."roles" ("market_id", "seller_id", "name_normalized") WHERE "kind" = 'custom' AND "seller_id" IS NOT NULL;
CREATE UNIQUE INDEX "roles_market_id_name_platform_custom_key" ON "identity"."roles" ("market_id", "name_normalized") WHERE "kind" = 'custom' AND "scope" = 'platform';

-- Grants (database-designer): docs/design/data/identity.md section 7
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."seller_access" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."seller_memberships" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."roles" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "identity"."role_permissions" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."role_assignments" TO "mondapac_app";
