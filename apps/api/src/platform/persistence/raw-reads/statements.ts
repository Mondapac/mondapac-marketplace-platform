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

/** One row of `certification.seller-basis` (design 7.3 S1, slice-1 form). */
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
  readonly approvedZone: string | null;
  readonly hasExpiryBoundary: boolean;
  readonly requiresExpiry: boolean | null;
  readonly issuerState: string | null;
}

/** One row of `certification.type-and-policy` (design 7.3 S2, slice-1 form). */
export interface TypeAndPolicyRow {
  readonly typeId: string;
  readonly code: string;
  /** Null when the type has no published revision: the caller treats that as a fault. */
  readonly typeRevisionId: string | null;
  readonly defaultBasis: string | null;
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

const SELLER_BASIS_SQL = `SELECT q.ord::int4 AS ord, t.id AS type_id, c.id AS certification_id, c.status,
       s.id AS submission_id, s.issuer_id, s.expiry_date::text AS expiry_date, s.type_revision_id,
       d.outcome AS decision_outcome, d.approved_zone, (d.expiry_boundary_at IS NOT NULL) AS has_expiry_boundary,
       tr.requires_expiry, i.state AS issuer_state
  FROM unnest($2::uuid[], $3::text[]) WITH ORDINALITY AS q(seller_id, type_code, ord)
  JOIN "certification"."certification_types" t ON t.market_id = $1 AND t.code = q.type_code
  JOIN "certification"."seller_certifications" c
    ON c.market_id = $1 AND c.seller_id = q.seller_id AND c.type_id = t.id
   AND c.status NOT IN ('declined', 'revoked')
  LEFT JOIN "certification"."seller_certification_submissions" s
    ON s.market_id = $1 AND s.id = c.approved_submission_id
  LEFT JOIN "certification"."seller_submission_decisions" d ON d.market_id = $1 AND d.submission_id = s.id
  LEFT JOIN "certification"."certification_type_revisions" tr ON tr.market_id = $1 AND tr.id = s.type_revision_id
  LEFT JOIN "certification"."issuers" i ON i.market_id = $1 AND i.id = s.issuer_id`;

const TYPE_AND_POLICY_SQL = `SELECT t.id AS type_id, t.code, tr.id AS type_revision_id, tr.default_basis
  FROM "certification"."certification_types" t
  LEFT JOIN "certification"."certification_type_revisions" tr
    ON tr.market_id = $1 AND tr.id = t.published_revision_id AND tr.type_id = t.id
 WHERE t.market_id = $1 AND t.code = ANY ($2::text[])`;

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
   AND d.category_ids @> $4::uuid[]
 ORDER BY rank DESC, d.offer_id ASC
 LIMIT $5::text::int4 OFFSET $6::text::int4`;

const OFFER_BROWSE_SQL = `SELECT d.offer_id, d.product_id, d.seller_id, d.name, d.short_text,
       d.category_ids::text[] AS category_ids, 0::int4 AS rank
  FROM "search"."offer_documents" d
 WHERE d.market_id = $1
   AND d.category_ids @> $2::uuid[]
 ORDER BY d.name ASC, d.offer_id ASC
 LIMIT $3::text::int4 OFFSET $4::text::int4`;

/**
 * The list. `certification` holds the slice-1 forms of S1 and S2 (data design 7.3); S3 and the
 * policy part of S2 arrive with their tables (slices 13 and 14).
 */
export const RAW_READ_STATEMENTS: readonly RawReadEntry[] = [
  {
    id: 'certification.seller-basis',
    owner: 'certification',
    reason:
      'evaluateClaims decides the seller basis from one statement, one snapshot (design 4.2 rule 2); Prisma include sends one query per relation level',
    design: 'docs/design/data/certification.md 7.2, 7.3 (S1, slice-1 form)',
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
        approvedZone: textOrNull(row['approved_zone']),
        hasExpiryBoundary: flag(row['has_expiry_boundary']),
        requiresExpiry: flagOrNull(row['requires_expiry']),
        issuerState: textOrNull(row['issuer_state']),
      };
    },
  },
  {
    id: 'certification.type-and-policy',
    owner: 'certification',
    reason:
      'evaluateClaims reads the type and its published revision in one statement, one snapshot (design 4.2 rule 2); the policy rows join in with slice 13',
    design: 'docs/design/data/certification.md 7.2, 7.3 (S2, slice-1 form)',
    sql: TYPE_AND_POLICY_SQL,
    params: [{ name: 'typeCodes', type: 'text[]', maxLength: 100 }],
    parseRow: (raw): TypeAndPolicyRow => {
      const row = asRecord(raw);
      return {
        typeId: text(row['type_id']),
        code: text(row['code']),
        typeRevisionId: textOrNull(row['type_revision_id']),
        defaultBasis: textOrNull(row['default_basis']),
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
      'full-text search in one category with websearch_to_tsquery, @@ and ts_rank on the offer_documents GIN index; Prisma has no ranked text search',
    design: 'docs/modules/search/search.md',
    sql: OFFER_SEARCH_IN_CATEGORY_SQL,
    params: [
      { name: 'textSearchConfig', type: 'text' },
      { name: 'query', type: 'text' },
      { name: 'categoryIds', type: 'uuid[]', maxLength: 1 },
      { name: 'limit', type: 'text' },
      { name: 'offset', type: 'text' },
    ],
    parseRow: parseOfferSearchRow,
  },
  {
    id: 'search.offer-browse',
    owner: 'search',
    reason: 'browse by category over the category GIN index (@>); Prisma has no array containment',
    design: 'docs/modules/search/search.md',
    sql: OFFER_BROWSE_SQL,
    params: [
      { name: 'categoryIds', type: 'uuid[]', maxLength: 1 },
      { name: 'limit', type: 'text' },
      { name: 'offset', type: 'text' },
    ],
    parseRow: parseOfferSearchRow,
  },
];
