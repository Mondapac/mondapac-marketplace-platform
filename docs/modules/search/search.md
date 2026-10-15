# Search: product search (speed mode, Phase 6 package 2)

PostgreSQL full-text search only (ADR-0004 decision 1); Elasticsearch needs a new ADR.

- **Read model:** `search.offer_documents`, one row per sellable (published and listed) Offer per
  Market: offer, product and seller ids, name and short text of the product's published revision in
  the Market's default locale, platform category ids, `search_vector`, `indexed_at`. The vector is
  built by a trigger from name (weight A) and short text (B) with the row's `text_search_config`; a
  GIN index serves the text query, another the category filter. No certification claim is indexed or
  returned: badges come from `evaluateClaim` only (CERT rules); results carry ids, text and categories.
- **Market settings:** `search.textSearchConfig` in `config/markets/<CODE>.json` (AU `english`, the ZZ
  fixture `simple`; a closed list of built-in configurations; absent = `simple`). The locale is the
  Market's `defaultLocale`; an Offer with no text in it is not indexed. Never a default Market.
- **Freshness:** subscriptions to `catalog.offer-published`, `offer-deleted`, `offer-moved` and
  `product-revision-published` call `search.sync-offer-documents` (system). It re-reads catalog through
  `CatalogIndexFacade` (`offerSearchFacts`, `publishedOfferIds`; system only) and upserts or deletes, so
  repeated and out-of-order deliveries converge (no inbox needed). The job `search.rebuild-index` runs
  at worker start and every six hours: it backfills all published Offers and deletes documents it did
  not touch. Run it after changing `textSearchConfig`.
- **Query:** `GET /search/products?q=&category=&page=&pageSize=` (anonymous, Market from `x-market-id`
  like other storefront routes, default rate-limit class per origin, `no-store`). `q` 2 to 100
  characters in web-search syntax (`websearch_to_tsquery`, ranked by `ts_rank`, ties by Offer id, so
  pages are stable); no `q` with `category` browses by name; `pageSize` 1 to 48 (24), `page` 1 to 100;
  unknown parameters are 400. Answer: `{ items, page, pageSize, hasMore }`.
- **Visibility:** each page is re-checked against catalog (`offerSellUnits`: published and listed) and
  sellers (`sellingEligibility`, the may-sell contract). A failed check is 503 `search.unavailable`,
  never an unchecked list. A page can hold fewer than `pageSize` items while `hasMore` is true.
- **SQL:** the two statements are on the ADR-0030 list (`search.offer-search`, `search.offer-browse`),
  all values bound; ADR-0030 was amended for `websearch_to_tsquery`, `ts_rank`, `@@`, `@>`, `regconfig`.
- **Known gaps:** sellers has no separate "show publicly" read, so may-sell is the test. An off-sale
  cause that raises no event (for example a suspended tag) is hidden at query time and repaired by the
  next rebuild. A write racing a delete can briefly resurrect a document; the query-time check hides it.
  A deep, mostly hidden result set can return short pages. Variants, price, stock, ratings and
  certification badges are not part of this package.
