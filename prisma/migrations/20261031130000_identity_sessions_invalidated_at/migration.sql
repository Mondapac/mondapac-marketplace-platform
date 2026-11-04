-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- The latest time the sessions of an account were ended in bulk for a reason other than a sign-out
-- (a password reset or change, a second factor change or reset, "sign out elsewhere", a disabled
-- account, an erasure). NULL = never. A background job that a session started (the platform import,
-- catalog design 14a) runs on as that admin only while this is earlier than the session's creation:
-- a bulk revocation skips a session that is already revoked, so a session that signed out first
-- left no trace of the later reset (Hassan M-585-1). One nullable column, no default, no index
-- (it is read with the account row, by primary key): a metadata-only change. The update that sets
-- it does not touch an indexed column, so it can be a HOT update.
ALTER TABLE "identity"."accounts" ADD COLUMN "sessions_invalidated_at" TIMESTAMPTZ(6);
