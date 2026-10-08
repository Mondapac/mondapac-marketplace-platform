-- CreateTable
CREATE TABLE "identity"."second_factors" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "secret_ciphertext" TEXT NOT NULL,
    "pending_secret_ciphertext" TEXT,
    "last_accepted_step" INTEGER,
    "activated_at" TIMESTAMPTZ(6),
    "locked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,

    CONSTRAINT "second_factors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."recovery_codes" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "second_factor_id" UUID NOT NULL,
    "position" SMALLINT NOT NULL,
    "code_hash" BYTEA NOT NULL,
    "used_at" TIMESTAMPTZ(6),

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("market_id","second_factor_id","position")
);

-- CreateTable
CREATE TABLE "identity"."sign_in_challenges" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "token_hash" BYTEA NOT NULL,
    "attempts" SMALLINT NOT NULL,
    "credential_changed_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sign_in_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."invitations" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "email" TEXT,
    "email_normalized" TEXT,
    "display_name" TEXT,
    "role_id" UUID NOT NULL,
    "seller_id" UUID,
    "invited_by_account_id" UUID,
    "token_hash" BYTEA,
    "expires_at" TIMESTAMPTZ(6),
    "state" TEXT NOT NULL,
    "decided_at" TIMESTAMPTZ(6),
    "accepted_account_id" UUID,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "second_factors_market_id_account_id_key" ON "identity"."second_factors"("market_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "second_factors_market_id_id_key" ON "identity"."second_factors"("market_id", "id");

-- CreateIndex
CREATE INDEX "sign_in_challenges_market_id_account_id_idx" ON "identity"."sign_in_challenges"("market_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "sign_in_challenges_market_id_token_hash_key" ON "identity"."sign_in_challenges"("market_id", "token_hash");

-- CreateIndex
CREATE INDEX "invitations_market_id_seller_id_idx" ON "identity"."invitations"("market_id", "seller_id");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_market_id_token_hash_key" ON "identity"."invitations"("market_id", "token_hash");

-- AddForeignKey
ALTER TABLE "identity"."second_factors" ADD CONSTRAINT "second_factors_market_id_account_id_fkey" FOREIGN KEY ("market_id", "account_id") REFERENCES "identity"."accounts"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "identity"."recovery_codes" ADD CONSTRAINT "recovery_codes_market_id_second_factor_id_fkey" FOREIGN KEY ("market_id", "second_factor_id") REFERENCES "identity"."second_factors"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "identity"."sign_in_challenges" ADD CONSTRAINT "sign_in_challenges_market_id_account_id_fkey" FOREIGN KEY ("market_id", "account_id") REFERENCES "identity"."accounts"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "identity"."invitations" ADD CONSTRAINT "invitations_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "identity"."seller_access"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (database-designer): docs/design/data/identity.md sections 2 (C1, C5, C6) and
-- 3.10 (D 3.4, 3.6, 7; HF1, HF6, HF11, HF15; M3, M12, M13). Every table is new: no backfill and
-- no statement on an existing table (8.2).
--
-- second_factors: `none` is no row; `activated_at` is set if and only if the factor is active.
-- `second_factors_pending_secret_check` is an addition of slice 7 for Mojtaba's sign-off: a
-- replacement device's secret waits only beside an active factor (M13, D 3.6).
ALTER TABLE "identity"."second_factors"
  ADD CONSTRAINT "second_factors_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "second_factors_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "second_factors_state_check" CHECK ("state" IN ('pending', 'active')),
  ADD CONSTRAINT "second_factors_activated_check" CHECK (
    ("state" = 'active') = ("activated_at" IS NOT NULL)),
  ADD CONSTRAINT "second_factors_pending_secret_check" CHECK (
    "pending_secret_ciphertext" IS NULL OR "state" = 'active'),
  ADD CONSTRAINT "second_factors_last_accepted_step_check" CHECK ("last_accepted_step" >= 0),
  ADD CONSTRAINT "second_factors_version_check" CHECK ("version" >= 1);

-- recovery_codes: "at most ten" is the primary key with this position CHECK (D 7.3); the hash
-- is SubjectKeyService.hmac under the account's key (H2), 32 bytes like every keyed hash (C6).
ALTER TABLE "identity"."recovery_codes"
  ADD CONSTRAINT "recovery_codes_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "recovery_codes_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "recovery_codes_position_check" CHECK ("position" BETWEEN 1 AND 10),
  ADD CONSTRAINT "recovery_codes_code_hash_check" CHECK (octet_length("code_hash") = 32);

-- sign_in_challenges: not versioned (M1); the limit of five attempts is policy (5).
-- `sign_in_challenges_expires_at_check` mirrors sessions_absolute_expires_at_check (an addition
-- of slice 7 for Mojtaba's sign-off).
ALTER TABLE "identity"."sign_in_challenges"
  ADD CONSTRAINT "sign_in_challenges_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "sign_in_challenges_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "sign_in_challenges_purpose_check" CHECK (
    "purpose" IN ('second-factor', 'second-factor-enrolment')),
  ADD CONSTRAINT "sign_in_challenges_token_hash_check" CHECK (octet_length("token_hash") = 32),
  ADD CONSTRAINT "sign_in_challenges_attempts_check" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "sign_in_challenges_expires_at_check" CHECK ("expires_at" > "created_at");

-- invitations: the address is present only while pending (4: never after acceptance or
-- revocation), with the email CHECKs of accounts (3.3); the display name only on a pending
-- seller-owner invitation, with the name rules of accounts.display_name; no seller on an admin
-- invitation; the token hash and the expiry set together at dispatch; `expired` is not stored.
ALTER TABLE "identity"."invitations"
  ADD CONSTRAINT "invitations_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "invitations_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "invitations_kind_check" CHECK ("kind" IN ('seller-owner', 'staff', 'admin')),
  ADD CONSTRAINT "invitations_state_check" CHECK ("state" IN ('pending', 'accepted', 'revoked')),
  ADD CONSTRAINT "invitations_email_pending_check" CHECK (
    ("state" = 'pending') = ("email" IS NOT NULL)
    AND ("state" = 'pending') = ("email_normalized" IS NOT NULL)),
  ADD CONSTRAINT "invitations_email_check" CHECK (char_length("email") BETWEEN 3 AND 254),
  ADD CONSTRAINT "invitations_email_normalized_check" CHECK (
    "email_normalized" = lower("email_normalized" COLLATE "C")
    AND "email_normalized" = btrim("email_normalized")
    AND "email_normalized" IS NFC NORMALIZED
    AND char_length("email_normalized") BETWEEN 3 AND 254
    AND position('@' in "email_normalized") > 1),
  ADD CONSTRAINT "invitations_display_name_kind_check" CHECK (
    "display_name" IS NULL OR ("kind" = 'seller-owner' AND "state" = 'pending')),
  ADD CONSTRAINT "invitations_display_name_check" CHECK (
    char_length("display_name") BETWEEN 1 AND 100
    AND "display_name" = btrim("display_name")
    AND "display_name" !~ '[\u0001-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]'),
  ADD CONSTRAINT "invitations_seller_id_check" CHECK (("kind" = 'admin') = ("seller_id" IS NULL)),
  ADD CONSTRAINT "invitations_token_check" CHECK (("token_hash" IS NULL) = ("expires_at" IS NULL)),
  ADD CONSTRAINT "invitations_token_hash_check" CHECK (octet_length("token_hash") = 32),
  ADD CONSTRAINT "invitations_decided_check" CHECK (("state" = 'pending') = ("decided_at" IS NULL)),
  ADD CONSTRAINT "invitations_accepted_check" CHECK (
    ("state" = 'accepted') = ("accepted_account_id" IS NOT NULL)),
  ADD CONSTRAINT "invitations_version_check" CHECK ("version" >= 1);

-- Hand-written (database-designer): docs/design/data/identity.md section 8.4. Invisible to
-- Prisma; checked by the partial-index catalog test. One pending invitation per Market, scope and
-- address (D 3.4), as two indexes because the platform scope has no seller; one pending
-- seller-owner invitation per seller (HF5 (a), M12).
CREATE UNIQUE INDEX "invitations_market_id_seller_id_email_pending_key" ON "identity"."invitations" ("market_id", "seller_id", "email_normalized") WHERE "state" = 'pending' AND "seller_id" IS NOT NULL;
CREATE UNIQUE INDEX "invitations_market_id_email_pending_platform_key" ON "identity"."invitations" ("market_id", "email_normalized") WHERE "state" = 'pending' AND "seller_id" IS NULL;
CREATE UNIQUE INDEX "invitations_market_id_seller_id_owner_pending_key" ON "identity"."invitations" ("market_id", "seller_id") WHERE "kind" = 'seller-owner' AND "state" = 'pending';

-- Grants (database-designer): docs/design/data/identity.md section 7
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."second_factors" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."recovery_codes" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."sign_in_challenges" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."invitations" TO "mondapac_app";
