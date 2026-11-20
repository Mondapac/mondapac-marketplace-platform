-- Identity: an admin invitation to a sensitive role waits for another admin's approval (owner
-- decision of 18 Nov 2026). Sensitive: the Platform Administrator (the platform system role) or a
-- role that confers a protected permission (R11). Where area people is reviewed, the invitation is
-- stored pending and held: no issue event, so no mail and no token; the approval of its System
-- request releases it and the mail goes as for any invitation. The address stays where a pending
-- invitation already keeps it (this row), never in the request's values.
--   1. invitations.held_for_approval: false for every row so far. The table grant covers it.
--   2. Held only on a pending admin invitation without a token.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

-- AlterTable
ALTER TABLE "identity"."invitations" ADD COLUMN "held_for_approval" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "identity"."invitations"
  ADD CONSTRAINT "invitations_held_for_approval_check" CHECK (
    NOT "held_for_approval"
    OR ("state" = 'pending' AND "kind" = 'admin' AND "token_hash" IS NULL));
