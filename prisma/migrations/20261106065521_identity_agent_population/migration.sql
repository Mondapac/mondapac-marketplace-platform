-- AlterTable
ALTER TABLE "identity"."invitations" ADD COLUMN     "agent_account_id" UUID,
ADD COLUMN     "handover_code_hmac" BYTEA,
ADD COLUMN     "handover_failed_attempts" SMALLINT,
ALTER COLUMN "role_id" DROP NOT NULL;

-- Hand-written (database-designer): docs/modules/agents/data.md section 5 (PR 0) and ADR-0045.
-- 1. The agent population joins every population CHECK of schema identity. The new CHECK is added
--    NOT VALID, validated, and only then replaces the old one, so no table is rewritten.
ALTER TABLE "identity"."accounts"
  ADD CONSTRAINT "accounts_population_check_v2"
    CHECK ("population" IN ('customer', 'seller', 'admin', 'agent')) NOT VALID;
ALTER TABLE "identity"."accounts" VALIDATE CONSTRAINT "accounts_population_check_v2";
ALTER TABLE "identity"."accounts" DROP CONSTRAINT "accounts_population_check";
ALTER TABLE "identity"."accounts"
  RENAME CONSTRAINT "accounts_population_check_v2" TO "accounts_population_check";

ALTER TABLE "identity"."sessions"
  ADD CONSTRAINT "sessions_population_check_v2"
    CHECK ("population" IN ('customer', 'seller', 'admin', 'agent')) NOT VALID;
ALTER TABLE "identity"."sessions" VALIDATE CONSTRAINT "sessions_population_check_v2";
ALTER TABLE "identity"."sessions" DROP CONSTRAINT "sessions_population_check";
ALTER TABLE "identity"."sessions"
  RENAME CONSTRAINT "sessions_population_check_v2" TO "sessions_population_check";

ALTER TABLE "identity"."sign_in_records"
  ADD CONSTRAINT "sign_in_records_population_check_v2"
    CHECK ("population" IN ('customer', 'seller', 'admin', 'agent')) NOT VALID;
ALTER TABLE "identity"."sign_in_records" VALIDATE CONSTRAINT "sign_in_records_population_check_v2";
ALTER TABLE "identity"."sign_in_records" DROP CONSTRAINT "sign_in_records_population_check";
ALTER TABLE "identity"."sign_in_records"
  RENAME CONSTRAINT "sign_in_records_population_check_v2" TO "sign_in_records_population_check";

-- 2. The agent invitation (ADR-0045 decision 2) is a kind of the existing invitation: no seller
--    and no role (an agent holds none), the invitee's name while pending (the account is created
--    with it at acceptance), the HMAC of the handover code and its failed attempts, and the id
--    the account will have. The agent columns exist for the agent kind only.
ALTER TABLE "identity"."invitations"
  DROP CONSTRAINT "invitations_kind_check",
  DROP CONSTRAINT "invitations_display_name_kind_check",
  DROP CONSTRAINT "invitations_seller_id_check",
  ADD CONSTRAINT "invitations_kind_check"
    CHECK ("kind" IN ('seller-owner', 'staff', 'admin', 'agent')),
  ADD CONSTRAINT "invitations_display_name_kind_check" CHECK (
    "display_name" IS NULL OR ("kind" IN ('seller-owner', 'agent') AND "state" = 'pending')),
  ADD CONSTRAINT "invitations_seller_id_check"
    CHECK (("kind" IN ('admin', 'agent')) = ("seller_id" IS NULL)),
  ADD CONSTRAINT "invitations_role_id_check" CHECK (("kind" = 'agent') = ("role_id" IS NULL)),
  ADD CONSTRAINT "invitations_agent_columns_check" CHECK (
    ("kind" = 'agent') = ("agent_account_id" IS NOT NULL)
    AND ("kind" = 'agent') = ("handover_failed_attempts" IS NOT NULL)
    AND ("handover_code_hmac" IS NULL OR ("kind" = 'agent' AND "state" = 'pending'))),
  ADD CONSTRAINT "invitations_handover_code_hmac_check"
    CHECK (octet_length("handover_code_hmac") = 32),
  ADD CONSTRAINT "invitations_handover_failed_attempts_check"
    CHECK ("handover_failed_attempts" BETWEEN 0 AND 5);

-- A pending agent invitation needs its handover code; a decided one holds none.
ALTER TABLE "identity"."invitations"
  ADD CONSTRAINT "invitations_agent_pending_code_check" CHECK (
    "kind" <> 'agent' OR ("state" = 'pending') = ("handover_code_hmac" IS NOT NULL));

-- The platform-scope pending index is the admin's: an agent invitation to the same address is a
-- different person-in-a-different-population (accounts are unique per population too), so it has
-- an index of its own.
DROP INDEX "identity"."invitations_market_id_email_pending_platform_key";
CREATE UNIQUE INDEX "invitations_market_id_email_pending_platform_key"
  ON "identity"."invitations" ("market_id", "email_normalized")
  WHERE "state" = 'pending' AND "seller_id" IS NULL AND "kind" <> 'agent';
CREATE UNIQUE INDEX "invitations_market_id_email_agent_pending_key"
  ON "identity"."invitations" ("market_id", "email_normalized")
  WHERE "kind" = 'agent' AND "state" = 'pending';
-- agentAccessOf reads the invitation by the account id it reserved.
CREATE INDEX "invitations_market_id_agent_account_id_idx"
  ON "identity"."invitations" ("market_id", "agent_account_id")
  WHERE "kind" = 'agent';
