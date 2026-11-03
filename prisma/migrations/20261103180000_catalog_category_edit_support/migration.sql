-- Categories package C3a (plan sections 4 and 8): what the tree editor needs beyond the C2 model.
--  1. `hidden_by_id`: the category whose Hide cascaded to this one. NULL for a category hidden by
--     its own Hide (or created hidden). Show restores exactly the nodes that name the shown
--     category here, so a child an admin hid on its own stays hidden.
--  2. The app role may now change the slug (the use case writes the old slug into
--     `platform_category_slug_history` in the same unit; the C2 trigger keeps another category
--     from taking a slug retired in the last 12 months).
SET lock_timeout = '5s';

ALTER TABLE "catalog"."platform_categories" ADD COLUMN "hidden_by_id" UUID;

ALTER TABLE "catalog"."platform_categories"
  ADD CONSTRAINT "platform_categories_hidden_by_check" CHECK (
    "hidden_by_id" IS NULL OR ("status" = 'hidden' AND "hidden_by_id" <> "id")),
  ADD CONSTRAINT "platform_categories_market_id_hidden_by_id_fkey"
    FOREIGN KEY ("market_id", "hidden_by_id") REFERENCES "catalog"."platform_categories"("market_id", "id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

GRANT UPDATE ("slug", "hidden_by_id") ON TABLE "catalog"."platform_categories" TO "mondapac_app";
