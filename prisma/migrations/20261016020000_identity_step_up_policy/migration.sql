-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Seller OTP policy (per-action two-step code): the seller's own rules, and the fresh-code proofs
-- of a session. New tables, plus one unique index on identity.sessions(market_id, id) that the proofs' composite foreign key needs (it blocks session writes while it builds, guarded by lock_timeout; sessions is small).

-- CreateTable
CREATE TABLE "identity"."seller_step_up_policies" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "action_key" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL,
    "updated_by_account_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "version" INTEGER NOT NULL,

    CONSTRAINT "seller_step_up_policies_pkey" PRIMARY KEY ("market_id","seller_id","action_key")
);

-- CreateTable
CREATE TABLE "identity"."step_up_proofs" (
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "session_id" UUID NOT NULL,
    "action_key" TEXT NOT NULL,
    "verified_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "step_up_proofs_pkey" PRIMARY KEY ("market_id","session_id","action_key")
);

-- CreateIndex
CREATE UNIQUE INDEX "sessions_market_id_id_key" ON "identity"."sessions"("market_id", "id");

-- CreateIndex

-- AddForeignKey
ALTER TABLE "identity"."seller_step_up_policies" ADD CONSTRAINT "seller_step_up_policies_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "identity"."seller_access"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "identity"."step_up_proofs" ADD CONSTRAINT "step_up_proofs_market_id_session_id_fkey" FOREIGN KEY ("market_id", "session_id") REFERENCES "identity"."sessions"("market_id", "id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- Hand-written: scope and value checks.
ALTER TABLE "identity"."seller_step_up_policies"
  ADD CONSTRAINT "seller_step_up_policies_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "seller_step_up_policies_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "seller_step_up_policies_action_key_check" CHECK ("action_key" ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,3}$' AND length("action_key") <= 80),
  ADD CONSTRAINT "seller_step_up_policies_version_check" CHECK ("version" >= 1);

ALTER TABLE "identity"."step_up_proofs"
  ADD CONSTRAINT "step_up_proofs_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "step_up_proofs_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "step_up_proofs_action_key_check" CHECK ("action_key" ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,3}$' AND length("action_key") <= 80);

GRANT SELECT, INSERT, UPDATE ON TABLE "identity"."seller_step_up_policies" TO "mondapac_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."step_up_proofs" TO "mondapac_app";
