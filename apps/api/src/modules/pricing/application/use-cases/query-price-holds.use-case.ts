import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PRICING_PRICE_HOLD_VIEW } from '../../contracts/permissions';
import {
  listAdminHolds,
  type AdminHoldListDependencies,
  type AdminHoldListPage,
  type HoldListFailure,
  type HoldListInput,
} from '../admin-hold-list-flow';

/**
 * `pricing.query-price-holds` (super list 19): an admin lists the held prices of the Market:
 * views with counts, filters, sort, page numbers or Previous/Next and each row's actions. Same key
 * as the older queue (`pricing.price-hold.view`); it reads the same records.
 */
export class QueryPriceHolds extends UseCase<HoldListInput, AdminHoldListPage, HoldListFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'pricing.query-price-holds',
    rule: { kind: 'permissions', allOf: [PRICING_PRICE_HOLD_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminHoldListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: HoldListInput) {
    return listAdminHolds(this.deps, context, input);
  }
}
