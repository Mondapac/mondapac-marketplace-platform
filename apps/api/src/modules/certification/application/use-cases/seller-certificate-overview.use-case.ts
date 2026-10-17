import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_SELLER_CERTIFICATE_VIEW } from '../../contracts/permissions';
import {
  reviewFailure,
  reviewerOf,
  type ReviewDependencies,
  type ValidationFailure,
} from '../review/review.shared';

export interface SellerCertificateOverviewInput {
  readonly sellerIds: unknown;
}

/** Per seller: the type codes with a valid certificate and with one awaiting review. */
export interface SellerCertificateOverviewRow {
  readonly sellerId: Id<'Seller'>;
  readonly validTypeCodes: readonly string[];
  readonly awaitingReviewTypeCodes: readonly string[];
}

export type SellerCertificateOverviewFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

export const OVERVIEW_MAX_SELLERS = 100;

/**
 * `sellerCertificateOverview` (certification design 8.1; brief s12): for the sellers admin list,
 * per requested seller (at most 100 distinct ids; one row each, in the order of first
 * occurrence), the certification type codes the seller holds a valid certificate of and those
 * with a submission waiting for review. "Valid" is the display measure of design 3.3 (approved,
 * not past its stored boundary, issuer not derecognised); the claim is decided by `evaluateClaims`
 * only. Clear fields only. A seller with nothing has two empty lists. Rule: key
 * `certification.seller-certificate.view` and the admin population. Not exposed over HTTP.
 */
export class SellerCertificateOverview extends UseCase<
  SellerCertificateOverviewInput,
  readonly SellerCertificateOverviewRow[],
  SellerCertificateOverviewFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.seller-certificate-overview',
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
    input: SellerCertificateOverviewInput,
  ): Promise<Result<readonly SellerCertificateOverviewRow[], SellerCertificateOverviewFailure>> {
    if (reviewerOf(context, { write: false }) === null) return err({ code: 'access.denied' });
    const raw = typeof input === 'object' && input !== null ? input.sellerIds : undefined;
    if (!Array.isArray(raw) || raw.length > OVERVIEW_MAX_SELLERS) {
      return err({ code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'range' }] });
    }
    const ids: Id<'Seller'>[] = [];
    for (const item of raw as unknown[]) {
      const parsed = typeof item === 'string' ? parseId<'Seller'>(item) : null;
      if (parsed === null || !parsed.ok) {
        return err({ code: 'validation.failed', fields: [{ path: 'sellerIds', code: 'format' }] });
      }
      if (!ids.includes(parsed.value)) ids.push(parsed.value);
    }
    if (ids.length === 0) return ok([]);

    const { deps } = this;
    const { market } = context;
    const now = deps.clock.now();
    const read = await deps.unitOfWork
      .run(market, async () => ok(await deps.reviews.overview(market, ids, now)), {
        readOnly: true,
      })
      .catch((error: unknown) => reviewFailure(context, 'certification.overview', error));
    if (!read.ok) return read;
    const bySeller = new Map(read.value.map((row) => [row.sellerId, row]));
    return ok(
      ids.map((sellerId) => ({
        sellerId,
        validTypeCodes: bySeller.get(sellerId)?.validTypeCodes ?? [],
        awaitingReviewTypeCodes: bySeller.get(sellerId)?.pendingTypeCodes ?? [],
      })),
    );
  }
}
