-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "sellers";

-- CreateTable
CREATE TABLE "sellers"."seller_files" (
    "seller_id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "store_name_key" TEXT,
    "approved_revision_id" UUID,

    CONSTRAINT "seller_files_pkey" PRIMARY KEY ("seller_id")
);

-- CreateTable
CREATE TABLE "sellers"."business_file_revisions" (
    "id" UUID NOT NULL,
    "market_id" VARCHAR(8) NOT NULL,
    "seller_id" UUID NOT NULL,

    CONSTRAINT "business_file_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "seller_files_market_id_seller_id_key" ON "sellers"."seller_files"("market_id", "seller_id");

-- CreateIndex
CREATE UNIQUE INDEX "business_file_revisions_market_id_seller_id_id_key" ON "sellers"."business_file_revisions"("market_id", "seller_id", "id");

-- AddForeignKey
ALTER TABLE "sellers"."seller_files" ADD CONSTRAINT "seller_files_market_id_seller_id_approved_revision_id_fkey" FOREIGN KEY ("market_id", "seller_id", "approved_revision_id") REFERENCES "sellers"."business_file_revisions"("market_id", "seller_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "sellers"."business_file_revisions" ADD CONSTRAINT "business_file_revisions_market_id_seller_id_fkey" FOREIGN KEY ("market_id", "seller_id") REFERENCES "sellers"."seller_files"("market_id", "seller_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

