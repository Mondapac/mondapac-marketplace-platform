import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { SellerRatingSummary } from '../../contracts';
import type { SummaryFailure } from '../failures';
import { viewSellerSummary } from '../read-flow';
import type { ReviewsDependencies } from '../reviews-dependencies';

/** `reviews.view-seller-summary`: a seller's rated-order summary with its count (anonymous; the web decides what to show). */
export class ViewSellerSummary extends UseCase<
  { readonly sellerId?: unknown },
  SellerRatingSummary,
  SummaryFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.view-seller-summary',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly sellerId?: unknown }) {
    return viewSellerSummary(this.deps, context, input);
  }
}
