import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_SELLER_CERTIFICATE_VIEW } from '../../contracts/permissions';
import type { SubmissionKind } from '../../domain/seller-certificate';
import {
  invalid,
  reviewerOf,
  reviewFailure,
  type ReviewDependencies,
  type ValidationFailure,
} from '../review/review.shared';
import type { ReviewQueueEntry } from '../ports/review.repository';

export const QUEUE_DEFAULT_PAGE_SIZE = 25;
export const QUEUE_MAX_PAGE_SIZE = 50;
/** The most waiting submissions one read takes (queue sizes are tens to hundreds; design A5). */
const QUEUE_READ_CAP = 500;

export interface SellerCertificatesQueueInput {
  readonly afterId?: unknown;
  readonly limit?: unknown;
}

/** One waiting submission: clear fields only, with the seller's public store name (design 7.2). */
export interface QueueRow {
  readonly certificateId: string;
  /** The version a decision must name. */
  readonly version: number;
  readonly submissionId: string;
  readonly submissionNo: number;
  readonly kind: SubmissionKind;
  readonly typeCode: string;
  readonly sellerId: string;
  /** Null for a seller with no approved revision: the panel shows "not yet approved". */
  readonly storeName: string | null;
  readonly issuerName: string | null;
  readonly submittedAt: string;
}

export interface SellerCertificatesQueueOutput {
  readonly items: readonly QueueRow[];
  /** The `afterId` of the next page; null on the last page. */
  readonly nextAfterId: string | null;
  /** Every waiting submission of the Market (up to the read cap). */
  readonly total: number;
}

export type SellerCertificatesQueueFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

interface Position {
  readonly rank: 0 | 1;
  readonly at: number;
  readonly id: string;
}

const CURSOR = /^([01])_(\d{1,15})_([0-9a-f-]{36})$/;
const rankOf = (entry: ReviewQueueEntry): 0 | 1 => (entry.kind === 'renewal' ? 0 : 1);
const positionOf = (entry: ReviewQueueEntry): Position => ({
  rank: rankOf(entry),
  at: entry.submittedAt.epochMilliseconds,
  id: entry.submissionId,
});
const cursorOf = (p: Position): string => `${p.rank}_${p.at}_${p.id}`;
const before = (a: Position, b: Position): boolean =>
  a.rank !== b.rank ? a.rank < b.rank : a.at !== b.at ? a.at < b.at : a.id < b.id;

function parseCursor(value: unknown): Result<Position | null, ValidationFailure> {
  if (value === undefined || value === null) return ok(null);
  const match = typeof value === 'string' ? CURSOR.exec(value) : null;
  const id = match?.[3] === undefined ? null : parseId(match[3]);
  if (match === null || id === null || !id.ok) return invalid('afterId', 'format');
  return ok({ rank: match[1] === '0' ? 0 : 1, at: Number(match[2]), id: id.value });
}

/**
 * `seller-certificates.queue` (certification design 7.2; brief s4 b 1): the pending submissions of
 * the Market, renewals first and then the others, each group oldest submission first (then by
 * id), keyset-paged. Each row carries the seller's public store name from `sellers.sellerSummaries`,
 * called once per page at read time (nothing is stored here); a seller with no approved revision
 * has none. Clear fields only: no number, no document, no decrypted text. Rule: key
 * `certification.seller-certificate.view` and the admin population. `afterId` is the opaque
 * `nextAfterId` of the previous page.
 */
export class SellerCertificatesQueue extends UseCase<
  SellerCertificatesQueueInput,
  SellerCertificatesQueueOutput,
  SellerCertificatesQueueFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.seller-certificates-queue',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_SELLER_CERTIFICATE_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SellerCertificatesQueueInput,
  ): Promise<Result<SellerCertificatesQueueOutput, SellerCertificatesQueueFailure>> {
    if (reviewerOf(context, { write: false }) === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalid('query', 'type');
    }
    const cursor = parseCursor(input.afterId);
    if (!cursor.ok) return cursor;
    let limit = QUEUE_DEFAULT_PAGE_SIZE;
    if (input.limit !== undefined && input.limit !== null) {
      if (typeof input.limit !== 'number' || !Number.isInteger(input.limit)) {
        return invalid('limit', 'type');
      }
      if (input.limit < 1 || input.limit > QUEUE_MAX_PAGE_SIZE) return invalid('limit', 'range');
      limit = input.limit;
    }

    const { deps } = this;
    const { market } = context;
    const read = await deps.unitOfWork
      .run(market, async () => ok(await deps.reviews.queue(market, QUEUE_READ_CAP)), {
        readOnly: true,
      })
      .catch((error: unknown) => reviewFailure(context, 'certification.queue.read', error));
    if (!read.ok) return read;

    const ordered = [...read.value].sort((a, b) => {
      const pa = positionOf(a);
      const pb = positionOf(b);
      return before(pa, pb) ? -1 : before(pb, pa) ? 1 : 0;
    });
    const after = cursor.value;
    const rest = after === null ? ordered : ordered.filter((e) => before(after, positionOf(e)));
    const shown = rest.slice(0, limit);
    const last = shown[shown.length - 1];

    // Store names: one call per page, at most 100 ids (a page holds at most 50).
    const names = await deps.sellers.storeNames(context, [
      ...new Set(shown.map((entry) => entry.sellerId)),
    ] as Id<'Seller'>[]);

    return ok({
      items: shown.map((entry) => ({
        certificateId: entry.certificateId,
        version: entry.version,
        submissionId: entry.submissionId,
        submissionNo: entry.submissionNo,
        kind: entry.kind,
        typeCode: entry.typeCode,
        sellerId: entry.sellerId,
        storeName: names.get(entry.sellerId) ?? null,
        issuerName: entry.issuerName,
        submittedAt: entry.submittedAt.toString(),
      })),
      nextAfterId:
        rest.length > shown.length && last !== undefined ? cursorOf(positionOf(last)) : null,
      total: ordered.length,
    });
  }
}
