# Catalog seed per Market

One `<MARKET>.json` per Market: the starter category tree and attribute set that the catalog
seed jobs (`catalog.seed-category-tree`, `catalog.seed-attributes`) create at worker start
(catalog design 7.2). A run only creates what is missing, and every name passes the claim-text
check first, so names must not contain a certification claim word.

Shape: `{ market, categories: SeededCategory[], attributes: { definitions, families } }`; the
types are `SeededCategory` and `SeededDefinition`/`SeededFamily` in
`apps/api/src/modules/catalog/application/ports/`. A file that does not parse stops the
start-up. `AU.json` is a starter set until slice 21.
