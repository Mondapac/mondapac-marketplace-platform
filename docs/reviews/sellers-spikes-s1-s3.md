# Sellers data design: spikes S1, S2 and S3 (evidence)

**Owner:** Hossein (backend), with Mojtaba (O4 of `docs/design/data/sellers.md` 14.4).
**Measured:** 2026-10-07, Prisma 7.10.0, Node 24.20.0, PostgreSQL 16.15 (CI and Compose run 17,
a different major version: the extension half of S1 is also proven on 17 by the CI of PR #72; the
collation, S2 and S3 results were **not re-run on 17**), non-superuser migration role `mondapac_migrator`
that owns the database, scratch database dropped afterwards. The scratch schema was a two-model
excerpt of the design (`seller_files`, `business_file_revisions`) added to a copy of
`prisma/schema/`; no repository file changed.

## S1. Drift check against the extension and against `COLLATE "C"`

| Question | Result |
|---|---|
| Does `prisma migrate diff --from-config-datasource --to-schema prisma/schema --exit-code` (the last step of `pnpm db:check-reversible`) report the `btree_gist` extension in schema `extensions`? | **No.** Exit 0, "No difference detected", with the extension installed and `extensions` outside `datasource.schemas`. Shown in PR P2 by `pnpm db:check-reversible` itself. |
| Does it see a column created `text COLLATE "C"` that the Prisma model declares as plain `String`? | **No difference reported** (exit 0), although `\d` shows collation `C` on the column. |

Consequences:
- Condition of PR P2 (Ali, O1) is met for the extension.
- `COLLATE "C"` on `store_name_key` and `slug` works with the plain migration + hand-written
  `COLLATE "C"` in the generated `CREATE TABLE`, so the `bytea` fallback of data design 9.5 is **not
  needed**.
- Prisma is **blind** to the collation in both directions: dropping or changing it would not show as
  drift. The slice that creates those columns must add a catalog test that reads
  `pg_attribute.attcollation` for `store_name_key` and `slug` (same pattern as the partial-index list
  of 9.5).

## S2. Composite pointer FKs whose fields overlap the primary key

Model: `seller_files` (PK `seller_id`, unique `(market_id, seller_id)`), `business_file_revisions`
(PK `id`, unique `(market_id, seller_id, id)`); relation `[marketId, sellerId, approvedRevisionId]` →
`[marketId, sellerId, id]` (the pointer) beside `[marketId, sellerId]` → `[marketId, sellerId]` (owner).

| Question | Result |
|---|---|
| Does `prisma validate` accept relation fields that overlap the primary key? | **Yes.** |
| What SQL does the diff generate? | The expected two FKs: `FOREIGN KEY ("market_id", "seller_id", "approved_revision_id") REFERENCES …("market_id", "seller_id", "id")` and the owner FK. Add `onUpdate: Restrict` next to `onDelete: Restrict` to the pointer and owner relations: Prisma's default `ON UPDATE CASCADE` would otherwise be generated. |
| Does the generated client allow setting the pointer? | Yes: `SellersSellerFileUncheckedUpdateInput` has `approvedRevisionId`, and `where: { marketId, sellerId: { in } }` filters are unaffected. |
| Is the same-seller rule enforced by the database? | **Yes.** Pointing `b`'s file at `a`'s revision fails (`23503`); `MATCH SIMPLE` leaves a NULL pointer unchecked; changing `market_id` of a referenced file is refused. |

The fallback of data design 9.5 (pointer FK on `(market_id, id)` and the same-seller rule in the
aggregate) is **not needed**: slices 5, 7a-decide and 12 use the three-column pointer FK.

## S3. A single-statement `CREATE INDEX CONCURRENTLY` migration

A migration file whose only statement is `CREATE INDEX CONCURRENTLY …` was applied by
`prisma migrate deploy` without error and recorded as finished in `_prisma_migrations`; the index
was built and is valid. So the rule of data design 9.3 holds: a hand-written `CONCURRENTLY` index
goes **alone in its own migration file**.

Notes for the slices that use it (migrations 3, 4, 7, 8, 12 when a deployed environment holds rows):
- A plain (non-partial) index must also be declared in `prisma/schema/sellers.prisma` with the same
  `map:` name; otherwise the next `migrate diff` reports "Removed index" (measured). Partial indexes
  stay invisible to Prisma and are listed for the catalog test (9.5).
- The file needs `down.sql` like any migration (`DROP INDEX`, without `CONCURRENTLY` since `down.sql`
  runs in one `query` call in `check-migrations-reversible.mjs`).

## Conditions for the slices that use these results

- Slice 2 and slice 5 re-prove, under CI's PostgreSQL 17, the `attcollation` test of S1, the
  same-seller composite FK of S2 (also once as `mondapac_api`, which holds fewer privileges than
  the migration role) and the single-statement `CONCURRENTLY` migration of S3, including
  `indisvalid` and `indisready` of each index built that way.
