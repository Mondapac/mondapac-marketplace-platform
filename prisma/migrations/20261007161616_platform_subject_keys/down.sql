-- Reverses 20261007161616_platform_subject_keys (docs/design/data/identity.md 8.2): the grants
-- first, then the trigger, the table with its CHECKs, and the hand-written function.
REVOKE SELECT, INSERT, UPDATE ("wrapped_key", "wrapping_key_id", "rewrapped_at", "destroyed_at") ON TABLE "platform"."subject_keys" FROM "mondapac_app";
DROP TRIGGER "subject_keys_one_way" ON "platform"."subject_keys";
DROP TABLE "platform"."subject_keys";
DROP FUNCTION "platform"."subject_keys_guard_update"();
