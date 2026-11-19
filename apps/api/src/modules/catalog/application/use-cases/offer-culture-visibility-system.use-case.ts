import { Logger } from '@nestjs/common';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OfferCultureCodes } from '../../contracts/catalog-cultures.facade';
import {
  offerCultureVisibility,
  type OfferCultureVisibilityDependencies,
  type OfferCultureVisibilityFailure,
  type OfferCultureVisibilityInput,
} from './offer-culture-visibility.use-case';

/** `catalog.offer-culture-visibility-system`: the same answer for handlers and jobs (the index). */
export class OfferCultureVisibilitySystem extends UseCase<
  OfferCultureVisibilityInput,
  OfferCultureCodes,
  OfferCultureVisibilityFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.offer-culture-visibility-system',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('OfferCultureVisibilitySystem');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OfferCultureVisibilityDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: OfferCultureVisibilityInput,
  ): Promise<Result<OfferCultureCodes, OfferCultureVisibilityFailure>> {
    return offerCultureVisibility(this.deps, context, input, this.#logger);
  }
}
