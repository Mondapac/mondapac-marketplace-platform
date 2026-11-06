// The checked-in list of raw read statements (ADR-0030 decision 2). This is the only place a
// raw read statement may be added; a change needs the sign-off of Ali, Hassan and Mojtaba,
// recorded in the PR, and Mojtaba's plan review of the changed statement (CODEOWNERS names the
// owner's account for this folder). Imports are types only, so the boundary script can load
// this file without the application's dependencies.

/** A parameter's PostgreSQL type. `$1` is the Market and is never declared. */
export type RawReadParamType = 'uuid' | 'text' | 'uuid[]' | 'text[]';

export interface RawReadParam {
  /** The key of the caller's parameter object. */
  readonly name: string;
  readonly type: RawReadParamType;
  /** The most elements an array may hold; required for an array, refused for a scalar. */
  readonly maxLength?: number;
  /** Arrays zipped by one `unnest` share a group and must have equal lengths. */
  readonly group?: string;
}

export interface RawReadEntry<Row = unknown> {
  /** `<owning module>.<name>`, e.g. `certification.seller-basis`. */
  readonly id: string;
  /** The owning module: its schema is the only schema the text may read, and only it may call. */
  readonly owner: string;
  /** Why Prisma does not suffice. */
  readonly reason: string;
  /** The design section that specifies the statement. */
  readonly design: string;
  /** One `SELECT` or `WITH` statement as a static constant; `$1` is the Market. */
  readonly sql: string;
  /** `$2` onwards, in this order. */
  readonly params: readonly RawReadParam[];
  /** Validates one result row; throws on a row that does not fit (the whole call fails closed). */
  readonly parseRow: (row: unknown) => Row;
}

/** One row of `certification.seller-basis` (design 7.3 S1, with the badge columns of slice 10). */
export interface SellerBasisRow {
  /** 1-based position of the (seller, type) pair in the call's arrays. */
  readonly ord: number;
  readonly typeId: string;
  readonly certificationId: string;
  readonly status: string;
  readonly submissionId: string | null;
  readonly issuerId: string | null;
  /** The submission's expiry date as `YYYY-MM-DD`. */
  readonly expiryDate: string | null;
  readonly typeRevisionId: string | null;
  /** The decision row's outcome; null when the approved pointer has no decision row. */
  readonly decisionOutcome: string | null;
  /** Who made the decision (`seller`, `admin`, `system`); null when there is no decision row. */
  readonly decisionActorKind: string | null;
  readonly approvedZone: string | null;
  readonly hasExpiryBoundary: boolean;
  readonly requiresExpiry: boolean | null;
  readonly issuerState: string | null;
  /** The type's verification mode (immutable per type code). */
  readonly verificationMode: string;
  /** The issuer's public registry name (badge data); null when the submission names no issuer. */
  readonly issuerName: string | null;
  /** A reviewer recorded a full issuer confirmation for the approved submission. */
  readonly verifiedWithIssuer: boolean;
}

/**
 * One row of `certification.type-and-policy` (design 7.3 S2, slice 13): a type with its published
 * revision and one row of its published policy revision; a type without a published policy, or
 * whose published revision has no rows, gives one row with the policy row columns null.
 */
export interface TypeAndPolicyRow {
  readonly typeId: string;
  readonly code: string;
  readonly verificationMode: string;
  /** Null when the type has no published revision: the caller treats that as a fault. */
  readonly typeRevisionId: string | null;
  readonly defaultBasis: string | null;
  /** The policy's published revision; null when there is no policy or none is published. */
  readonly policyRevisionId: string | null;
  /** `platform-category` or `handling`; null when this row carries no policy row. */
  readonly rowSelectorKind: string | null;
  readonly rowCategoryId: string | null;
  readonly rowHandling: string | null;
  readonly rowBasis: string | null;
}

/**
 * One row of `certification.manufacturer-basis` (design 7.3 S3, slice 14): one coverage entry of an
 * approved, current manufacturer revision of the asked type that covers the asked product revision.
 * The variant match is the reader's (the domain's `covers`, L1), so a certificate repeats once per
 * coverage entry of the product.
 */
export interface ManufacturerBasisRow {
  /** 1-based position of the (product, product revision, type) triple in the call's arrays. */
  readonly ord: number;
  readonly typeCode: string;
  readonly productCertificationId: string;
  readonly status: string;
  readonly revisionId: string;
  /** The type revision the revision was submitted under (I1). */
  readonly typeRevisionId: string;
  readonly requiresExpiry: boolean;
  readonly issuerId: string;
  /** The revision's expiry date as `YYYY-MM-DD`. */
  readonly expiryDate: string | null;
  readonly decisionOutcome: string;
  /**
   * The expiry boundary stored on the decision at approval (Hassan L1), as PostgreSQL's
   * timestamptz text with its offset (e.g. `2027-06-30 14:00:00+00`); null without one. Read as
   * stored, never recomputed from the date and zone.
   */
  readonly expiryBoundaryAt: string | null;
  readonly issuerState: string;
  readonly issuerName: string;
  readonly productId: string;
  readonly productRevisionId: string;
  readonly variantId: string | null;
  /** A reviewer recorded a full issuer confirmation for the revision. */
  readonly verifiedWithIssuer: boolean;
}

/** One row of `search.offer-search` and `search.offer-browse` (a storefront result). */
export interface OfferSearchRow {
  readonly offerId: string;
  readonly productId: string;
  readonly sellerId: string;
  readonly name: string;
  readonly shortText: string | null;
  readonly categoryIds: readonly string[];
  /** `ts_rank` of a text query; 0 for a browse. */
  readonly rank: number;
}

/**
 * One row of `search.offer-facet-rows`: a document of the scope with its facet strings, alone
 * (`unitFacets` empty) or with one in-stock, priced sell unit's axis values (variants V8).
 */
export interface OfferFacetRow {
  readonly productId: string;
  readonly facets: readonly string[];
  readonly unitFacets: readonly string[];
}

/** One row of `search.offer-number-rows`: one stored number of the scope. */
export interface OfferNumberRow {
  readonly attr: string;
  readonly value: string;
}

/** The statements, by id, with the parameters and the rows each one has. Added per entry. */
export interface RawReadStatements {
  readonly 'certification.seller-basis': {
    readonly params: {
      readonly sellerIds: readonly string[];
      readonly typeCodes: readonly string[];
    };
    readonly row: SellerBasisRow;
  };
  readonly 'certification.type-and-policy': {
    readonly params: { readonly typeCodes: readonly string[] };
    readonly row: TypeAndPolicyRow;
  };
  readonly 'certification.manufacturer-basis': {
    readonly params: {
      readonly productIds: readonly string[];
      readonly productRevisionIds: readonly string[];
      readonly typeCodes: readonly string[];
    };
    readonly row: ManufacturerBasisRow;
  };
  readonly 'search.offer-search': {
    readonly params: {
      readonly textSearchConfig: string;
      readonly query: string;
      readonly limit: string;
      readonly offset: string;
    };
    readonly row: OfferSearchRow;
  };
  readonly 'search.offer-search-in-category': {
    readonly params: {
      readonly textSearchConfig: string;
      readonly query: string;
      readonly categoryIds: readonly string[];
      readonly limit: string;
      readonly offset: string;
    };
    readonly row: OfferSearchRow;
  };
  readonly 'search.offer-browse': {
    readonly params: {
      readonly categoryIds: readonly string[];
      readonly limit: string;
      readonly offset: string;
    };
    readonly row: OfferSearchRow;
  };
  readonly 'search.offer-search-rated': {
    readonly params: {
      readonly textSearchConfig: string;
      readonly query: string;
      readonly mode: string;
      readonly priorMeanTimes1000: string;
      readonly limit: string;
      readonly offset: string;
    };
    readonly row: OfferSearchRow;
  };
  readonly 'search.offer-search-in-category-rated': {
    readonly params: {
      readonly textSearchConfig: string;
      readonly query: string;
      readonly categoryIds: readonly string[];
      readonly mode: string;
      readonly priorMeanTimes1000: string;
      readonly limit: string;
      readonly offset: string;
    };
    readonly row: OfferSearchRow;
  };
  readonly 'search.offer-filtered': {
    readonly params: {
      readonly textSearchConfig: string;
      readonly query: string;
      readonly categoryIds: readonly string[];
      readonly choice1: readonly string[];
      readonly choice2: readonly string[];
      readonly choice3: readonly string[];
      readonly choice4: readonly string[];
      readonly choice5: readonly string[];
      readonly choice6: readonly string[];
      readonly choice7: readonly string[];
      readonly choice8: readonly string[];
      readonly range1Attr: string;
      readonly range1Min: string;
      readonly range1Max: string;
      readonly range2Attr: string;
      readonly range2Min: string;
      readonly range2Max: string;
      readonly range3Attr: string;
      readonly range3Min: string;
      readonly range3Max: string;
      readonly mode: string;
      readonly priorMeanTimes1000: string;
      readonly limit: string;
      readonly offset: string;
      /** Variants V8: the price bounds in minor units, `''` for none. */
      readonly priceMin: string;
      readonly priceMax: string;
    };
    readonly row: OfferSearchRow;
  };
  readonly 'search.offer-facet-rows': {
    readonly params: {
      readonly textSearchConfig: string;
      readonly query: string;
      readonly categoryIds: readonly string[];
      readonly range1Attr: string;
      readonly range1Min: string;
      readonly range1Max: string;
      readonly range2Attr: string;
      readonly range2Min: string;
      readonly range2Max: string;
      readonly range3Attr: string;
      readonly range3Min: string;
      readonly range3Max: string;
      readonly limit: string;
      readonly priceMin: string;
      readonly priceMax: string;
    };
    readonly row: OfferFacetRow;
  };
  readonly 'search.offer-number-rows': {
    readonly params: {
      readonly textSearchConfig: string;
      readonly query: string;
      readonly categoryIds: readonly string[];
      readonly attrs: readonly string[];
      readonly limit: string;
    };
    readonly row: OfferNumberRow;
  };
  readonly 'search.offer-browse-top-rated': {
    readonly params: {
      readonly categoryIds: readonly string[];
      readonly priorMeanTimes1000: string;
      readonly limit: string;
      readonly offset: string;
    };
    readonly row: OfferSearchRow;
  };
}

export type RawReadName = keyof RawReadStatements;
export type RawReadParams<K extends RawReadName> = RawReadStatements[K] extends {
  readonly params: infer P;
}
  ? P
  : never;
export type RawReadRow<K extends RawReadName> = RawReadStatements[K] extends {
  readonly row: infer R;
}
  ? R
  : never;

type Record_ = Record<string, unknown>;
const asRecord = (row: unknown): Record_ => {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) throw new Error('row');
  return row as Record_;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('row');
  return value;
};
const textOrNull = (value: unknown): string | null => (value === null ? null : text(value));
const flag = (value: unknown): boolean => {
  if (typeof value !== 'boolean') throw new Error('row');
  return value;
};
const flagOrNull = (value: unknown): boolean | null => (value === null ? null : flag(value));
const position = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new Error('row');
  return value;
};

const number = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('row');
  return value;
};
const textList = (value: unknown): string[] => {
  if (!Array.isArray(value)) throw new Error('row');
  return value.map(text);
};
const parseOfferSearchRow = (raw: unknown): OfferSearchRow => {
  const row = asRecord(raw);
  return {
    offerId: text(row['offer_id']),
    productId: text(row['product_id']),
    sellerId: text(row['seller_id']),
    name: text(row['name']),
    shortText: textOrNull(row['short_text']),
    categoryIds: textList(row['category_ids']),
    rank: number(row['rank']),
  };
};

const parseOfferFacetRow = (raw: unknown): OfferFacetRow => {
  const row = asRecord(raw);
  return {
    productId: text(row['product_id']),
    facets: textList(row['facets']),
    unitFacets: textList(row['unit_facets']),
  };
};
const parseOfferNumberRow = (raw: unknown): OfferNumberRow => {
  const row = asRecord(raw);
  return { attr: text(row['attr']), value: text(row['value']) };
};

const SELLER_BASIS_SQL = `SELECT q.ord::int4 AS ord, t.id AS type_id, c.id AS certification_id, c.status,
       s.id AS submission_id, s.issuer_id, s.expiry_date::text AS expiry_date, s.type_revision_id,
       d.outcome AS decision_outcome, d.actor_kind AS decision_actor_kind, d.approved_zone, (d.expiry_boundary_at IS NOT NULL) AS has_expiry_boundary,
       tr.requires_expiry, i.state AS issuer_state, t.verification_mode, i.display_name AS issuer_name,
       (ic.submission_id IS NOT NULL) AS verified_with_issuer
  FROM unnest($2::uuid[], $3::text[]) WITH ORDINALITY AS q(seller_id, type_code, ord)
  JOIN "certification"."certification_types" t ON t.market_id = $1 AND t.code = q.type_code
  JOIN "certification"."seller_certifications" c
    ON c.market_id = $1 AND c.seller_id = q.seller_id AND c.type_id = t.id
   AND c.status NOT IN ('declined', 'revoked')
  LEFT JOIN "certification"."seller_certification_submissions" s
    ON s.market_id = $1 AND s.id = c.approved_submission_id
  LEFT JOIN "certification"."seller_submission_decisions" d ON d.market_id = $1 AND d.submission_id = s.id
  LEFT JOIN "certification"."certification_type_revisions" tr ON tr.market_id = $1 AND tr.id = s.type_revision_id
  LEFT JOIN "certification"."issuers" i ON i.market_id = $1 AND i.id = s.issuer_id
  LEFT JOIN "certification"."seller_issuer_confirmations" ic ON ic.market_id = $1 AND ic.submission_id = s.id`;

// Every row of the published policy revision of each type: the matching against the query's
// categories and handling is done in code (data design 7.3 note: S2 reads the rows of a published
// revision and filters in memory), so no category-id array, and no cap on it, is bound here.
const TYPE_AND_POLICY_SQL = `SELECT t.id AS type_id, t.code, t.verification_mode, tr.id AS type_revision_id,
       tr.default_basis, p.published_revision_id AS policy_revision_id,
       r.selector_kind AS row_selector_kind, r.category_id AS row_category_id,
       r.handling AS row_handling, r.basis AS row_basis
  FROM "certification"."certification_types" t
  LEFT JOIN "certification"."certification_type_revisions" tr
    ON tr.market_id = $1 AND tr.id = t.published_revision_id AND tr.type_id = t.id
  LEFT JOIN "certification"."claim_basis_policies" p ON p.market_id = $1 AND p.type_id = t.id
  LEFT JOIN "certification"."claim_policy_rows" r
    ON r.market_id = $1 AND r.revision_id = p.published_revision_id
 WHERE t.market_id = $1 AND t.code = ANY ($2::text[])`;

// S3 (slice 14): the coverage entries of approved, current manufacturer revisions of the asked
// type for the asked product revision (M3), joined through the revision's foreign key so the plan
// is an index-only scan of the coverage lookup (data design 7.3 note, 12). The variant is not
// bound: a NULL element cannot be bound in an array (the binder refuses it), so every entry of
// the product is returned and the reader applies the variant rule (`covers`, L1). The boundary is
// the one stored at approval (Hassan L1), as timestamptz text: ISO DateStyle (as `expiry_date`)
// with its UTC offset, so the instant reads the same in any session zone.
const MANUFACTURER_BASIS_SQL = `SELECT q.ord::int4 AS ord, t.code AS type_code, pc.id AS product_certification_id, pc.status,
       rv.id AS revision_id, rv.type_revision_id, tr.requires_expiry, rv.issuer_id,
       rv.expiry_date::text AS expiry_date, dd.outcome AS decision_outcome,
       dd.expiry_boundary_at::text AS expiry_boundary_at,
       i.state AS issuer_state,
       i.display_name AS issuer_name, cv.product_id, cv.product_revision_id, cv.variant_id,
       (pic.revision_id IS NOT NULL) AS verified_with_issuer
  FROM unnest($2::uuid[], $3::uuid[], $4::text[]) WITH ORDINALITY AS q(product_id, product_revision_id, type_code, ord)
  JOIN "certification"."certification_types" t ON t.market_id = $1 AND t.code = q.type_code
  JOIN "certification"."product_revision_coverage" cv
    ON cv.market_id = $1 AND cv.product_id = q.product_id AND cv.type_id = t.id
   AND cv.product_revision_id = q.product_revision_id
  JOIN "certification"."product_certification_revisions" rv ON rv.market_id = $1 AND rv.id = cv.revision_id
  JOIN "certification"."product_certifications" pc
    ON pc.market_id = $1 AND pc.id = rv.product_certification_id
   AND pc.approved_revision_id = rv.id AND pc.status = 'approved'
  JOIN "certification"."product_revision_decisions" dd ON dd.market_id = $1 AND dd.revision_id = rv.id
  JOIN "certification"."certification_type_revisions" tr ON tr.market_id = $1 AND tr.id = rv.type_revision_id
  JOIN "certification"."issuers" i ON i.market_id = $1 AND i.id = rv.issuer_id
  LEFT JOIN "certification"."product_issuer_confirmations" pic ON pic.market_id = $1 AND pic.revision_id = rv.id`;

// `$2` is a Market `textSearchConfig` (a closed list in the Market schema), `$3` the visitor's
// text (bound, never part of the SQL), then, where there is one, exactly one category, and the page.
// Limit and offset travel as text because the parameter types are uuid and text (cast to int4).
const OFFER_SEARCH_SQL = `SELECT d.offer_id, d.product_id, d.seller_id, d.name, d.short_text,
       d.category_ids::text[] AS category_ids,
       ts_rank(d.search_vector, websearch_to_tsquery($2::regconfig, $3::text)) AS rank
  FROM "search"."offer_documents" d
 WHERE d.market_id = $1
   AND d.search_vector @@ websearch_to_tsquery($2::regconfig, $3::text)
 ORDER BY rank DESC, d.offer_id ASC
 LIMIT $4::text::int4 OFFSET $5::text::int4`;

const OFFER_SEARCH_IN_CATEGORY_SQL = `SELECT d.offer_id, d.product_id, d.seller_id, d.name, d.short_text,
       d.category_ids::text[] AS category_ids,
       ts_rank(d.search_vector, websearch_to_tsquery($2::regconfig, $3::text)) AS rank
  FROM "search"."offer_documents" d
 WHERE d.market_id = $1
   AND d.search_vector @@ websearch_to_tsquery($2::regconfig, $3::text)
   AND d.category_ids && $4::uuid[]
 ORDER BY rank DESC, d.offer_id ASC
 LIMIT $5::text::int4 OFFSET $6::text::int4`;

const OFFER_BROWSE_SQL = `SELECT d.offer_id, d.product_id, d.seller_id, d.name, d.short_text,
       d.category_ids::text[] AS category_ids, 0::int4 AS rank
  FROM "search"."offer_documents" d
 WHERE d.market_id = $1
   AND d.category_ids && $2::uuid[]
 ORDER BY d.name ASC, d.offer_id ASC
 LIMIT $3::text::int4 OFFSET $4::text::int4`;

// The rating boost (buyer reviews and ratings package 5, owner decision N9). The arithmetic is not
// done here: the sync job computes, in TypeScript, `bayes_times_1000` (the Bayesian average of a
// product's stars times 1000) and `boost_ppm` (the relevance factor in millionths, a CHECK keeps it
// within the Market's 10 % cap) and stores them in `search.product_ratings`. A product with no row
// is unrated: factor 1000000 (no change) and, for Top rated, the prior mean (`$4`, times 1000).
// `ts_rank * boost_ppm` moves the text rank by at most 10 %. Mode `top` (the "Top rated" sort)
// orders by `bayes_times_1000` first, then by the same boosted rank; any other mode by the
// boosted rank alone. The rows are the copy reviews' facade fills (empty while reviews or the
// boost are off).
const OFFER_SEARCH_RATED_SQL = `SELECT d.offer_id, d.product_id, d.seller_id, d.name, d.short_text,
       d.category_ids::text[] AS category_ids,
       ts_rank(d.search_vector, websearch_to_tsquery($2::regconfig, $3::text)) AS rank
  FROM "search"."offer_documents" d
  LEFT JOIN "search"."product_ratings" r ON r.market_id = $1 AND r.product_id = d.product_id
 WHERE d.market_id = $1
   AND d.search_vector @@ websearch_to_tsquery($2::regconfig, $3::text)
 ORDER BY CASE WHEN $4::text = 'top' THEN COALESCE(r.bayes_times_1000, $5::text::int4) END DESC NULLS LAST,
          ts_rank(d.search_vector, websearch_to_tsquery($2::regconfig, $3::text)) * COALESCE(r.boost_ppm, 1000000) DESC,
          d.offer_id ASC
 LIMIT $6::text::int4 OFFSET $7::text::int4`;

const OFFER_SEARCH_IN_CATEGORY_RATED_SQL = `SELECT d.offer_id, d.product_id, d.seller_id, d.name, d.short_text,
       d.category_ids::text[] AS category_ids,
       ts_rank(d.search_vector, websearch_to_tsquery($2::regconfig, $3::text)) AS rank
  FROM "search"."offer_documents" d
  LEFT JOIN "search"."product_ratings" r ON r.market_id = $1 AND r.product_id = d.product_id
 WHERE d.market_id = $1
   AND d.search_vector @@ websearch_to_tsquery($2::regconfig, $3::text)
   AND d.category_ids && $4::uuid[]
 ORDER BY CASE WHEN $5::text = 'top' THEN COALESCE(r.bayes_times_1000, $6::text::int4) END DESC NULLS LAST,
          ts_rank(d.search_vector, websearch_to_tsquery($2::regconfig, $3::text)) * COALESCE(r.boost_ppm, 1000000) DESC,
          d.offer_id ASC
 LIMIT $7::text::int4 OFFSET $8::text::int4`;

const OFFER_BROWSE_TOP_RATED_SQL = `SELECT d.offer_id, d.product_id, d.seller_id, d.name, d.short_text,
       d.category_ids::text[] AS category_ids, 0::int4 AS rank
  FROM "search"."offer_documents" d
  LEFT JOIN "search"."product_ratings" r ON r.market_id = $1 AND r.product_id = d.product_id
 WHERE d.market_id = $1
   AND d.category_ids && $2::uuid[]
 ORDER BY COALESCE(r.bayes_times_1000, $3::text::int4) DESC, d.name ASC, d.offer_id ASC
 LIMIT $4::text::int4 OFFSET $5::text::int4`;

// Attribute filters (attributes A7). One statement for a text search or a category browse narrowed by up
// to eight choice groups (a document holds one of a group's facet strings: an empty group is no
// filter) and up to three number ranges (an empty attribute is no range; a range joins the
// document's stored number of that attribute). Variant filters and the price filter (variants V8,
// `$26`/`$27` are the price bounds in minor units, empty for none): a document matches when its own
// facets satisfy every group and no price is asked (product attributes only: stock is not asked,
// as before), or when one of its sell units that is in stock and priced satisfies every group with
// the document's facets and its own axis values, at a price within the bounds. The product is one
// result either way. `$3` empty means a browse (by name); the category
// array empty means no category. The rating boost is joined only when `$22` is not `none`; with
// `$22 = 'top'` the stored Bayesian average orders first, as in the rated statements.
const OFFER_FILTERED_SQL = `SELECT d.offer_id, d.product_id, d.seller_id, d.name, d.short_text,
       d.category_ids::text[] AS category_ids,
       ts_rank(d.search_vector, websearch_to_tsquery($2::regconfig, $3::text)) AS rank
  FROM "search"."offer_documents" d
  LEFT JOIN "search"."offer_document_numbers" n1 ON n1.market_id = $1 AND n1.offer_id = d.offer_id AND n1.attr = $13::text
  LEFT JOIN "search"."offer_document_numbers" n2 ON n2.market_id = $1 AND n2.offer_id = d.offer_id AND n2.attr = $16::text
  LEFT JOIN "search"."offer_document_numbers" n3 ON n3.market_id = $1 AND n3.offer_id = d.offer_id AND n3.attr = $19::text
  LEFT JOIN "search"."product_ratings" r ON r.market_id = $1 AND r.product_id = d.product_id AND $22::text <> 'none'
 WHERE d.market_id = $1
   AND ($3::text = '' OR d.search_vector @@ websearch_to_tsquery($2::regconfig, $3::text))
   AND ($4::uuid[] = '{}'::uuid[] OR d.category_ids && $4::uuid[])
   AND (
        ($26::text = '' AND $27::text = ''
        AND ($5::text[] = '{}'::text[] OR d.facet_codes && $5::text[])
        AND ($6::text[] = '{}'::text[] OR d.facet_codes && $6::text[])
        AND ($7::text[] = '{}'::text[] OR d.facet_codes && $7::text[])
        AND ($8::text[] = '{}'::text[] OR d.facet_codes && $8::text[])
        AND ($9::text[] = '{}'::text[] OR d.facet_codes && $9::text[])
        AND ($10::text[] = '{}'::text[] OR d.facet_codes && $10::text[])
        AND ($11::text[] = '{}'::text[] OR d.facet_codes && $11::text[])
        AND ($12::text[] = '{}'::text[] OR d.facet_codes && $12::text[]))
     OR EXISTS (
        SELECT 1 FROM "search"."offer_variant_documents" v
         WHERE v.market_id = $1 AND v.offer_id = d.offer_id
           AND v.in_stock = true AND v.price_amount >= 0
          AND ($5::text[] = '{}'::text[] OR d.facet_codes && $5::text[] OR v.facet_codes && $5::text[])
          AND ($6::text[] = '{}'::text[] OR d.facet_codes && $6::text[] OR v.facet_codes && $6::text[])
          AND ($7::text[] = '{}'::text[] OR d.facet_codes && $7::text[] OR v.facet_codes && $7::text[])
          AND ($8::text[] = '{}'::text[] OR d.facet_codes && $8::text[] OR v.facet_codes && $8::text[])
          AND ($9::text[] = '{}'::text[] OR d.facet_codes && $9::text[] OR v.facet_codes && $9::text[])
          AND ($10::text[] = '{}'::text[] OR d.facet_codes && $10::text[] OR v.facet_codes && $10::text[])
          AND ($11::text[] = '{}'::text[] OR d.facet_codes && $11::text[] OR v.facet_codes && $11::text[])
          AND ($12::text[] = '{}'::text[] OR d.facet_codes && $12::text[] OR v.facet_codes && $12::text[])
           AND ($26::text = '' OR v.price_amount >= $26::text::int8)
           AND ($27::text = '' OR v.price_amount <= $27::text::int8)))
   AND ($13::text = '' OR (n1.value >= $14::text::numeric AND n1.value <= $15::text::numeric))
   AND ($16::text = '' OR (n2.value >= $17::text::numeric AND n2.value <= $18::text::numeric))
   AND ($19::text = '' OR (n3.value >= $20::text::numeric AND n3.value <= $21::text::numeric))
 ORDER BY CASE WHEN $22::text = 'top' THEN COALESCE(r.bayes_times_1000, $23::text::int4) END DESC NULLS LAST,
          ts_rank(d.search_vector, websearch_to_tsquery($2::regconfig, $3::text)) * COALESCE(r.boost_ppm, 1000000) DESC,
          CASE WHEN $3::text = '' THEN d.name END ASC,
          d.offer_id ASC
 LIMIT $24::text::int4 OFFSET $25::text::int4`;

// The documents of a scope with their facet strings, for counting (the counting is done by the
// caller, so the statement needs no aggregate). Same scope and range rules as above; the choice
// groups are applied by the caller so an attribute's own options can ignore its own filter.
// Variants V8: one row per document with its own facets (only when no price is asked, `$15`/`$16`
// empty), and one row per sell unit that is in stock, priced and within the price bounds, with the
// unit's axis values beside the document's. The caller counts products, never rows.
const OFFER_FACET_ROWS_SQL = `SELECT d.offer_id, d.product_id, d.facet_codes::text[] AS facets, '{}'::text[] AS unit_facets
  FROM "search"."offer_documents" d
  LEFT JOIN "search"."offer_document_numbers" n1 ON n1.market_id = $1 AND n1.offer_id = d.offer_id AND n1.attr = $5::text
  LEFT JOIN "search"."offer_document_numbers" n2 ON n2.market_id = $1 AND n2.offer_id = d.offer_id AND n2.attr = $8::text
  LEFT JOIN "search"."offer_document_numbers" n3 ON n3.market_id = $1 AND n3.offer_id = d.offer_id AND n3.attr = $11::text
 WHERE d.market_id = $1
   AND $15::text = '' AND $16::text = ''
   AND ($3::text = '' OR d.search_vector @@ websearch_to_tsquery($2::regconfig, $3::text))
   AND ($4::uuid[] = '{}'::uuid[] OR d.category_ids && $4::uuid[])
   AND ($5::text = '' OR (n1.value >= $6::text::numeric AND n1.value <= $7::text::numeric))
   AND ($8::text = '' OR (n2.value >= $9::text::numeric AND n2.value <= $10::text::numeric))
   AND ($11::text = '' OR (n3.value >= $12::text::numeric AND n3.value <= $13::text::numeric))
UNION ALL
SELECT d.offer_id, d.product_id, d.facet_codes::text[] AS facets, v.facet_codes::text[] AS unit_facets
  FROM "search"."offer_documents" d
  JOIN "search"."offer_variant_documents" v ON v.market_id = $1 AND v.offer_id = d.offer_id
  LEFT JOIN "search"."offer_document_numbers" n1 ON n1.market_id = $1 AND n1.offer_id = d.offer_id AND n1.attr = $5::text
  LEFT JOIN "search"."offer_document_numbers" n2 ON n2.market_id = $1 AND n2.offer_id = d.offer_id AND n2.attr = $8::text
  LEFT JOIN "search"."offer_document_numbers" n3 ON n3.market_id = $1 AND n3.offer_id = d.offer_id AND n3.attr = $11::text
 WHERE d.market_id = $1
   AND v.in_stock = true AND v.price_amount >= 0
   AND ($15::text = '' OR v.price_amount >= $15::text::int8)
   AND ($16::text = '' OR v.price_amount <= $16::text::int8)
   AND ($3::text = '' OR d.search_vector @@ websearch_to_tsquery($2::regconfig, $3::text))
   AND ($4::uuid[] = '{}'::uuid[] OR d.category_ids && $4::uuid[])
   AND ($5::text = '' OR (n1.value >= $6::text::numeric AND n1.value <= $7::text::numeric))
   AND ($8::text = '' OR (n2.value >= $9::text::numeric AND n2.value <= $10::text::numeric))
   AND ($11::text = '' OR (n3.value >= $12::text::numeric AND n3.value <= $13::text::numeric))
 ORDER BY offer_id ASC
 LIMIT $14::text::int4`;

// The stored numbers of some attributes over a scope (their lowest and highest are read by the caller).
const OFFER_NUMBER_ROWS_SQL = `SELECT n.attr, n.value::text AS value
  FROM "search"."offer_documents" d
  JOIN "search"."offer_document_numbers" n ON n.market_id = $1 AND n.offer_id = d.offer_id
  JOIN unnest($5::text[]) AS a(attr) ON n.attr = a.attr
 WHERE d.market_id = $1
   AND ($3::text = '' OR d.search_vector @@ websearch_to_tsquery($2::regconfig, $3::text))
   AND ($4::uuid[] = '{}'::uuid[] OR d.category_ids && $4::uuid[])
 ORDER BY n.offer_id ASC
 LIMIT $6::text::int4`;

/**
 * The list. `certification` holds S1 (with the badge columns of slice 10), S2 with the policy
 * rows of slice 13 and S3 of slice 14 (data design 7.3).
 */
/** The eight choice groups of `search.offer-filtered` (a group is a text array of facet strings). */
const CHOICE_PARAMS: readonly RawReadParam[] = Array.from({ length: 8 }, (_, index) => ({
  name: `choice${index + 1}`,
  type: 'text[]' as const,
  maxLength: 50,
}));

/** The three range slots (attribute code, lower and upper bound as decimal text). */
const RANGE_PARAMS: readonly RawReadParam[] = [1, 2, 3].flatMap((slot) => [
  { name: `range${slot}Attr`, type: 'text' as const },
  { name: `range${slot}Min`, type: 'text' as const },
  { name: `range${slot}Max`, type: 'text' as const },
]);

export const RAW_READ_STATEMENTS: readonly RawReadEntry[] = [
  {
    id: 'certification.seller-basis',
    owner: 'certification',
    reason:
      'evaluateClaims decides the seller basis from one statement, one snapshot (design 4.2 rule 2); Prisma include sends one query per relation level',
    design: 'docs/design/data/certification.md 7.2, 7.3 (S1; badge columns from slice 10)',
    sql: SELLER_BASIS_SQL,
    params: [
      { name: 'sellerIds', type: 'uuid[]', maxLength: 100, group: 'pairs' },
      { name: 'typeCodes', type: 'text[]', maxLength: 100, group: 'pairs' },
    ],
    parseRow: (raw): SellerBasisRow => {
      const row = asRecord(raw);
      return {
        ord: position(row['ord']),
        typeId: text(row['type_id']),
        certificationId: text(row['certification_id']),
        status: text(row['status']),
        submissionId: textOrNull(row['submission_id']),
        issuerId: textOrNull(row['issuer_id']),
        expiryDate: textOrNull(row['expiry_date']),
        typeRevisionId: textOrNull(row['type_revision_id']),
        decisionOutcome: textOrNull(row['decision_outcome']),
        decisionActorKind: textOrNull(row['decision_actor_kind']),
        approvedZone: textOrNull(row['approved_zone']),
        hasExpiryBoundary: flag(row['has_expiry_boundary']),
        requiresExpiry: flagOrNull(row['requires_expiry']),
        issuerState: textOrNull(row['issuer_state']),
        verificationMode: text(row['verification_mode']),
        issuerName: textOrNull(row['issuer_name']),
        verifiedWithIssuer: flag(row['verified_with_issuer']),
      };
    },
  },
  {
    id: 'certification.type-and-policy',
    owner: 'certification',
    reason:
      'evaluateClaims reads the type, its published revision and its published policy rows in one statement, one snapshot (design 4.2 rule 2)',
    design: 'docs/design/data/certification.md 7.2, 7.3 (S2; rows filtered in code, slice 13)',
    sql: TYPE_AND_POLICY_SQL,
    params: [{ name: 'typeCodes', type: 'text[]', maxLength: 100 }],
    parseRow: (raw): TypeAndPolicyRow => {
      const row = asRecord(raw);
      return {
        typeId: text(row['type_id']),
        code: text(row['code']),
        verificationMode: text(row['verification_mode']),
        typeRevisionId: textOrNull(row['type_revision_id']),
        defaultBasis: textOrNull(row['default_basis']),
        policyRevisionId: textOrNull(row['policy_revision_id']),
        rowSelectorKind: textOrNull(row['row_selector_kind']),
        rowCategoryId: textOrNull(row['row_category_id']),
        rowHandling: textOrNull(row['row_handling']),
        rowBasis: textOrNull(row['row_basis']),
      };
    },
  },
  {
    id: 'certification.manufacturer-basis',
    owner: 'certification',
    reason:
      'evaluateClaims decides the manufacturer basis from one statement, one snapshot (design 4.2 rule 2, step 6); Prisma include sends one query per relation level',
    design: 'docs/design/data/certification.md 7.2, 7.3 (S3; variant matched in code, slice 14)',
    sql: MANUFACTURER_BASIS_SQL,
    params: [
      { name: 'productIds', type: 'uuid[]', maxLength: 100, group: 'triples' },
      { name: 'productRevisionIds', type: 'uuid[]', maxLength: 100, group: 'triples' },
      { name: 'typeCodes', type: 'text[]', maxLength: 100, group: 'triples' },
    ],
    parseRow: (raw): ManufacturerBasisRow => {
      const row = asRecord(raw);
      return {
        ord: position(row['ord']),
        typeCode: text(row['type_code']),
        productCertificationId: text(row['product_certification_id']),
        status: text(row['status']),
        revisionId: text(row['revision_id']),
        typeRevisionId: text(row['type_revision_id']),
        requiresExpiry: flag(row['requires_expiry']),
        issuerId: text(row['issuer_id']),
        expiryDate: textOrNull(row['expiry_date']),
        decisionOutcome: text(row['decision_outcome']),
        expiryBoundaryAt: textOrNull(row['expiry_boundary_at']),
        issuerState: text(row['issuer_state']),
        issuerName: text(row['issuer_name']),
        productId: text(row['product_id']),
        productRevisionId: text(row['product_revision_id']),
        variantId: textOrNull(row['variant_id']),
        verifiedWithIssuer: flag(row['verified_with_issuer']),
      };
    },
  },
  {
    id: 'search.offer-search',
    owner: 'search',
    reason:
      'full-text search with websearch_to_tsquery, @@ and ts_rank on the offer_documents GIN index; Prisma has no ranked text search',
    design: 'docs/modules/search/search.md',
    sql: OFFER_SEARCH_SQL,
    params: [
      { name: 'textSearchConfig', type: 'text' },
      { name: 'query', type: 'text' },
      { name: 'limit', type: 'text' },
      { name: 'offset', type: 'text' },
    ],
    parseRow: parseOfferSearchRow,
  },
  {
    id: 'search.offer-search-in-category',
    owner: 'search',
    reason:
      'full-text search in one category and its subcategories with websearch_to_tsquery, @@ and ts_rank on the offer_documents GIN index; Prisma has no ranked text search',
    design: 'docs/modules/search/search.md',
    sql: OFFER_SEARCH_IN_CATEGORY_SQL,
    params: [
      { name: 'textSearchConfig', type: 'text' },
      { name: 'query', type: 'text' },
      { name: 'categoryIds', type: 'uuid[]', maxLength: 1000 },
      { name: 'limit', type: 'text' },
      { name: 'offset', type: 'text' },
    ],
    parseRow: parseOfferSearchRow,
  },
  {
    id: 'search.offer-browse',
    owner: 'search',
    reason:
      'browse by a category and its subcategories over the category GIN index (&& overlap); Prisma has no array overlap',
    design: 'docs/modules/search/search.md',
    sql: OFFER_BROWSE_SQL,
    params: [
      { name: 'categoryIds', type: 'uuid[]', maxLength: 1000 },
      { name: 'limit', type: 'text' },
      { name: 'offset', type: 'text' },
    ],
    parseRow: parseOfferSearchRow,
  },
  {
    id: 'search.offer-search-rated',
    owner: 'search',
    reason:
      'full-text search ranked by ts_rank times the stored rating factor (at most 10 %), or ordered by the stored Bayesian average for Top rated; Prisma has no ranked text search',
    design: 'docs/modules/search/search.md',
    sql: OFFER_SEARCH_RATED_SQL,
    params: [
      { name: 'textSearchConfig', type: 'text' },
      { name: 'query', type: 'text' },
      { name: 'mode', type: 'text' },
      { name: 'priorMeanTimes1000', type: 'text' },
      { name: 'limit', type: 'text' },
      { name: 'offset', type: 'text' },
    ],
    parseRow: parseOfferSearchRow,
  },
  {
    id: 'search.offer-search-in-category-rated',
    owner: 'search',
    reason:
      'the category full-text search with the same stored rating factor or Top rated order; Prisma has no ranked text search',
    design: 'docs/modules/search/search.md',
    sql: OFFER_SEARCH_IN_CATEGORY_RATED_SQL,
    params: [
      { name: 'textSearchConfig', type: 'text' },
      { name: 'query', type: 'text' },
      { name: 'categoryIds', type: 'uuid[]', maxLength: 1000 },
      { name: 'mode', type: 'text' },
      { name: 'priorMeanTimes1000', type: 'text' },
      { name: 'limit', type: 'text' },
      { name: 'offset', type: 'text' },
    ],
    parseRow: parseOfferSearchRow,
  },
  {
    id: 'search.offer-browse-top-rated',
    owner: 'search',
    reason:
      'a category browse ordered by the stored Bayesian average of the product stars over the category GIN index (&& overlap); Prisma has no array overlap',
    design: 'docs/modules/search/search.md',
    sql: OFFER_BROWSE_TOP_RATED_SQL,
    params: [
      { name: 'categoryIds', type: 'uuid[]', maxLength: 1000 },
      { name: 'priorMeanTimes1000', type: 'text' },
      { name: 'limit', type: 'text' },
      { name: 'offset', type: 'text' },
    ],
    parseRow: parseOfferSearchRow,
  },
  {
    id: 'search.offer-filtered',
    owner: 'search',
    reason:
      'full-text search or category browse narrowed by facet arrays (&& overlap) and number ranges over the offer_documents GIN indexes; Prisma has no ranked text search or array overlap',
    design: 'docs/modules/search/search.md',
    sql: OFFER_FILTERED_SQL,
    params: [
      { name: 'textSearchConfig', type: 'text' },
      { name: 'query', type: 'text' },
      { name: 'categoryIds', type: 'uuid[]', maxLength: 1000 },
      ...CHOICE_PARAMS,
      ...RANGE_PARAMS,
      { name: 'mode', type: 'text' },
      { name: 'priorMeanTimes1000', type: 'text' },
      { name: 'limit', type: 'text' },
      { name: 'offset', type: 'text' },
      { name: 'priceMin', type: 'text' },
      { name: 'priceMax', type: 'text' },
    ],
    parseRow: parseOfferSearchRow,
  },
  {
    id: 'search.offer-facet-rows',
    owner: 'search',
    reason:
      'the documents of a text or category scope with their facet strings, for counting in the caller; full-text search and array overlap are not in Prisma',
    design: 'docs/modules/search/search.md',
    sql: OFFER_FACET_ROWS_SQL,
    params: [
      { name: 'textSearchConfig', type: 'text' },
      { name: 'query', type: 'text' },
      { name: 'categoryIds', type: 'uuid[]', maxLength: 1000 },
      ...RANGE_PARAMS,
      { name: 'limit', type: 'text' },
      { name: 'priceMin', type: 'text' },
      { name: 'priceMax', type: 'text' },
    ],
    parseRow: parseOfferFacetRow,
  },
  {
    id: 'search.offer-number-rows',
    owner: 'search',
    reason:
      'the stored numbers of some attributes over a text or category scope, for the bounds of a range filter; full-text search and array overlap are not in Prisma',
    design: 'docs/modules/search/search.md',
    sql: OFFER_NUMBER_ROWS_SQL,
    params: [
      { name: 'textSearchConfig', type: 'text' },
      { name: 'query', type: 'text' },
      { name: 'categoryIds', type: 'uuid[]', maxLength: 1000 },
      { name: 'attrs', type: 'text[]', maxLength: 20 },
      { name: 'limit', type: 'text' },
    ],
    parseRow: parseOfferNumberRow,
  },
];
