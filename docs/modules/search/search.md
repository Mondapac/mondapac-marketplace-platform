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
- **Follow-ups (Hassan, PR #478, Low):** cache the category tree per Market for a short time in
  `FacadeCategorySubtree` (every category request reads it now); have database-designer EXPLAIN a
  root-category browse at scale and consider a `(market_id, name, offer_id)` index; move the tree
  read from `CATALOG_ASSISTANT_FACADE` to a non-AI catalog facade before any AI gating lands on it.
- **Follow-ups (Hassan L-3):** a dedicated rate-limit class for this anonymous route (it uses `default`
  now; it needs a platform change, see "Sellers and categories in search" below). The cap on the number
  of OR terms in `q` is done (8, `validation.failed` `q` / `too-many-terms`).

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
- **Bought together (personalization 1d-2):** `GET /search/bought-together?offer=<uuid>&limit=` (limit 1
  to 24, default 12; `offer` required; no other query field, a bad uuid or limit is 400; `no-store`
  on every answer; customer route population, no session read). Use case `search.list-bought-together`
  (`anonymous`, in `http-reachable-anonymous-system.json`). Ordering's
  `OrderingRankingFacade.boughtTogether` answers Offer ids (most distinct buyers first, ties by Offer id)
  from `ordering.offer_pairs`, which the nightly job `ordering.rebuild-offer-pairs` (`system`, per
  hosted Market) rebuilds in one transaction: pairs that at least 3 distinct buyer accounts bought together
  (one paid order each, confirmed in the last 90 days, counted by confirmation time like the best
  sellers; the job reads the account id in memory only, every order has an account so none is
  skipped, and the table keeps no account; the `orders` column holds the distinct-buyer count), both directions stored, no count
  leaves ordering. Search drops the asked Offer, keeps the indexed ones in rank order, re-checks each
  with catalog and sellers, and does not fill a short shelf; a failed source or check is
  `search.unavailable` (503). The same item shape as the other shelves.
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
  failed source or check is 503 `search.unavailable`. Adds `images` (at most 8 public photos in the published revision's order: `imageId`, `width`, `height`, `alt`). Adds `variantImages` (for each sold Variant that picked photos: `variantId` and `imageIds`, the picks that are public photos of the product now, main photo first; a Variant not listed shows the product's photos; variants V4). Each Offer adds `badges` (certification badges: `typeCode`, `typeName`, `basis`, `sellerClaim`, `issuerName`, `validUntilLocalDate`, `verifiedWithIssuer`), read in one call of catalog's `offerBadges` for the Offers on the page (rule anonymous, at most 20). Search decides nothing: catalog asks certification's `evaluateClaims` live in the request and copies the badge of the decision (see `catalog.offer-badges` in docs/design/domain/catalog.md, 9.1 "Offer badges"). Badges fail closed and the page does not: a badge source that fails gives `badges: []` on every Offer and a 200. No attribute or tag yet.
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

## Rating boost and Top rated (reviews package 5, 1 Nov 2026)

- **Switch:** `search.ratingBoost.enabled` in the Market file, off by default (AU); the reviews
  switch must also be active. Off: nothing in search changes, `sort=top-rated` answers 400
  `validation.failed` (`sort`/`unavailable`), and the sync clears the copy.
- **What it does:** the relevance of a text search is multiplied by a stored factor of the product
  (`boost_ppm`, 900000 to 1100000, so at most 10 %; the Market's `weightBps` is capped at
  1000 by the config schema and by a table CHECK). The factor comes from the Bayesian average of the
  stars (`priorCount` and `priorMeanTimes100` in the Market file), computed in TypeScript
  (`domain/rating-boost.ts`). A product with no ratings has the prior mean and the neutral factor. The distance from the prior mean is scaled by the room to the nearest end of the scale on
  that side, so the best possible product gets the full boost and the worst the full penalty in every
  Market (john, 1 Nov 2026, PR #627 review M-3).
- **Top rated:** `GET /search/products?sort=top-rated` orders by the stored Bayesian average (products without ratings sit at the prior mean), then by
  Offer id; needs `q` or `category`, and is refused with `store` or `brand`.
- **Copy of the totals:** `search.product_ratings` (written only by the job `search.sync-ratings`, hourly
  and at worker start) holds the star totals read through reviews' public facade
  `productRatingTotals` (rule system, paged by product id). Search never reads reviews' tables. A
  source that fails keeps the old copy.
- **Not built:** a rating shown in the result cards (storefront follow-up); no personalization.


## Attribute filters (attributes A7, 4 Nov 2026)

What a buyer can narrow a list by, and how the index keeps it.

- **Index.** Each `search.offer_documents` row also holds `search_text` (the searchable attribute
  values: brand with its aliases, country of origin, English option labels; weight C in the
  vector, below name and short text) and `facet_codes` (`attribute=value`: option codes with
  merges followed, `true` for a yes switch, `brand=<slug>`, `country-of-origin=<iso, lower case>`).
  Measure values sit in `search.offer_document_numbers`. Catalog supplies them through the index
  facade (`attributes` in the facts); search never reads catalog tables.
- **Filters of a list.** Catalog's anonymous `CatalogFiltersFacade` returns the category's filters
  (its own after its ancestors', each kept while active, allowed as a filter and of a filterable
  type) or the global Brand and Country of origin filters. Search counts the values in its own index.
- **URL.** `filter=<attribute>:<code>[,<code>]` (repeatable; `true` for a switch) and
  `range=<attribute>:<min>..<max>`. Values of one attribute are OR-ed, attributes are AND-ed. At most 8
  choice filters, 3 ranges, 50 values each. A filter with a store or brand list is refused. An
  attribute that is not a filter is ignored; a merged option code is read as its target.
  A filtered URL is `noindex` with the canonical of the category (storefront follow-up).
- **Counts.** Per product, ignoring the attribute's own filter; values with no product are hidden
  except a picked one. Counting reads at most 20,000 rows; above that the page says
  `countsComplete: false` and shows no counts. Range bounds come from the whole scope; if the number read is cut at the same cap, the page is also `countsComplete: false` and shows no bounds. Counts come from the index and do not run the query-time visibility check, so they can briefly include an Offer that just became unsellable.
- **Raw SQL.** Three new statements (ADR-0030 amendment of 4 Nov 2026: `&&` with a `text[]` parameter).
- **Reindex.** `search.reindex-attributes` (every 5 minutes and at start) asks catalog for a stamp
  (definitions' published revisions, brands, aliases). When it differs from the last full run it
  re-reads every published Offer page by page and writes progress to `search.reindex_state`
  (`status`, `offers_done`, `cursor_offer_id`); a failed run resumes after its cursor. The six-hourly
  rebuild still deletes stale documents. There is no admin screen for the progress yet.
- **Not in this package.** The storefront web screens, the measure type (waits for A3), and the
  conversion of the Country of origin attribute to an ISO choice (the indexer already maps a
  select code or free text to an ISO code; the seed and Convert tool wait for A3).

## Variant filters, price on the matching variant, GTIN search (variants V8, 7 Nov 2026)

Plan section 12, decision تن۱۰: the result is the product, once; a variant filter, the price filter
and the card price read only the variants that are in stock.

- **Index.** `search.offer_variant_documents`: one row per published variant of a sellable Offer
  (axis facets as `attribute=<option code>`, merges followed; GTIN as 14 digits; `in_stock` from
  inventory's public status, `in-stock` or `low`; the buyer price from pricing, both price columns
  null when none is in force). Replaced as a set with the document and deleted with it. Catalog's
  index facade gives the variants (`variants` in the facts, published registry state only) and adds
  their labels to `search_text`, so "rice 10kg" finds the 10 kg label. Stock and price come from the
  inventory and pricing facades (system use cases); the exact stock count is never stored.
- **Events.** `inventory.availability-changed.v1` and `pricing.effective-price-changed.v1` re-sync
  that Offer (the payload names it; stock and price are re-read). A variant added or retired comes
  with a revision publish. The six-hourly rebuild repairs a lost delivery.
- **Matching.** A product matches when its own facets satisfy every choice group and no price is
  asked (product attributes keep the A7 behaviour, stock not asked), or when one of its in-stock,
  priced variants satisfies every group together with the product's facets, at a price within
  `price=<min>..<max>` (minor units). Two axes must be held by the same variant. A variant axis is a
  filter of a category the same way as any attribute (the category filter settings of A7).
- **Counts.** Products, never variants: the facet read returns one row per document (its own
  facets, only when no price is asked) and one per in-stock, priced variant within the price, with
  the variant's axis values beside the document's.
- **Result.** Each item has `variantId` (the first matching variant by the owner's order when a
  variant filter or the price narrowed the list, else null: the product page shows its default)
  and `price: { from, varies }` (the lowest price of the matching variants, of all in-stock ones
  when nothing narrowed; null when none). The storefront links to `/p/{productId}?v={variantId}`.
- **GTIN.** A `q` that is exactly a GTIN-8, 12, 13 or 14 with a valid check digit is looked up
  first: when a visible document has a variant with it, the page has `exactMatch` and the storefront
  goes straight to that variant (even out of stock: the page shows it disabled); otherwise the text
  is searched as usual.
- **Raw SQL.** `search.offer-filtered` and `search.offer-facet-rows` read the new table (an
  `EXISTS` and a `UNION ALL` arm, `$1`-bound like every relation); the GTIN lookup and the hits'
  sell units are Prisma reads.
- **Waits for V5 (#688).** The seller's Selling switch: a variant switched off must leave the index.
  Added to the catalog facts when #688 is on main.

## Sellers and categories in search (search 1a, 11 Nov 2026)

Option B, package 1a (`handoffs/search-option-b.md`): stores and category names are found through the
index, the answer carries counts, and the use cases talk to a port.

- **Port.** `OfferSearchIndex` (`application/ports/offer-search-index.ts`) joins the ranked search, the
  attribute-filter reads, the scope counts and the store query. `PostgresOfferSearchIndex` (ADR-0004) is
  the only adapter; a dedicated engine would replace it there, with no change to the use cases or to
  apps/web. No engine code in this package.
- **Names in the text.** `search_text` (weight C, below name and short text) now also holds the seller's
  public store name (sellers' `publishedStoreSlugs` and `sellerSummaries`: an approved revision, a held
  address, may sell now) and the names of the product's categories at every level (catalog's public
  tree), before the attribute words, within the column's 2000 characters (`domain/index-names.ts`). No
  migration for this. Refresh: `catalog.platform-category-changed` and `-moved` re-sync the documents
  that name the category or one under it (`search.sync-offer-documents` with `categoryId`);
  `identity.seller-access-approved` re-syncs the seller's Offers (with the existing suspended and
  reinstated events); the six-hourly rebuild repairs the rest. A store name changed by a later revision
  has no event of its own yet (sellers publishes none): the rebuild repairs it. A failed read of the
  directory or the tree throws, so the delivery is retried.
- **Store search.** `GET /search/stores?q=&page=&pageSize=` (anonymous, `no-store`, same `q` rules,
  `pageSize` 1 to 48 (24), `page` 1 to 100, unknown parameters 400). Answer `{ items: [{ slug, name,
  productCount }], page, pageSize, hasMore }`. Read model `search.store_documents` (migration
  `20261111030000_search_store_documents`): one row per public store that has an indexed Offer, name
  vector (weight A) built by a trigger, address unique per Market. It is written in the same unit as the
  Offers of the sync (a seller with a public store is upserted; a seller met in the batch with none is
  removed) and the rebuild deletes rows it did not touch. The query (`search.store-search`) needs an
  indexed Offer, ranks by `ts_rank`, ties by seller id. The page is re-checked with sellers
  (`publishedStoreSlugs`): the live name and address are shown and a store that is not public now is
  dropped; `hasMore` is true only when the next store is visible; a failed check is 503
  `search.unavailable`. `productCount` is the store's indexed Offers (one per product), not re-checked
  one by one.
- **Counts on `GET /search/products`.** A text search or a category list (not a store's or a brand's list,
  not an exact GTIN hit) adds `counts: { total, totalIsCapped, categories, storeCount }`: products
  (never Offers) in the scope, the categories right below the asked one (the top level without one;
  a deeper product rolls up into the line below the asked category) with product counts, most first,
  at most 12, and the stores that have a product in it. The scope is the text and category before
  attribute filters and price; it is read from the index (`search.offer-scope-rows`, at most 20,000
  Offers; over that `totalIsCapped` is true and `total` is a floor) without the query-time visibility
  check, like the facet counts. A category tree that cannot be read leaves `counts` null, not the list.
- **Suggest (search 1b).** `GET /search/suggest?q=` (anonymous, Market from the request, `no-store`, default
  rate-limit class, only `q` is accepted: any other parameter is 400 `validation.failed`). `q` is
  NFC-normalised, trimmed and lower-cased. The 2-character rule counts letters and digits only (not
  punctuation, white space or zero-width characters): fewer answers 200 with empty lists and `total` 0
  and makes no index call; over 100 characters, a control character or more than 8 words is 400. Answer
  `{ products, stores, total, totalIsCapped }`: `products` (at most 5, one per product) hold
  `{ productId, name, sellerName, categoryName, image }` (`image` is the search's photo shape or null;
  never a price or any certification text), `stores` (at most 3) hold `{ storeSlug, name,
  productCount }`. `total` is the number of products in the scope from the index without the
  query-time check (`search.offer-suggest-scope-rows`, one row per product), capped at 1000
  (`totalIsCapped` true: `total` is then 1000, a floor); the search's own count has the 20,000-Offer cap.
  Matching: every word must match the Offer text (name, store name, category names, attribute words),
  the last word as a prefix (`to_tsquery` with `:*`) when it has at least 2 letters or digits, else as a
  whole lexeme. Words are letters, digits and combining marks (`domain/suggest-query.ts`), so the text
  is never an operator. Order, per product's best Offer: tier 0 the name starts with the query
  (literally, or it has every word and starts with the first word), tier 1 the name has every word
  (stems, punctuation and word order do not matter: "tomatoes" finds "Tomato", "green tea" finds
  "Tea, green") or contains the text, tier 2 seller or category only; then `ts_rank`, name, product id.
  The name test is the index vector at weight A (`word:A`), so no migration and no new function. The
  candidates are one Offer per product (`DISTINCT ON`), up to 15; if that Offer is hidden by the
  re-check, the product is not shown even if another seller's Offer of it is visible (a trade-off of the
  cheap query). No `pg_trgm` (1c adds typo tolerance).
  Stores: a store shows when its name matches or one of its indexed Offers matches (so a query that
  matches a product's text shows the store that sells it); the match is read from the index, ordered like
  the products by the store name (up to 6 candidates, 3 shown), and only then re-checked with sellers.
  Re-check, every call: `PublicVisibility` (catalog published and listed, seller may sell) on every Offer
  candidate, `StoreDirectory` for the live store name and address (a product whose seller has no public
  store now is dropped, as is a store that is not public); a check that fails is 503
  `search.unavailable`. What is live is the visibility, the store name and address and the photo; the
  product name, the product order and the counts come from the index (cached, up to 30 s old).
  `categoryName` is the category whose name has a typed word, else the deepest one in a stable order;
  photos and category names are decoration (a failing source leaves them out).
  Cache: `SuggestCache` port, in-process adapter (`infrastructure/in-memory-suggest-cache.ts`: 30 s,
  3000 entries, oldest evicted first), key `<market>|<canonical tsquery>` (punctuation and case
  variants share an entry), until a Redis client exists. It holds only what the index said (at most 15
  Offer candidates, the total, at most 6 store candidates with their Offer counts); a failed read is never
  cached. Statement timeout: read-only units open no transaction (ADR-0025), so a `SET LOCAL
  statement_timeout` is not possible without a wider platform change; the login role's own
  `statement_timeout` (30 s at most) applies. The caps above bound the output, not the rows the
  statement ranks: a broad two-letter prefix still ranks and sorts every match (a follow-up with the own
  rate-limit class: a matched-row ceiling or a 3-character prefix, measured on production-size data). The rate limit is
  the `default` class like `/search/products`; an own class needs the shared platform change (see Hassan
  L-3 below). The route logs nothing of the query (the refusal line is the search's: code, Market,
  correlation id).
- **Raw SQL.** `search.offer-scope-rows` and `search.store-search` (ADR-0030 amendment of 11 Nov 2026);
  `search.offer-suggest`, `search.offer-suggest-scope-rows` and `search.store-suggest` with the
  `to_tsquery` function in the checker (ADR-0030 amendment, search 1b).
- **Hassan L-3.** The OR cap is in. The own rate-limit class is not: a class needs a platform change
  (`RATE_LIMIT_CLASSES`, a migration that widens `rate_limit_counters_key_check`, the Market files'
  `requestLimits`), which is a shared-file PR of its own, announced on the board.
- **Not in this package.** apps/web wiring (it stops using the sample data in a frontend PR after this
  one), the suggest wiring in apps/web (1b frontend PR), typo tolerance (1c), halal and price filters (1d).
