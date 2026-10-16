-- Reverses 20261016020000_identity_step_up_policy: the grants, then the two tables.
REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "identity"."step_up_proofs" FROM "mondapac_app";
REVOKE SELECT, INSERT, UPDATE ON TABLE "identity"."seller_step_up_policies" FROM "mondapac_app";
DROP TABLE "identity"."step_up_proofs";
DROP TABLE "identity"."seller_step_up_policies";
DROP INDEX "identity"."sessions_market_id_id_key";
