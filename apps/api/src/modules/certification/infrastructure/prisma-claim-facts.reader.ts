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
  SellerCertificateAnswer,
  SellerCertificateRequest,
  TypeAndPolicy,
} from '../application/ports/claim-facts.ports';
import type { TimeZoneId } from '../domain/claim-types';
import { VERIFICATION_MODES, type VerificationMode } from '../domain/type-revision';
import type {
  IssuerState,
  SellerCertificationStatus,
  SellerCertificationView,
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
const DATE = /^\d{4}-\d{2}-\d{2}$/u;

/**
 * {@link ClaimFactsReader} over the module's own raw read port (ADR-0030; data design 7.3: S1
 * with the badge columns of slice 10, S2 in its slice-1 form). Each call opens one read-only unit of the request's Market and
 * runs one statement in it, so a basis is decided from one snapshot. Answers follow the order of
 * the request, one per request, each carrying its key; the statements' row order is never used
 * (rows are matched by their position in the call's arrays or by code). Anything unexpected
 * rejects (the caller answers `unavailable`), never a default:
 * - a type whose published revision is NULL or unreadable is a fault, not an absent type;
 * - an approved pointer without an `approved` decision (no approved zone), or a type that
 *   requires an expiry whose decision has no boundary, is a certificate that is not valid;
 * - the policy tables do not exist yet (slice 13), so `policy` is `null` and the type's default
 *   basis applies; categories and handling of a request are not read yet.
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
    const byCode = new Map<string, TypeAndPolicy['type']>();
    for (const row of rows) {
      if (!codes.includes(row.code) || byCode.has(row.code)) {
        throw new Error('type read returned an unexpected or repeated type');
      }
      // A type without a readable published revision is a fault, never "type unknown".
      if (row.typeRevisionId === null || row.defaultBasis === null) {
        throw new Error('certification type has no readable published revision');
      }
      if (!BASES.includes(row.defaultBasis)) {
        throw new Error('certification type has an invalid default basis');
      }
      const revision = parseId(row.typeRevisionId);
      if (!revision.ok) throw new Error('published revision id is not an id');
      byCode.set(row.code, {
        publishedRevisionId: revision.value,
        defaultBasis: row.defaultBasis as 'SELLER_REQUIRED' | 'NOT_APPLICABLE',
      });
    }
    return requests.map((request) => ({
      typeCode: request.typeCode,
      type: byCode.get(request.typeCode) ?? null,
      policy: null,
    }));
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
