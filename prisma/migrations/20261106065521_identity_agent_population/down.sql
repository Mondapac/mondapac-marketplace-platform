-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Reverses 20261106065521_identity_agent_population. It fails while an agent account, session,
-- sign-in record or invitation exists, which is right: dropping the agent population must not
-- silently orphan or delete them.
DROP INDEX "identity"."invitations_market_id_agent_account_id_pending_key";
DROP INDEX "identity"."invitations_market_id_agent_account_id_idx";
DROP INDEX "identity"."invitations_market_id_email_agent_pending_key";
DROP INDEX "identity"."invitations_market_id_email_pending_platform_key";
CREATE UNIQUE INDEX "invitations_market_id_email_pending_platform_key"
  ON "identity"."invitations" ("market_id", "email_normalized")
  WHERE "state" = 'pending' AND "seller_id" IS NULL;

ALTER TABLE "identity"."invitations"
  DROP CONSTRAINT "invitations_agent_pending_code_check",
  DROP CONSTRAINT "invitations_handover_failed_attempts_check",
  DROP CONSTRAINT "invitations_handover_code_hmac_check",
  DROP CONSTRAINT "invitations_agent_columns_check",
  DROP CONSTRAINT "invitations_role_id_check",
  DROP CONSTRAINT "invitations_seller_id_check",
  DROP CONSTRAINT "invitations_display_name_kind_check",
  DROP CONSTRAINT "invitations_kind_check",
  ADD CONSTRAINT "invitations_kind_check"
    CHECK ("kind" IN ('seller-owner', 'staff', 'admin')),
  ADD CONSTRAINT "invitations_display_name_kind_check" CHECK (
    "display_name" IS NULL OR ("kind" = 'seller-owner' AND "state" = 'pending')),
  ADD CONSTRAINT "invitations_seller_id_check" CHECK (("kind" = 'admin') = ("seller_id" IS NULL));

ALTER TABLE "identity"."invitations"
  DROP COLUMN "agent_account_id",
  DROP COLUMN "handover_code_hmac",
  DROP COLUMN "handover_failed_attempts",
  ALTER COLUMN "role_id" SET NOT NULL;

ALTER TABLE "identity"."sign_in_records" DROP CONSTRAINT "sign_in_records_population_check";
ALTER TABLE "identity"."sign_in_records"
  ADD CONSTRAINT "sign_in_records_population_check"
    CHECK ("population" IN ('customer', 'seller', 'admin'));
ALTER TABLE "identity"."sessions" DROP CONSTRAINT "sessions_population_check";
ALTER TABLE "identity"."sessions"
  ADD CONSTRAINT "sessions_population_check"
    CHECK ("population" IN ('customer', 'seller', 'admin'));
ALTER TABLE "identity"."accounts" DROP CONSTRAINT "accounts_population_check";
ALTER TABLE "identity"."accounts"
  ADD CONSTRAINT "accounts_population_check"
    CHECK ("population" IN ('customer', 'seller', 'admin'));
