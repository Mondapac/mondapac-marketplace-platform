-- Reverses 20261118140600_identity_invitation_held_for_approval. Refuses to run while an
-- invitation is held: without the column it would read as an issued one that a re-send could
-- mail before its approval. Revoke them, or let their approvals finish, first.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "identity"."invitations" WHERE "held_for_approval") THEN
    RAISE EXCEPTION 'identity: held invitations exist; cannot drop held_for_approval';
  END IF;
END $$;

ALTER TABLE "identity"."invitations" DROP CONSTRAINT "invitations_held_for_approval_check";
ALTER TABLE "identity"."invitations" DROP COLUMN "held_for_approval";
