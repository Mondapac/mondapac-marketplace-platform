import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  sellerApprovedCultures,
  type SellerApprovedCulturesDependencies,
  type SellerApprovedCulturesFailure,
  type SellerApprovedCulturesInput,
} from './seller-approved-cultures.use-case';

/** `sellers.seller-approved-cultures-system`: the same answer for handlers and jobs (the index). */
export class SellerApprovedCulturesSystem extends UseCase<
  SellerApprovedCulturesInput,
  ReadonlyMap<Id<'Seller'>, readonly Id<'Culture'>[]>,
  SellerApprovedCulturesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.seller-approved-cultures-system',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerApprovedCulturesDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: SellerApprovedCulturesInput,
  ): Promise<
    Result<ReadonlyMap<Id<'Seller'>, readonly Id<'Culture'>[]>, SellerApprovedCulturesFailure>
  > {
    return sellerApprovedCultures(this.deps, context, input);
  }
}
