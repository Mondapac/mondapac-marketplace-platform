import { ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { REVIEWS_SELLER_REPORT } from '../../contracts/permissions';

/**
 * `reviews.seller-review-report-probe`: asks the gate whether the caller holds
 * `reviews.seller.report`. It reads and writes nothing. The review list calls it to name the row
 * actions the caller may run; `access.denied` means "no". The action's own use case checks its
 * key, the review and the session again when it runs.
 */
export class SellerReviewReportProbe extends UseCase<
  Record<string, never>,
  { readonly held: true },
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.seller-review-report-probe',
    rule: { kind: 'permissions', allOf: [REVIEWS_SELLER_REPORT.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(): Promise<Result<{ readonly held: true }, { readonly code: 'access.denied' }>> {
    return Promise.resolve(ok({ held: true }));
  }
}
