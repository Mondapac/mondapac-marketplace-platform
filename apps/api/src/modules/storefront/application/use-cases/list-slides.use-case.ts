import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_SLIDE_READ } from '../../contracts/permissions';
import { type SlideFailure, type SlideSummaryView, listSlides } from '../slide-flow';
import type { StorefrontDependencies } from '../storefront-dependencies';

/** `storefront.list-slides`: An admin lists the slides of the Market, by status and position. */
export class ListStorefrontSlides extends UseCase<
  { readonly state?: unknown; readonly position?: unknown },
  readonly SlideSummaryView[],
  SlideFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'storefront.list-slides',
    rule: { kind: 'permissions', allOf: [STOREFRONT_SLIDE_READ.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: StorefrontDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly state?: unknown; readonly position?: unknown },
  ) {
    return listSlides(this.deps, context, input);
  }
}

export type { SlideSummaryView } from '../slide-flow';
