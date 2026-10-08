-- CreateTable
CREATE TABLE "identity"."sessions" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "account_id" UUID NOT NULL,
    "population" TEXT NOT NULL,
    "seller_id" UUID,
    "token_hash" BYTEA NOT NULL,
    "transport" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "idle_timeout_seconds" INTEGER NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity"."sign_in_throttles" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key_hash" BYTEA NOT NULL,
    "account_key" BYTEA,
    "window_started_at" TIMESTAMPTZ(6) NOT NULL,
    "attempts" INTEGER NOT NULL,
    "blocked_until" TIMESTAMPTZ(6),

    CONSTRAINT "sign_in_throttles_pkey" PRIMARY KEY ("market_id","kind","key_hash")
);

-- CreateTable
CREATE TABLE "identity"."sign_in_records" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "population" TEXT NOT NULL,
    "account_id" UUID,
    "outcome" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "origin" INET NOT NULL,
    "session_id" UUID,
    "correlation_id" TEXT NOT NULL,

    CONSTRAINT "sign_in_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sessions_market_id_account_id_idx" ON "identity"."sessions"("market_id", "account_id");

-- CreateIndex
CREATE INDEX "sessions_market_id_absolute_expires_at_idx" ON "identity"."sessions"("market_id", "absolute_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_market_id_token_hash_key" ON "identity"."sessions"("market_id", "token_hash");

-- CreateIndex
CREATE INDEX "sign_in_throttles_market_id_account_key_idx" ON "identity"."sign_in_throttles"("market_id", "account_key");

-- CreateIndex
CREATE INDEX "sign_in_records_market_id_occurred_at_idx" ON "identity"."sign_in_records"("market_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "identity"."sessions" ADD CONSTRAINT "sessions_market_id_account_id_fkey" FOREIGN KEY ("market_id", "account_id") REFERENCES "identity"."accounts"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Hand-written (database-designer): docs/design/data/identity.md sections 2 (C1, C6) and 3.4.
-- A code column (revoked_reason, outcome) holds lower-case segments joined by "." (sign-out,
-- password-changed, credentials.invalid), at most 64 characters.
ALTER TABLE "identity"."sessions"
  ADD CONSTRAINT "sessions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "sessions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "sessions_population_check" CHECK ("population" IN ('customer', 'seller', 'admin')),
  ADD CONSTRAINT "sessions_seller_id_check" CHECK (("population" = 'seller') = ("seller_id" IS NOT NULL)),
  ADD CONSTRAINT "sessions_token_hash_check" CHECK (octet_length("token_hash") = 32),
  ADD CONSTRAINT "sessions_transport_check" CHECK ("transport" IN ('cookie', 'bearer')),
  ADD CONSTRAINT "sessions_idle_timeout_seconds_check" CHECK ("idle_timeout_seconds" > 0),
  ADD CONSTRAINT "sessions_absolute_expires_at_check" CHECK ("absolute_expires_at" > "created_at"),
  ADD CONSTRAINT "sessions_revoked_reason_check" CHECK (
    "revoked_reason" ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$' AND char_length("revoked_reason") <= 64),
  ADD CONSTRAINT "sessions_revoked_check" CHECK (("revoked_at" IS NULL) = ("revoked_reason" IS NULL));

-- Hand-written (database-designer): docs/design/data/identity.md section 3.5 (D 6.8). The kinds
-- are the closed list of D 6.8, second-factor.account (HF2) included, so slice 7 alters nothing.
ALTER TABLE "identity"."sign_in_throttles"
  ADD CONSTRAINT "sign_in_throttles_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "sign_in_throttles_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "sign_in_throttles_kind_check" CHECK ("kind" IN (
    'sign-in.account-origin', 'sign-in.account', 'sign-in.origin',
    'second-factor.account', 'mail.account', 'mail.origin')),
  ADD CONSTRAINT "sign_in_throttles_key_hash_check" CHECK (octet_length("key_hash") = 32),
  ADD CONSTRAINT "sign_in_throttles_account_key_check" CHECK (
    ("account_key" IS NULL) = ("kind" IN ('sign-in.origin', 'mail.origin'))
    AND ("account_key" IS NULL OR octet_length("account_key") = 32)),
  ADD CONSTRAINT "sign_in_throttles_attempts_check" CHECK ("attempts" >= 0);

-- Hand-written (database-designer): docs/design/data/identity.md section 3.6 (D 10.2, I8).
ALTER TABLE "identity"."sign_in_records"
  ADD CONSTRAINT "sign_in_records_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "sign_in_records_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "sign_in_records_population_check" CHECK ("population" IN ('customer', 'seller', 'admin')),
  ADD CONSTRAINT "sign_in_records_outcome_check" CHECK (
    "outcome" ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$' AND char_length("outcome") <= 64),
  ADD CONSTRAINT "sign_in_records_correlation_id_check" CHECK ("correlation_id" ~ '^[A-Za-z0-9._-]{8,128}$');

-- Hand-written (database-designer): docs/design/data/identity.md section 8.4, revocation of every
-- session of a seller (D 3.3, 3.5). Not "AND revoked_at IS NULL": the foreign-key check of slice
-- 5 could not use it. Invisible to Prisma; checked by the partial-index catalog test.
CREATE INDEX "sessions_market_id_seller_id_seller_idx" ON "identity"."sessions" ("market_id", "seller_id") WHERE "seller_id" IS NOT NULL;

-- Grants (database-designer): docs/design/data/identity.md section 7
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."sessions" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."sign_in_throttles" TO "mondapac_app";
GRANT SELECT, INSERT, DELETE ON TABLE "identity"."sign_in_records" TO "mondapac_app";
