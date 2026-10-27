import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ProductRatingSummary } from '../../contracts';
import type { SummaryFailure } from '../failures';
import { viewProductSummary } from '../read-flow';
import type { ReviewsDependencies } from '../reviews-dependencies';

/** `reviews.view-product-summary`: the stars of a product, from its first review (anonymous). */
export class ViewProductSummary extends UseCase<
  { readonly productId?: unknown },
  ProductRatingSummary,
  SummaryFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'reviews.view-product-summary',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: { readonly productId?: unknown }) {
    return viewProductSummary(this.deps, context, input);
  }
}
