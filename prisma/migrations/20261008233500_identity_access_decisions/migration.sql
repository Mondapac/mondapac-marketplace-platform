-- CreateTable
CREATE TABLE "identity"."access_decisions" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "seller_id" UUID NOT NULL,
    "decision" TEXT NOT NULL,
    "reason_ciphertext" TEXT,
    "basis_id" UUID,
    "decided_by_account_id" UUID,
    "decided_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "access_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "access_decisions_market_id_seller_id_decided_at_idx" ON "identity"."access_decisions"("market_id", "seller_id", "decided_at");

-- AddForeignKey
ALTER TABLE "identity"."access_decisions" ADD CONSTRAINT "access_decisions_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "identity"."seller_access"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written (database-designer): docs/design/data/identity.md sections 2 (C1, C2, C4) and
-- 3.11 (D 2.1, 3.3, 10.1, 11.3; decision 9; H6). The table is new: no backfill and no statement
-- on an existing table (8.2).
--
-- access_decisions: one row per decision on a seller's access, never changed (append-only by
-- privilege, section 7). A rejection and a suspension carry their reason, encrypted under the
-- seller's subject key; an approval and a reinstatement carry none: decision 9 as far as a
-- constraint can carry it ("non-empty" is the domain's). `basis_id` and
-- `decided_by_account_id` are plain ids (C4).
ALTER TABLE "identity"."access_decisions"
  ADD CONSTRAINT "access_decisions_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "access_decisions_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "access_decisions_decision_check" CHECK (
    "decision" IN ('approved', 'rejected', 'suspended', 'reinstated')),
  ADD CONSTRAINT "access_decisions_reason_check" CHECK (
    ("decision" IN ('rejected', 'suspended')) = ("reason_ciphertext" IS NOT NULL));

-- Grants (database-designer): docs/design/data/identity.md section 7
GRANT SELECT, INSERT ON TABLE "identity"."access_decisions" TO "mondapac_app";
