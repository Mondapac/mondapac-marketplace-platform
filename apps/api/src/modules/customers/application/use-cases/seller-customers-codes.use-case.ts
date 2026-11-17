import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_SELLER_CUSTOMERS_VIEW } from '../../contracts/permissions';
import { SELLER_CUSTOMER_MAX_SELECTED } from '../../domain/seller-customers';
import {
  invalid,
  isRecord,
  SELECTOR_KEYS,
  selectorOf,
  sellerOfCall,
  type SellerCustomerDependencies,
} from '../seller-customers-flow';
import type { SellerCustomersReadFailure } from './seller-customers-list.use-case';

export interface SellerCustomersCodesOutput {
  readonly codes: readonly string[];
  readonly total: number;
}

export type SellerCustomersCodesFailure =
  | SellerCustomersReadFailure
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total: number };

/**
 * `customers.seller-customers-codes`: the customer codes a tab, search and filters match, for
 * "select all matching" (the page then exports by the codes). At most 10,000; more is refused
 * whole with the total. Rule and shop as the list.
 */
export class SellerCustomersCodes extends UseCase<
  unknown,
  SellerCustomersCodesOutput,
  SellerCustomersCodesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.seller-customers-codes',
    rule: { kind: 'permissions', allOf: [CUSTOMERS_SELLER_CUSTOMERS_VIEW.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerCustomerDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<SellerCustomersCodesOutput, SellerCustomersCodesFailure>> {
    const sellerId = sellerOfCall(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    if (!isRecord(input)) return invalid('body', 'type');
    for (const key of Object.keys(input)) {
      if (!(SELECTOR_KEYS as readonly string[]).includes(key)) return invalid(key, 'unknown');
    }
    const selector = selectorOf(input);
    if (!selector.ok) return selector;
    const { deps } = this;
    const query = { sellerId, selector: selector.value };
    const read = await deps.unitOfWork.run(
      context.market,
      async () => {
        const rows = await deps.sellerCustomers.page(
          context.market,
          query,
          { sort: 'code', direction: 'asc' },
          { offset: 0, limit: SELLER_CUSTOMER_MAX_SELECTED + 1 },
        );
        const total =
          rows.length <= SELLER_CUSTOMER_MAX_SELECTED
            ? rows.length
            : await deps.sellerCustomers.count(context.market, query);
        return ok({ codes: rows.map((row) => row.code), total });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value.codes.length > SELLER_CUSTOMER_MAX_SELECTED) {
      return err({
        code: 'batch.too-large',
        max: SELLER_CUSTOMER_MAX_SELECTED,
        total: read.value.total,
      });
    }
    return ok(read.value);
  }
}
