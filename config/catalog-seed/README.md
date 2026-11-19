# Catalog seed per Market

One `<MARKET>.json` per Market: the starter category tree and attribute set that the catalog
seed jobs (`catalog.seed-category-tree`, `catalog.seed-attributes`) create at worker start
(catalog design 7.2). A run only creates what is missing, and every name passes the claim-text
check first, so names must not contain a certification claim word.

Shape: `{ market, categories: SeededCategory[], attributes: { definitions, families } }`; the
types are `SeededCategory` and `SeededDefinition`/`SeededFamily` in
`apps/api/src/modules/catalog/application/ports/`. A file that does not parse stops the
start-up. `AU.json` is a starter set until slice 21.

`cultures` (optional, multi-culture package 1, ADR-0047): the first cultures of the Market, created
by the `catalog.seed-cultures` job when missing and never overwritten. Each has a fixed `code`,
`displayOrder`, an optional `requiredCertificationType` (a type code that
`config/certification-seed/<MARKET>.json` creates), an optional `badgeColour` token, `isDefault`
(applied only while the Market has no default) and `names` (`locale`, `name`, `description`; the
Market's default locale needs both). Seeded codes and texts go through the claim-term matcher like every other write and fail closed, so a culture is never named after a certification (halal is shown only by the certification badge).
