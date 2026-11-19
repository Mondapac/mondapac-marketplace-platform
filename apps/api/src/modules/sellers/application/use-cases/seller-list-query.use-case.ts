import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_SELLER_VIEW } from '../../contracts/permissions';
import {
  listSellers,
  type SellerSuperListDependencies,
  type SellerSuperListFailure,
  type SellerSuperListInput,
  type SellerSuperListPage,
} from '../seller-super-list-flow';

export type { SellerSuperListFailure } from '../seller-super-list-flow';

/**
 * `sellers.seller-list-query` (super list 15): an admin lists the Market's sellers with page
 * numbers or Previous/Next, a sort and the row actions. Same key as the older list
 * (`sellers.seller.view`); the status, the owner and the identity state tabs also need
 * `identity.seller-access.view`, asked through `SellerStatusViewProbe`.
 */
export class SellerListQuery extends UseCase<
  SellerSuperListInput,
  SellerSuperListPage,
  SellerSuperListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.seller-list-query',
    rule: { kind: 'permissions', allOf: [SELLERS_SELLER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerSuperListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: SellerSuperListInput) {
    return listSellers(this.deps, context, input);
  }
}
