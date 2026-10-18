import { ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type {
  RawReadPort,
  RawReadRow,
} from '../../../platform/persistence/raw-reads/raw-read-port';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type {
  ClaimFactsReader,
  PolicyRequest,
  ProductCertificateAnswer,
  ProductCertificateRequest,
  SellerCertificateAnswer,
  SellerCertificateRequest,
  TypeAndPolicy,
} from '../application/ports/claim-facts.ports';
import {
  HANDLING_VALUES,
  type ClaimBasisRequirement,
  type TimeZoneId,
} from '../domain/claim-types';
import { MAX_POLICY_ROWS } from '../domain/claim-policy';
import {
  isCertificationTypeCode,
  VERIFICATION_MODES,
  type VerificationMode,
} from '../domain/type-revision';
import {
  type CoverageEntryView,
  type IssuerState,
  type ProductCertificationView,
  type SellerCertificationStatus,
  type SellerCertificationView,
} from '../domain/validity';

const STATUSES: readonly string[] = [
  'draft',
  'in-review',
  'approved',
  'changes-needed',
  'declined',
  'expired',
  'revoked',
];
const ISSUER_STATES: readonly string[] = ['proposed', 'active', 'closed-to-new', 'derecognised'];
const BASES: readonly string[] = ['SELLER_REQUIRED', 'NOT_APPLICABLE'];
const ROW_BASES: readonly string[] = [
  'SELLER_REQUIRED',
  'SELLER_OR_MANUFACTURER',
  'NOT_APPLICABLE',
];
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * {@link ClaimFactsReader} over the module's own raw read port (ADR-0030; data design 7.3: S1
 * with the badge columns of slice 10, S2 in its slice-1 form). Each call opens one read-only unit
 * of the request's Market and runs one statement in it, so a basis is decided from one snapshot. Answers follow the order of
 * the request, one per request, each carrying its key; the statements' row order is never used
 * (rows are matched by their position in the call's arrays or by code). Anything unexpected
 * rejects (the caller answers `unavailable`), never a default:
 * - a type whose published revision is NULL or unreadable is a fault, not an absent type;
 * - an approved pointer without an `approved` decision (no approved zone), or a type that
 *   requires an expiry whose decision has no boundary, is a certificate that is not valid;
 * - S2 reads every row of the type's published policy revision; the rows matching a request's
 *   categories or handling are picked here. No published revision is `policy: null` (the type's
 *   default applies); a row that breaks the policy's rules (two rows on one selector,
 *   `SELLER_OR_MANUFACTURER` on handling, an unknown value) is a fault, never skipped.
 */
export class PrismaClaimFactsReader implements ClaimFactsReader {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly rawReads: RawReadPort,
  ) {}

  async typesAndPolicies(
    market: MarketContext,
    requests: readonly PolicyRequest[],
  ): Promise<readonly TypeAndPolicy[]> {
    if (requests.length === 0) return [];
    const codes: string[] = [...new Set<string>(requests.map((request) => request.typeCode))];
    const rows = await this.read(market, () =>
      this.rawReads.rawRead(market, 'certification.type-and-policy', { typeCodes: codes }),
    );
    const byCode = new Map<string, StoredTypeAndPolicy>();
    for (const row of rows) {
      if (!codes.includes(row.code)) throw new Error('type read returned an unexpected type');
      const policyRow = policyRowOf(row);
      const known = byCode.get(row.code);
      if (known === undefined) {
        const entry = typeEntryOf(row);
        if (policyRow !== null) {
          entry.rows.push(policyRow);
          entry.keys.add(policyRow.key);
        }
        byCode.set(row.code, entry);
        continue;
      }
      // A type repeats only once per policy row, with the same type columns every time.
      if (policyRow === null || known.rows.length === 0 || !sameType(known, row)) {
        throw new Error('type read returned a repeated type');
      }
      if (known.keys.has(policyRow.key)) {
        throw new Error('policy revision has two rows on one selector');
      }
      // A revision never holds more rows than a save accepts (MAX_POLICY_ROWS): more is a fault,
      // and the whole batch answers unavailable (fail closed; data design 7.3).
      if (known.rows.length >= MAX_POLICY_ROWS) {
        throw new Error('policy revision has more rows than a revision may hold');
      }
      known.keys.add(policyRow.key);
      known.rows.push(policyRow);
    }
    return requests.map((request) => {
      const entry = byCode.get(request.typeCode);
      if (entry === undefined) return { typeCode: request.typeCode, type: null, policy: null };
      if (entry.policyRevisionId === null) {
        return { typeCode: request.typeCode, type: entry.type, policy: null };
      }
      const categories = new Set<string>(request.categoryIds);
      const matchedRows = entry.rows
        .filter((row) =>
          row.kind === 'handling' ? row.key === request.handling : categories.has(row.key),
        )
        .map((row) => ({ basis: row.basis }));
      return {
        typeCode: request.typeCode,
        type: entry.type,
        policy: { revisionId: entry.policyRevisionId, matchedRows },
      };
    });
  }

  /**
   * The manufacturer basis (S3, design 4.2 step 6; slice 14): one read-only unit, one statement,
   * keyed by the distinct (product, product revision, type) triples of the requests. Each row is
   * one coverage entry of an approved, current revision of the type covering that product
   * revision (M3); the rows of one certificate are folded into one view whose coverage holds the
   * entries of the asked product, and `ClaimRule` applies the variant rule (`covers`, L1) and the
   * type filter (L2). Anything unexpected rejects (the batch answers `unavailable`): a row for a
   * triple not asked, a certificate that is not `approved`, an unknown issuer state, two rows of
   * one certificate that disagree, more than {@link MAX_MANUFACTURER_ROWS_PER_QUERY} rows for one
   * triple. An approved pointer without an `approved` decision, or a required expiry without its
   * stored boundary, is a certificate that is not valid, never a default.
   */
  async productCertificates(
    market: MarketContext,
    requests: readonly ProductCertificateRequest[],
  ): Promise<readonly ProductCertificateAnswer[]> {
    if (requests.length === 0) return [];
    const triples = new Map<string, ProductCertificateRequest>();
    for (const request of requests) triples.set(tripleKey(request), request);
    const distinct = [...triples.values()];
    const rows = await this.read(market, () =>
      this.rawReads.rawRead(market, 'certification.manufacturer-basis', {
        productIds: distinct.map((triple) => triple.productId),
        productRevisionIds: distinct.map((triple) => triple.productRevisionId),
        typeCodes: distinct.map((triple) => triple.typeCode as string),
      }),
    );
    const byTriple = new Map<string, Map<string, FoldedCertificate>>();
    const counts = new Map<number, number>();
    for (const row of rows) {
      const triple = distinct[row.ord - 1];
      if (triple === undefined) throw new Error('manufacturer read returned an unknown position');
      if (
        row.productId !== triple.productId ||
        row.productRevisionId !== triple.productRevisionId ||
        row.typeCode !== triple.typeCode
      ) {
        throw new Error('manufacturer read returned a row for another question');
      }
      const count = (counts.get(row.ord) ?? 0) + 1;
      if (count > MAX_MANUFACTURER_ROWS_PER_QUERY) {
        throw new Error('manufacturer read returned more rows than a question may hold');
      }
      counts.set(row.ord, count);
      const key = tripleKey(triple);
      const certificates = byTriple.get(key) ?? new Map<string, FoldedCertificate>();
      byTriple.set(key, certificates);
      const held = certificates.get(row.productCertificationId);
      if (held === undefined) {
        certificates.set(row.productCertificationId, foldedOf(row));
        continue;
      }
      if (held.signature !== signatureOf(row)) {
        throw new Error('manufacturer read returned two versions of one certificate');
      }
      held.coverage.push(coverageOf(row));
    }
    return requests.map((request) => {
      const folded = byTriple.get(tripleKey(request));
      return {
        typeCode: request.typeCode,
        productId: request.productId,
        productRevisionId: request.productRevisionId,
        variantId: request.variantId,
        certificates: folded === undefined ? [] : [...folded.values()].map(productViewOf),
      };
    });
  }

  async sellerCertificates(
    market: MarketContext,
    requests: readonly SellerCertificateRequest[],
  ): Promise<readonly SellerCertificateAnswer[]> {
    if (requests.length === 0) return [];
    const pairs = new Map<string, SellerCertificateRequest>();
    for (const request of requests) pairs.set(pairKey(request), request);
    const distinct = [...pairs.values()];
    const rows = await this.read(market, () =>
      this.rawReads.rawRead(market, 'certification.seller-basis', {
        sellerIds: distinct.map((pair) => pair.sellerId),
        typeCodes: distinct.map((pair) => pair.typeCode as string),
      }),
    );
    const byPair = new Map<string, SellerCertificationView>();
    for (const row of rows) {
      const pair = distinct[row.ord - 1];
      if (pair === undefined) throw new Error('certificate read returned an unknown position');
      const key = pairKey(pair);
      // At most one non-terminal certificate per (seller, type) (data design 3.4).
      if (byPair.has(key)) throw new Error('certificate read returned two certificates for a pair');
      byPair.set(key, viewOf(row));
    }
    return requests.map((request) => ({
      sellerId: request.sellerId,
      typeCode: request.typeCode,
      certificate: byPair.get(pairKey(request)) ?? null,
    }));
  }

  private async read<T>(market: MarketContext, work: () => Promise<T>): Promise<T> {
    const result = await this.unitOfWork.run(market, async () => ok<T>(await work()), {
      readOnly: true,
    });
    if (!result.ok) throw new Error('read unit answered an error');
    return result.value;
  }
}

type SellerBasisRow = RawReadRow<'certification.seller-basis'>;
type ManufacturerRow = RawReadRow<'certification.manufacturer-basis'>;

/**
 * The most S3 rows one question may return: twenty covering certificates of a hundred variant
 * entries each. More is a fault and the batch answers `unavailable` (fail closed), as S2's bound.
 */
export const MAX_MANUFACTURER_ROWS_PER_QUERY = 2000;

const tripleKey = (t: ProductCertificateRequest): string =>
  `${t.productId}|${t.productRevisionId}|${t.typeCode}`;

/** One certificate folded from its rows: the shared columns once, the coverage entries listed. */
interface FoldedCertificate {
  readonly row: ManufacturerRow;
  /** The columns every row of one certificate repeats; a difference is a fault. */
  readonly signature: string;
  readonly coverage: CoverageEntryView[];
}

function signatureOf(row: ManufacturerRow): string {
  return JSON.stringify([
    row.typeCode,
    row.status,
    row.revisionId,
    row.typeRevisionId,
    row.requiresExpiry,
    row.issuerId,
    row.expiryDate,
    row.decisionOutcome,
    row.expiryBoundaryAt,
    row.issuerState,
    row.issuerName,
    row.verifiedWithIssuer,
  ]);
}

function coverageOf(row: ManufacturerRow): CoverageEntryView {
  const product = parseId<'Product'>(row.productId);
  const revision = parseId<'ProductRevision'>(row.productRevisionId);
  if (!product.ok || !revision.ok) throw new Error('coverage id is not an id');
  if (row.variantId === null) {
    return { productId: product.value, productRevisionId: revision.value, variantId: null };
  }
  const variant = parseId<'Variant'>(row.variantId);
  if (!variant.ok) throw new Error('coverage variant is not an id');
  return { productId: product.value, productRevisionId: revision.value, variantId: variant.value };
}

function foldedOf(row: ManufacturerRow): FoldedCertificate {
  return { row, signature: signatureOf(row), coverage: [coverageOf(row)] };
}

/**
 * A timestamptz read as text (ISO DateStyle: `2027-06-30 14:00:00+00`, fractions optional, the
 * offset hours only or with minutes); anything else throws (a fault, so the batch is unavailable).
 */
function storedInstant(value: string): Temporal.Instant {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?)([+-]\d{2})(:\d{2})?$/.exec(
    value,
  );
  if (match === null) throw new Error('expiry boundary is not a stored instant');
  return Temporal.Instant.from(`${match[1]}T${match[2]}${match[3]}${match[4] ?? ':00'}`);
}

/** One folded S3 certificate as the validity measure needs it; anything that does not fit throws. */
function productViewOf(folded: FoldedCertificate): ProductCertificationView {
  const { row } = folded;
  // S3 selects approved roots only; any other status read back is a fault.
  if (row.status !== 'approved') throw new Error('manufacturer certificate is not approved');
  const certificateId = parseId(row.productCertificationId);
  const revisionId = parseId(row.revisionId);
  const typeRevisionId = parseId(row.typeRevisionId);
  const issuerId = parseId(row.issuerId);
  if (!certificateId.ok || !revisionId.ok || !typeRevisionId.ok || !issuerId.ok) {
    throw new Error('manufacturer certificate id is not an id');
  }
  if (!isCertificationTypeCode(row.typeCode)) throw new Error('type code is not a code');
  if (!ISSUER_STATES.includes(row.issuerState)) throw new Error('issuer has no readable state');
  if (row.issuerName.length === 0) throw new Error('issuer has no readable name');
  const base = {
    certificateId: certificateId.value,
    typeCode: row.typeCode,
    status: 'approved' as const,
  };
  // The approved pointer needs an `approved` decision; without one there is no valid certificate.
  if (row.decisionOutcome !== 'approved') return { ...base, approved: null };
  // The boundary is the one stored at approval, read as stored (Hassan L1): never recomputed from
  // the date and zone. A required expiry without it reaches the measure without a date or
  // boundary: `expiry-missing`, not valid. An unreadable instant is a fault.
  let expiryDate = plainDate(row.expiryDate);
  let boundaryAtApproval: Temporal.Instant | null = null;
  if (expiryDate !== null && row.expiryBoundaryAt !== null) {
    boundaryAtApproval = storedInstant(row.expiryBoundaryAt);
  } else if (row.requiresExpiry) {
    expiryDate = null;
  }
  return {
    ...base,
    approved: {
      revisionId: revisionId.value,
      typeRevisionId: typeRevisionId.value,
      requiresExpiry: row.requiresExpiry,
      expiryDate,
      boundaryAtApproval,
      issuerId: issuerId.value,
      issuerState: row.issuerState as IssuerState,
      issuerDisplayName: row.issuerName,
      verifiedWithIssuer: row.verifiedWithIssuer,
      coverage: folded.coverage,
    },
  };
}
type TypeRow = RawReadRow<'certification.type-and-policy'>;

interface StoredPolicyRow {
  readonly kind: 'platform-category' | 'handling';
  /** The category id or the handling value. */
  readonly key: string;
  readonly basis: ClaimBasisRequirement;
}

interface StoredTypeAndPolicy {
  readonly type: NonNullable<TypeAndPolicy['type']>;
  readonly typeId: string;
  readonly policyRevisionId: Id | null;
  readonly rows: StoredPolicyRow[];
  /** The selector keys of `rows`, to refuse a second row on one selector in constant time. */
  readonly keys: Set<string>;
}

/** The type part of one S2 row; a type without a readable published revision is a fault. */
function typeEntryOf(row: TypeRow): StoredTypeAndPolicy {
  if (row.typeRevisionId === null || row.defaultBasis === null) {
    throw new Error('certification type has no readable published revision');
  }
  if (!BASES.includes(row.defaultBasis)) {
    throw new Error('certification type has an invalid default basis');
  }
  if (!(VERIFICATION_MODES as readonly string[]).includes(row.verificationMode)) {
    throw new Error('certification type has an invalid verification mode');
  }
  const revision = parseId(row.typeRevisionId);
  if (!revision.ok) throw new Error('published revision id is not an id');
  let policyRevisionId: Id | null = null;
  if (row.policyRevisionId !== null) {
    const policy = parseId(row.policyRevisionId);
    if (!policy.ok) throw new Error('policy revision id is not an id');
    policyRevisionId = policy.value;
  }
  return {
    type: {
      publishedRevisionId: revision.value,
      defaultBasis: row.defaultBasis as 'SELLER_REQUIRED' | 'NOT_APPLICABLE',
      verificationMode: row.verificationMode as VerificationMode,
    },
    typeId: row.typeId,
    policyRevisionId,
    rows: [],
    keys: new Set<string>(),
  };
}

/** Rows of one type repeat the type's columns; any difference is a fault. */
function sameType(entry: StoredTypeAndPolicy, row: TypeRow): boolean {
  return (
    entry.typeId === row.typeId &&
    entry.type.publishedRevisionId === row.typeRevisionId &&
    entry.type.defaultBasis === row.defaultBasis &&
    entry.type.verificationMode === row.verificationMode &&
    entry.policyRevisionId === row.policyRevisionId
  );
}

/** The policy row of one S2 row, or null when the row carries none. Anything off throws. */
function policyRowOf(row: TypeRow): StoredPolicyRow | null {
  const { rowSelectorKind: kind, rowCategoryId, rowHandling, rowBasis } = row;
  if (kind === null && rowCategoryId === null && rowHandling === null && rowBasis === null) {
    return null;
  }
  if (row.policyRevisionId === null) throw new Error('policy row without a published revision');
  if (rowBasis === null || !ROW_BASES.includes(rowBasis)) {
    throw new Error('policy row has an invalid basis');
  }
  const basis = rowBasis as ClaimBasisRequirement;
  if (kind === 'platform-category' && rowCategoryId !== null && rowHandling === null) {
    if (!parseId(rowCategoryId).ok) throw new Error('policy row category is not an id');
    return { kind, key: rowCategoryId, basis };
  }
  if (
    kind === 'handling' &&
    rowHandling !== null &&
    rowCategoryId === null &&
    (HANDLING_VALUES as readonly string[]).includes(rowHandling)
  ) {
    // M1: a handling row never opens the manufacturer basis.
    if (basis === 'SELLER_OR_MANUFACTURER') throw new Error('manufacturer basis on handling');
    return { kind, key: rowHandling, basis };
  }
  throw new Error('policy row has an invalid selector');
}

const pairKey = (pair: SellerCertificateRequest): string => `${pair.sellerId}|${pair.typeCode}`;

/** One S1 row as the validity measure needs it; anything that does not fit throws. */
function viewOf(row: SellerBasisRow): SellerCertificationView {
  if (!STATUSES.includes(row.status)) throw new Error('certificate has an invalid status');
  const certificateId = parseId(row.certificationId);
  if (!certificateId.ok) throw new Error('certificate id is not an id');
  const view = (approved: SellerCertificationView['approved']): SellerCertificationView => ({
    certificateId: certificateId.value,
    status: row.status as SellerCertificationStatus,
    approved,
  });
  if (row.submissionId === null) return view(null);
  // The approved pointer needs an `approved` decision with its zone; without one there is no
  // valid certificate (Hassan), whatever the root's status says.
  if (row.decisionOutcome !== 'approved' || row.approvedZone === null) return view(null);
  // Every approval today is a reviewer's (`admin`): the badge states `reviewedByPlatform: true`
  // on that basis. Any other actor on an approved decision is unreadable, so the batch fails
  // closed (Hassan L1). CERT-11's self-declaration auto-approval must derive `reviewedByPlatform`
  // from this field instead of relaxing this check.
  if (row.decisionActorKind !== 'admin') {
    throw new Error('approved decision was not made by a reviewer');
  }
  if (row.typeRevisionId === null || row.requiresExpiry === null) {
    throw new Error('approved submission has no readable type revision');
  }
  const submission = parseId(row.submissionId);
  const revision = parseId(row.typeRevisionId);
  if (!submission.ok || !revision.ok) throw new Error('submission id is not an id');
  if (!(VERIFICATION_MODES as readonly string[]).includes(row.verificationMode)) {
    throw new Error('certification type has an invalid verification mode');
  }
  let issuerId: Id | null = null;
  let issuerState: IssuerState | null = null;
  let issuerDisplayName: string | null = null;
  if (row.issuerId !== null) {
    const issuer = parseId(row.issuerId);
    if (!issuer.ok) throw new Error('issuer id is not an id');
    if (row.issuerState === null || !ISSUER_STATES.includes(row.issuerState)) {
      throw new Error('issuer has no readable state');
    }
    // The registry name is NOT NULL; an issuer without one is unreadable (fail closed).
    if (row.issuerName === null || row.issuerName.length === 0) {
      throw new Error('issuer has no readable name');
    }
    issuerId = issuer.value;
    issuerState = row.issuerState as IssuerState;
    issuerDisplayName = row.issuerName;
  }
  // A type that requires an expiry and a decision without a boundary is not valid: no expiry
  // date reaches the measure, which answers `expiry-missing`.
  const expiryDate =
    row.requiresExpiry && !row.hasExpiryBoundary ? null : plainDate(row.expiryDate);
  return view({
    submissionId: submission.value,
    typeRevisionId: revision.value,
    verificationMode: row.verificationMode as VerificationMode,
    requiresExpiry: row.requiresExpiry,
    expiryDate,
    zoneAtApproval: row.approvedZone as TimeZoneId,
    issuerId,
    issuerState,
    issuerDisplayName,
    // Read from the approved submission only: a renewal starts without it (design 3.2 rule 7).
    verifiedWithIssuer: row.verifiedWithIssuer,
  });
}

function plainDate(value: string | null): Temporal.PlainDate | null {
  if (value === null) return null;
  if (!DATE.test(value)) throw new Error('expiry date is not a date');
  return Temporal.PlainDate.from(value);
}
