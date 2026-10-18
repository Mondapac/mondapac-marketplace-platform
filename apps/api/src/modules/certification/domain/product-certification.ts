import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';
import type { TimeZoneId } from './claim-types';
import {
  MAX_CERTIFICATE_NUMBER_LENGTH,
  parseDate,
  parseText,
  type DraftField,
} from './seller-certificate';
import type { VerificationMode } from './type-revision';
import { expiryBoundary, type IssuerState, type ProductCertificationStatus } from './validity';

// The pure rules of a manufacturer certificate, `ProductCertification` (certification design 2.1,
// 3.4; ADR-0012 d3 as amended by ADR-0028 d7; AC 20; slice 14). An admin records the certificate
// and its coverage in a draft on the root; a submission makes revision N `pending`; another person
// approves or rejects it. Coverage is part of the revision, so it never changes on an approved
// revision; an edit after approval is a new revision while the approved one stays live (T3). Time
// comes in as an argument from the Clock; the Market zone measures the expiry (2.4 rule 3).

/** The record statuses (design 3.4; the `status` CHECK of data design 3.15). */
export const PRODUCT_CERTIFICATION_STATUSES: readonly ProductCertificationStatus[] = [
  'draft',
  'in-review',
  'approved',
  'rejected',
  'suspended',
  'revoked',
  'expired',
];

export const MAX_MANUFACTURER_NAME_LENGTH = 200;
/** The most products one revision covers (a `CatalogReferences` call takes at most 500 ids). */
export const MAX_COVERED_PRODUCTS = 200;
/** The most variants one product's entry may name (catalog's `maxVariantsPerProduct`, AU 100). */
export const MAX_VARIANTS_PER_PRODUCT = 100;
/** The most coverage rows one revision holds. */
export const MAX_COVERAGE_ENTRIES = 500;

/** One product as the admin names it: the whole product, or narrowed to some of its variants. */
export interface CoverageRequest {
  readonly productId: Id<'Product'>;
  /** `null`: the whole product (every variant); a list narrows to those variants (CERT-41). */
  readonly variantIds: readonly Id<'Variant'>[] | null;
}

/**
 * One stored coverage entry (design 2.1; data design 3.15, 3.16): a product at the published
 * product revision it was checked against (M3), whole (`variantId` null) or one variant.
 */
export interface CoverageEntry {
  readonly productId: Id<'Product'>;
  readonly productRevisionId: Id<'ProductRevision'>;
  readonly variantId: Id<'Variant'> | null;
}

/** A draft save as the admin sends it; every key but `certificateNumber` is required. */
export interface ProductDraftInput {
  readonly manufacturerName: string | null;
  readonly issuerId: Id<'Issuer'> | null;
  /** `undefined`: keep the stored number (it is never read back in clear); `null` clears it. */
  readonly certificateNumber: string | null | undefined;
  readonly issueDate: Temporal.PlainDate | null;
  readonly expiryDate: Temporal.PlainDate | null;
  readonly coverage: readonly CoverageRequest[];
}

const COVERAGE_KEYS: ReadonlySet<string> = new Set(['productId', 'variantIds']);

function parseCoverage(value: unknown, fields: DraftField[]): CoverageRequest[] {
  if (!Array.isArray(value)) {
    fields.push({ path: 'coverage', code: 'type' });
    return [];
  }
  if (value.length > MAX_COVERED_PRODUCTS) {
    fields.push({ path: 'coverage', code: 'length' });
    return [];
  }
  const out: CoverageRequest[] = [];
  const seen = new Set<string>();
  let rows = 0;
  value.forEach((raw: unknown, i) => {
    const at = `coverage[${i}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      fields.push({ path: at, code: 'type' });
      return;
    }
    const entry = raw as Record<string, unknown>;
    // Closed: the product revision is never taken from the client (M3).
    if (Object.keys(entry).some((key) => !COVERAGE_KEYS.has(key))) {
      fields.push({ path: at, code: 'unknown-key' });
      return;
    }
    const product =
      typeof entry['productId'] === 'string' ? parseId<'Product'>(entry['productId']) : null;
    if (!product?.ok) {
      fields.push({ path: `${at}.productId`, code: 'format' });
      return;
    }
    if (seen.has(product.value)) {
      // One entry per product: whole or narrowed, never both (Q-C7).
      fields.push({ path: `${at}.productId`, code: 'duplicate' });
      return;
    }
    seen.add(product.value);
    const rawVariants = entry['variantIds'];
    if (rawVariants === null || rawVariants === undefined) {
      rows += 1;
      out.push({ productId: product.value, variantIds: null });
      return;
    }
    if (!Array.isArray(rawVariants)) {
      fields.push({ path: `${at}.variantIds`, code: 'type' });
      return;
    }
    if (rawVariants.length < 1 || rawVariants.length > MAX_VARIANTS_PER_PRODUCT) {
      fields.push({ path: `${at}.variantIds`, code: 'length' });
      return;
    }
    const variants: Id<'Variant'>[] = [];
    let bad = false;
    rawVariants.forEach((v: unknown, j) => {
      const parsed = typeof v === 'string' ? parseId<'Variant'>(v) : null;
      if (!parsed?.ok) {
        fields.push({ path: `${at}.variantIds[${j}]`, code: 'format' });
        bad = true;
      } else if (variants.includes(parsed.value)) {
        fields.push({ path: `${at}.variantIds[${j}]`, code: 'duplicate' });
        bad = true;
      } else {
        variants.push(parsed.value);
      }
    });
    if (bad) return;
    rows += variants.length;
    out.push({ productId: product.value, variantIds: variants });
  });
  if (rows > MAX_COVERAGE_ENTRIES) fields.push({ path: 'coverage', code: 'length' });
  return out;
}

/**
 * The draft an admin sends (design 3.4 row 1): every field present (`null` clears it) except
 * `certificateNumber`, which an absent key keeps. Shape only: dates are local dates (ADR-0005), the
 * texts plain and bounded, the coverage one entry per product with explicit ids. Existence in the
 * Market and the product revision are the use case's, through `CatalogReferences`.
 */
export function parseProductDraft(
  input: unknown,
): Result<ProductDraftInput, readonly DraftField[]> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return err([{ path: 'body', code: 'type' }]);
  }
  const record = input as Record<string, unknown>;
  const fields: DraftField[] = [];
  const manufacturerName = parseText(
    record['manufacturerName'],
    'manufacturerName',
    MAX_MANUFACTURER_NAME_LENGTH,
    fields,
  );
  let issuerId: Id<'Issuer'> | null = null;
  const rawIssuer = record['issuerId'];
  if (rawIssuer !== null && rawIssuer !== undefined) {
    const parsed = typeof rawIssuer === 'string' ? parseId<'Issuer'>(rawIssuer) : null;
    if (parsed?.ok) issuerId = parsed.value;
    else fields.push({ path: 'issuerId', code: 'format' });
  }
  let certificateNumber: string | null | undefined = undefined;
  if (Object.hasOwn(record, 'certificateNumber')) {
    certificateNumber = parseText(
      record['certificateNumber'],
      'certificateNumber',
      MAX_CERTIFICATE_NUMBER_LENGTH,
      fields,
    );
  }
  const issueDate = parseDate(record['issueDate'] ?? null, 'issueDate', fields);
  const expiryDate = parseDate(record['expiryDate'] ?? null, 'expiryDate', fields);
  if (
    issueDate !== null &&
    expiryDate !== null &&
    Temporal.PlainDate.compare(issueDate, expiryDate) > 0
  ) {
    fields.push({ path: 'expiryDate', code: 'before-issue-date' });
  }
  const coverage = parseCoverage(record['coverage'], fields);
  if (fields.length > 0) return err(fields);
  return ok({ manufacturerName, issuerId, certificateNumber, issueDate, expiryDate, coverage });
}

/**
 * The requested coverage at each product's current published revision (M3), one entry per
 * variant for a narrowed product. `published` and `variants` are `catalog`'s answers through
 * `CatalogReferences`: a product without a published revision, or a variant not on it, is refused
 * by path.
 */
export function resolveCoverage(
  requests: readonly CoverageRequest[],
  published: ReadonlyMap<Id<'Product'>, Id<'ProductRevision'>>,
  variants: ReadonlyMap<Id<'Product'>, ReadonlySet<Id<'Variant'>>>,
): Result<readonly CoverageEntry[], readonly DraftField[]> {
  const fields: DraftField[] = [];
  const entries: CoverageEntry[] = [];
  requests.forEach((request, i) => {
    const productRevisionId = published.get(request.productId);
    if (productRevisionId === undefined) {
      fields.push({ path: `coverage[${i}].productId`, code: 'product-unknown' });
      return;
    }
    if (request.variantIds === null) {
      entries.push({ productId: request.productId, productRevisionId, variantId: null });
      return;
    }
    const known = variants.get(request.productId) ?? new Set<Id<'Variant'>>();
    request.variantIds.forEach((variantId, j) => {
      if (!known.has(variantId)) {
        fields.push({ path: `coverage[${i}].variantIds[${j}]`, code: 'variant-unknown' });
        return;
      }
      entries.push({ productId: request.productId, productRevisionId, variantId });
    });
  });
  return fields.length > 0 ? err(fields) : ok(entries);
}

export type CoverageProblem = 'coverage-empty' | 'coverage-mixed' | 'coverage-duplicate';

const entryKey = (e: CoverageEntry): string =>
  `${e.productId}|${e.productRevisionId}|${e.variantId ?? '*'}`;

/**
 * The aggregate's coverage invariants (design 2.1; data design 6): the list is never empty (brand
 * alone is not coverage); per product one product revision and either one whole-product entry or
 * variant entries, never both (Q-C7); no entry twice.
 */
export function coverageProblems(entries: readonly CoverageEntry[]): readonly CoverageProblem[] {
  if (entries.length === 0) return ['coverage-empty'];
  const keys = new Set<string>();
  const perProduct = new Map<string, { revision: string; whole: boolean; variants: number }>();
  for (const entry of entries) {
    const key = entryKey(entry);
    if (keys.has(key)) return ['coverage-duplicate'];
    keys.add(key);
    const held = perProduct.get(entry.productId);
    if (held === undefined) {
      perProduct.set(entry.productId, {
        revision: entry.productRevisionId,
        whole: entry.variantId === null,
        variants: entry.variantId === null ? 0 : 1,
      });
      continue;
    }
    if (held.revision !== entry.productRevisionId || held.whole || entry.variantId === null) {
      return ['coverage-mixed'];
    }
    held.variants += 1;
  }
  return [];
}

/** True when two coverage lists hold the same entries (order ignored). */
export function sameCoverage(a: readonly CoverageEntry[], b: readonly CoverageEntry[]): boolean {
  const left = new Set(a.map(entryKey));
  const right = new Set(b.map(entryKey));
  return left.size === right.size && [...left].every((key) => right.has(key));
}

/**
 * The event of an approval (design 3.4, 8.3): `coverage-changed` when the record already had an
 * approved revision whose coverage differs from the one approved now, otherwise `approved` (a first
 * approval, a renewal, a re-review after suspension).
 */
export function approvalEvent(
  previous: readonly CoverageEntry[] | null,
  approved: readonly CoverageEntry[],
): 'approved' | 'coverage-changed' {
  return previous !== null && !sameCoverage(previous, approved) ? 'coverage-changed' : 'approved';
}

/** True while the draft may be edited: no pending revision and the record is not closed. */
export function isProductDraftEditable(
  status: ProductCertificationStatus,
  pendingRevisionId: string | null,
): boolean {
  if (pendingRevisionId !== null) return false;
  return (
    status === 'draft' || status === 'approved' || status === 'expired' || status === 'suspended'
  );
}

/** The record's status after a submission: a first one goes to review; T3 keeps the others. */
export function statusAfterProductSubmit(
  status: ProductCertificationStatus,
): ProductCertificationStatus {
  return status === 'draft' ? 'in-review' : status;
}

/**
 * The record's status after a decision on its pending revision (design 3.4): an approval makes it
 * `approved` (also a renewal of an expired record and a re-review of a suspended one); a rejection
 * ends a record that was never approved (`rejected`, terminal) and leaves any other as it was.
 */
export function statusAfterProductDecision(
  status: ProductCertificationStatus,
  hasApproval: boolean,
  outcome: 'approved' | 'rejected',
): ProductCertificationStatus {
  if (outcome === 'approved') return 'approved';
  return hasApproval ? status : 'rejected';
}

/**
 * The boundary stored at approval (2.4 rule 3, ADR-0028 d8): 00:00 of the day after the expiry
 * date in the Market's configured zone, with the zone. No expiry date: neither (data design 3.16).
 */
export function productApprovalBoundary(
  expiryDate: Temporal.PlainDate | null,
  marketZone: TimeZoneId,
): { readonly at: Temporal.Instant | null; readonly zone: TimeZoneId | null } {
  if (expiryDate === null) return { at: null, zone: null };
  return { at: expiryBoundary(expiryDate, marketZone), zone: marketZone };
}

/** The settings of the type's published revision a submission is checked against. */
export interface ProductTypeSettings {
  readonly status: 'active' | 'inactive';
  readonly verificationMode: VerificationMode;
  readonly requiresIssuerRegistry: boolean;
  readonly requiresDocument: boolean;
  readonly requiresExpiry: boolean;
}

/** The draft as stored (the number only as "set"; it is ciphertext in the store). */
export interface StoredProductDraft {
  readonly manufacturerName: string | null;
  readonly issuerId: Id | null;
  readonly certificateNumberSet: boolean;
  readonly issueDate: Temporal.PlainDate | null;
  readonly expiryDate: Temporal.PlainDate | null;
  readonly coverage: readonly CoverageEntry[];
}

export interface ProductSubmitInput {
  readonly draft: StoredProductDraft;
  readonly type: ProductTypeSettings;
  /** The draft's issuer as it stands: its state and whether it is of the certificate's type. */
  readonly issuer: { readonly state: IssuerState; readonly typeMatches: boolean } | null;
  /** The record already has an approved revision. */
  readonly hasApproval: boolean;
  /** Files of the draft; none can be attached before the documents part of the slice. */
  readonly documentCount: number;
  readonly marketZone: TimeZoneId;
  readonly now: Temporal.Instant;
}

export type ProductSubmitRefusal =
  | { readonly code: 'type.manufacturer-basis-not-allowed' }
  | { readonly code: 'type.inactive' }
  | { readonly code: 'certificate.incomplete'; readonly fields: readonly DraftField[] }
  | { readonly code: 'issuer.not-active' }
  | { readonly code: 'certificate.expired' };

/**
 * The guards of a submission (design 3.4 row 2): a third-party document type (a self-declaration
 * type has no manufacturer basis, CERT-40); an active type for a record never approved (CERT-03);
 * a complete draft (manufacturer, issuer, number, the expiry date and a document when the type
 * requires them, a valid coverage); the issuer `active` and of the type; the boundary after now.
 * `null` allows it.
 */
export function submitRefusal(input: ProductSubmitInput): ProductSubmitRefusal | null {
  const { draft, type } = input;
  if (type.verificationMode !== 'THIRD_PARTY_DOCUMENT') {
    return { code: 'type.manufacturer-basis-not-allowed' };
  }
  if (type.status !== 'active' && !input.hasApproval) return { code: 'type.inactive' };
  const fields: DraftField[] = [];
  if (draft.manufacturerName === null) fields.push({ path: 'manufacturerName', code: 'required' });
  // A manufacturer basis always names its issuer (data design 3.16: `issuer_id` NOT NULL).
  if (draft.issuerId === null) fields.push({ path: 'issuerId', code: 'required' });
  if (!draft.certificateNumberSet) fields.push({ path: 'certificateNumber', code: 'required' });
  if (type.requiresExpiry && draft.expiryDate === null) {
    fields.push({ path: 'expiryDate', code: 'required' });
  }
  if (type.requiresDocument && input.documentCount < 1) {
    fields.push({ path: 'documents', code: 'required' });
  }
  for (const problem of coverageProblems(draft.coverage)) {
    fields.push({ path: 'coverage', code: problem });
  }
  if (fields.length > 0) return { code: 'certificate.incomplete', fields };
  if (input.issuer === null || input.issuer.state !== 'active' || !input.issuer.typeMatches) {
    return { code: 'issuer.not-active' };
  }
  const { at } = productApprovalBoundary(draft.expiryDate, input.marketZone);
  if (at !== null && Temporal.Instant.compare(at, input.now) <= 0) {
    return { code: 'certificate.expired' };
  }
  return null;
}

export interface ProductApprovalInput {
  readonly actorAccountId: string;
  /** The record's creator (data design 3.16 `author_account_id`). */
  readonly authorAccountId: string;
  /** Every admin who edited the record, a file or the coverage of the revision, and its submitter. */
  readonly editorAccountIds: readonly string[];
  readonly status: ProductCertificationStatus;
  readonly issuer: { readonly state: IssuerState; readonly typeMatches: boolean } | null;
  /** The type's status, share-locked in the decision unit. */
  readonly typeActive: boolean;
  readonly hasApproval: boolean;
  /** The boundary in the Market's current zone; null without an expiry date. */
  readonly boundary: Temporal.Instant | null;
  readonly now: Temporal.Instant;
}

export type ProductApprovalRefusal =
  | { readonly code: 'approval.same-admin' }
  | { readonly code: 'certificate.closed' }
  | { readonly code: 'certificate.suspended' }
  | { readonly code: 'issuer.not-active' }
  | { readonly code: 'type.inactive' }
  | { readonly code: 'certificate.expired' };

/**
 * The guards of an approval of the pending revision (design 3.4 row 3; Q3, AC 20): the approver is
 * another person (not the record's creator and not any admin who edited the revision under
 * review); the record is not closed or suspended; the issuer is `active` and of the type; the type is active for
 * a record never approved (CERT-03); the boundary in the Market zone is after now. `null` allows it.
 */
export function approvalRefusal(input: ProductApprovalInput): ProductApprovalRefusal | null {
  if (
    input.actorAccountId === input.authorAccountId ||
    input.editorAccountIds.includes(input.actorAccountId)
  ) {
    return { code: 'approval.same-admin' };
  }
  if (input.status === 'rejected' || input.status === 'revoked') {
    return { code: 'certificate.closed' };
  }
  // A suspension is lifted only through reinstate (design 3.4 row 7; Hassan L1, slice 15): an
  // approval of a revision submitted while suspended would end it without the reinstate guards.
  if (input.status === 'suspended') return { code: 'certificate.suspended' };
  if (input.issuer === null || input.issuer.state !== 'active' || !input.issuer.typeMatches) {
    return { code: 'issuer.not-active' };
  }
  if (!input.typeActive && !input.hasApproval) return { code: 'type.inactive' };
  if (input.boundary !== null && Temporal.Instant.compare(input.boundary, input.now) <= 0) {
    return { code: 'certificate.expired' };
  }
  return null;
}
