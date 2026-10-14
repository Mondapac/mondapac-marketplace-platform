import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  allowedProductTypesFor,
  type AllowedProductTypesAnswer,
  type AllowedProductTypesDependencies,
  type AllowedProductTypesFailure,
  type AllowedProductTypesInput,
} from './allowed-product-types.use-case';

/** `allowedProductTypesOf` for event handlers and jobs: rule `system`, the same answer. */
export class AllowedProductTypesSystem extends UseCase<
  AllowedProductTypesInput,
  AllowedProductTypesAnswer,
  AllowedProductTypesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.allowed-product-types-system',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AllowedProductTypesDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: AllowedProductTypesInput,
  ): Promise<Result<AllowedProductTypesAnswer, AllowedProductTypesFailure>> {
    return allowedProductTypesFor(this.deps, context, input.sellerId);
  }
}
