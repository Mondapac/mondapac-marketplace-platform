-- Safety: a blocked statement fails instead of queueing.
SET lock_timeout = '5s';

-- Order detail (decision 3, 31 Oct 2026): admins' internal notes on an order. Never shown to the
-- customer or the seller (a seller's own notes live in a table of their own). A note is written
-- once and never changed or removed: the application role may only insert and read.
-- Free text (ordering data design O8, mini-review in this change): the text is never stored in
-- clear. It is sealed under the order's customer account subject key (label
-- ordering.admin-order-note.body), so erasing the customer also makes every note about them
-- unreadable. Only the author and the time are in clear.

-- CreateTable
CREATE TABLE "ordering"."admin_order_notes" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "order_id" UUID NOT NULL,
    "author_account_id" UUID NOT NULL,
    "body_ciphertext" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "admin_order_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_order_notes_market_id_order_id_created_at_idx" ON "ordering"."admin_order_notes"("market_id", "order_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "ordering"."admin_order_notes" ADD CONSTRAINT "admin_order_notes_market_id_order_id_fkey" FOREIGN KEY ("market_id", "order_id") REFERENCES "ordering"."orders"("market_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Hand-written: scope and value checks of the new table (empty, so no NOT VALID step). The
-- plaintext limit (1 to 2000 characters after trimming) is the application's; the database checks
-- the sealed value's shape and bounds (data design O7, as for the sealed delivery address), so a
-- body in clear is refused.
ALTER TABLE "ordering"."admin_order_notes"
  ADD CONSTRAINT "admin_order_notes_market_id_check" CHECK ("market_id" ~ '^[A-Z][A-Z0-9_]{1,7}$'),
  ADD CONSTRAINT "admin_order_notes_tenant_id_check" CHECK ("tenant_id" ~ '^[a-z][a-z0-9-]{1,31}$'),
  ADD CONSTRAINT "admin_order_notes_body_ciphertext_check" CHECK (
    "body_ciphertext" ~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'
    AND char_length("body_ciphertext") BETWEEN 41 AND 16384
  );

-- Grants: insert and read only (no UPDATE or DELETE: a note is never changed or removed).
GRANT SELECT, INSERT ON TABLE "ordering"."admin_order_notes" TO "mondapac_app";
