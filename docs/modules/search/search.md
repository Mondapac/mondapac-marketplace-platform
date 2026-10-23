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
- **Suspended sellers (seller operations P-D):** a sync also asks the may-sell contract, so an Offer
  whose seller may not sell gets no document (a rebuild keeps it out too). `identity.seller-access-
  suspended` and `-reinstated` sync every Offer of that seller (its documents plus catalog's
  `publishedOfferIds` with `sellerId`). A failed may-sell read is `sellers.unavailable` for the
  system actor, so the sync throws and is retried rather than dropping sellers who may sell. Reads
  still check may-sell on every request.
- **Query:** `GET /search/products?q=&category=&page=&pageSize=` (anonymous, Market from `x-market-id`
  like other storefront routes, default rate-limit class per origin, `no-store`). `q` 2 to 100
  characters in web-search syntax (`websearch_to_tsquery`, ranked by `ts_rank`, ties by Offer id, so
  pages are stable); no `q` with `category` browses by name; `category` covers its live
  subcategories: search reads catalog's public category tree (`CATALOG_ASSISTANT_FACADE.categories`,
  rule `anonymous`, the caller's context) and filters on the category and every category under it
  (at most 1000, array overlap `&&`), so a top-level page lists its subcategories' products without
  indexing ancestors; a tree that cannot be read is `search.unavailable`; a category the live tree
  does not hold filters on itself alone. The same holds for a store's list and the two shelves; `pageSize` 1 to 48 (24), `page` 1 to 100;
  unknown parameters are 400. Answer: `{ items, page, pageSize, hasMore }`; `hasMore` is true only when the next result is visible, so hidden matches never show through it.
- **Visibility:** each page is re-checked against catalog (`offerSellUnits`: published and listed) and
  sellers (`sellingEligibility`, the may-sell contract). A failed check is 503 `search.unavailable`,
  never an unchecked list. A page can hold fewer than `pageSize` items, and `hasMore` can be false while a later page still has items.
- **SQL:** the two statements are on the ADR-0030 list (`search.offer-search`, `search.offer-browse`),
  (text, text in one category, browse), all values bound; ADR-0030 was amended for
  `websearch_to_tsquery`, `ts_rank`, `@@`, `@>`, `&&` (2026-10-23), `regconfig`, each in one exact
  shape.
- **Known gaps:** sellers has no separate "show publicly" read, so may-sell is the test. An off-sale
  cause that raises no event (for example a suspended tag) is hidden at query time and repaired by the
  next rebuild. A write racing a delete can briefly resurrect a document; the query-time check hides it.
  A deep, mostly hidden result set can return short pages. Variants, price, stock, ratings and
  certification badges are not part of this package.
- **Follow-ups (Hassan L-3):** a dedicated rate-limit class for this anonymous route (it uses `default`
  now), and a cap on the number of OR terms in `q`.

## Storefront shelves (storefront reads package, 18 Oct 2026)

- **Routes:** `GET /search/bestsellers?category=&limit=` and `GET /search/specials?category=&limit=`
  (anonymous, `@RoutePopulation('customer')`, default rate-limit class, `no-store`). `limit` 1 to 24
  (storefront's `MAX_SHELF_PRODUCTS`, default 12); `category` is a platform category id; unknown
  parameters are 400.
- **Personal shelves (personalization 1d-1):** `GET /search/for-you?limit=` and `GET
  /engagement/recommendations/recently-viewed?limit=` (limit 1 to 24, default 12; no other query
  field; `no-store`; customer route population, session read; never set a cookie). The shopper is the
  signed-in customer or the engagement guest cookie, read through `ENGAGEMENT_FACADE.recentViews`
  (empty under `Sec-GPC: 1`, with the switch off, or for a guest without `Engagement-Consent:
  granted`). "For you": the Market's best sellers in the categories the shopper viewed (and of the
  products they viewed), without any category certification marks (`certifiedCategoryIds`), then the
  rest of the best sellers, then the browse fill, each Offer once; with no views it is the plain best
  sellers. "Recently viewed": the viewed products sellable now, newest view first, one Offer each,
  certification not a filter. Every Offer is re-checked like best sellers; a failed ordering source,
  check or views read of "recently viewed" is `search.unavailable` (503); a failed views read of "for
  you" falls back to the plain best sellers. Four use cases (`search.list-for-you`,
  `search.list-recently-viewed`: `own-resources`; the `-guest` pair: `anonymous`, in
  `http-reachable-anonymous-system.json`). Items carry `primaryImage` like the other shelves.
- **Best sellers:** ordering's `OrderingRankingFacade.bestSellingOffers` (rule anonymous) ranks Offers
  by order lines on orders confirmed in the last 30 days (ids only, no count leaves ordering); search
  takes the top 100, keeps the indexed ones (in the category when asked) in rank order, and fills a
  short shelf from browse order (the category's `search.offer-browse`, else the Market by name).
- **Specials:** pricing's `PricingSpecialsFacade.specialsInForce` (rule anonymous) answers the (Offer,
  Variant) keys whose effective price is a special at its Clock's now, newest first, with the regular
  price in force; an Offer appears once. Items add `variantId`, `price`, `regularPrice` (Money as
  `{ amount: string, currency }`), `taxInclusive` and `specialEndsAt`. Never Cost.
- **Visibility:** the same re-check as the search route (catalog published and listed, seller may
  sell); a failed source or check is 503 `search.unavailable`. No badge, no stock filter (as search).
- **Product page:** `GET /search/product-detail/:productId` (anonymous, `no-store`, no query string)
  composes the buyer product page. The product's indexed Offers (first 20 by id) are re-checked as
  above; catalog's `publishedProduct` (rule anonymous) gives the published name, texts, categories
  and published Variants in the Market default locale; pricing's `effectivePrices`, inventory's
  `availability` and sellers' `sellerSummaries` give each priced sell unit its buyer price (Money, the
  Market currency only, never Cost), its public stock state (`status` and `onlyLeft`, never the exact
  count) and the seller's public store name and minimum order. Units without a price and Offers
  without a priced unit are left out, Offers come lowest unit price first (ties by Offer id), and at
  most 200 (Offer, Variant) keys are asked. 404 `search.product-not-found` when nothing is left; a
  failed source or check is 503 `search.unavailable`. Adds `images` (at most 8 public photos in the published revision's order: `imageId`, `width`, `height`, `alt`). No attribute, tag or badge yet.
- **Photos:** each item of `search/products`, `bestsellers` and `specials` has `primaryImage` (the same
  `{imageId, width, height, alt}` or `null`). The refs come from catalog's `publishedProductImages`
  (rule anonymous, published revision only, taken-down photos skipped), read for the shown items only;
  `alt` is the product name; `width` and `height` are the largest rendition's pixel size (the ratio
  holds for all sizes). A photo source that fails gives no photo, never an error (photos are not a
  check). The storefront builds the URL from the ids and `STOREFRONT_IMAGE_ORIGIN`; the bytes come
  from catalog's public photo route (catalog design 10.6).
- **Store list:** `GET /search/products?store=<slug>` (3 to 50 characters, a-z, 0-9, single hyphens;
  not with `q`; may combine with `category`) lists one store's Offers by name through
  `PrismaShelfDocumentsReader.browseBySeller` (Prisma, no new raw statement). sellers' facade
  `publishedStoreSellerId` resolves the address under the published-store rules; an unknown, retired
  or not-selling store is an empty page (`hasMore` false), a failed lookup is 503. Every Offer is
  re-checked like any other result. Unknown query parameters stay 400.
- **Known gaps:** the Market-wide fill reads `offer_documents` ordered by name without an index on
  `(market_id, name)`; add one if the read model grows large.
