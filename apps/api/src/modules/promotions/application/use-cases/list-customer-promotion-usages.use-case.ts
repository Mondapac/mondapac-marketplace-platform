import type { CallContext, Result } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type PermissionKey,
  type UseCaseGate,
} from '../../../../platform/authz';
import { PROMOTIONS_PROMOTION_VIEW } from '../../contracts/permissions';
import type { PromotionsFailure } from '../failures';
import type { PromotionsDependencies } from '../promotions-dependencies';
import { listUsagesOfCustomer, type UsagePage } from '../usage-read-flow';

export type { UsagePage } from '../usage-read-flow';

/**
 * The customers view key (declared by `customers`; cast here, pinned by a contract test): every tab
 * of the customer page needs it beside the owning module's own key.
 */
export const CUSTOMER_DATA_VIEW_KEY = 'customers.customers.view' as PermissionKey;

type Input = {
  readonly customerAccountId?: unknown;
  readonly limit?: unknown;
  readonly cursor?: unknown;
};

/** `promotions.list-customer-promotion-usages`: the discounts one customer's orders took (admin viewer; the admin customer page). */
export class ListCustomerPromotionUsages extends UseCase<Input, UsagePage, PromotionsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.list-customer-promotion-usages',
    rule: { kind: 'permissions', allOf: [PROMOTIONS_PROMOTION_VIEW.key, CUSTOMER_DATA_VIEW_KEY] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PromotionsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: Input,
  ): Promise<Result<UsagePage, PromotionsFailure>> {
    return listUsagesOfCustomer(this.deps, context, input);
  }
}
