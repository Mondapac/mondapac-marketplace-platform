-- CreateTable
CREATE TABLE "platform"."subject_keys" (
    "subject_id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL,
    "wrapped_key" TEXT,
    "wrapping_key_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,
    "rewrapped_at" TIMESTAMPTZ(6),
    "destroyed_at" TIMESTAMPTZ(6),

    CONSTRAINT "subject_keys_pkey" PRIMARY KEY ("subject_id")
);

-- Hand-written (database-designer): docs/design/data/identity.md sections 2 (C1) and 3.2.
-- The wrapped-key limit stands until Kazem fixes the format (data design 11.4, K1).
ALTER TABLE "platform"."subject_keys"
  ADD CONSTRAINT "subject_keys_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "subject_keys_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "subject_keys_key_version_check" CHECK ("key_version" >= 1),
  ADD CONSTRAINT "subject_keys_wrapped_key_check" CHECK (char_length("wrapped_key") <= 1024),
  ADD CONSTRAINT "subject_keys_wrapping_key_id_check" CHECK (char_length("wrapping_key_id") BETWEEN 1 AND 128),
  ADD CONSTRAINT "subject_keys_tombstone_check" CHECK (("destroyed_at" IS NULL) = ("wrapped_key" IS NOT NULL));

-- Hand-written (database-designer): docs/design/data/identity.md 3.2. The tombstone is one-way
-- and the identity columns are frozen, for every role, the owner included (PF 4 row 5).
CREATE FUNCTION "platform"."subject_keys_guard_update"() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."destroyed_at" IS NOT NULL THEN
    RAISE EXCEPTION 'platform.subject_keys: a destroyed key cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW."subject_id", NEW."market_id", NEW."tenant_id", NEW."key_version", NEW."created_at")
     IS DISTINCT FROM
     (OLD."subject_id", OLD."market_id", OLD."tenant_id", OLD."key_version", OLD."created_at") THEN
    RAISE EXCEPTION 'platform.subject_keys: identity columns are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "subject_keys_one_way"
  BEFORE UPDATE ON "platform"."subject_keys"
  FOR EACH ROW EXECUTE FUNCTION "platform"."subject_keys_guard_update"();

-- Grants (database-designer): docs/design/data/identity.md section 7
GRANT SELECT, INSERT, UPDATE ("wrapped_key", "wrapping_key_id", "rewrapped_at", "destroyed_at") ON TABLE "platform"."subject_keys" TO "mondapac_app";
