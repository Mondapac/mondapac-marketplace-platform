import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ExportFile } from '../../../../platform/list-export';
import { REVIEWS_SELLER_VIEW } from '../../contracts/permissions';
import {
  exportSellerReviewRows,
  type SellerReviewExportInput,
  type SellerReviewListDependencies,
  type SellerReviewListFailure,
} from '../seller-review-list-flow';

/** `reviews.export-seller-reviews` (super list 32): the shop's reviews of the list as CSV or XLSX. */
export class ExportSellerReviews extends UseCase<
  SellerReviewExportInput,
  ExportFile,
  SellerReviewListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.export-seller-reviews',
    rule: { kind: 'permissions', allOf: [REVIEWS_SELLER_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerReviewListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: SellerReviewExportInput) {
    return exportSellerReviewRows(this.deps, context, input);
  }
}
