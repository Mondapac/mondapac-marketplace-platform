import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { CustomerOrderAccounts, CustomerOrderStatsFailure } from '../../contracts';
import type { OrderingDependencies } from '../checkout-flow';

/** `customer-order-accounts`: a keyset page of the accounts that have a confirmed order. Rule `system`. */
export class CustomerOrderAccountsQuery extends UseCase<
  { readonly after: string | null; readonly limit: number },
  CustomerOrderAccounts,
  CustomerOrderStatsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.customer-order-accounts',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly after: string | null; readonly limit: number },
  ): Promise<Result<CustomerOrderAccounts, CustomerOrderStatsFailure>> {
    const limit = input?.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return err({ code: 'validation.failed' });
    }
    let after = null;
    if (input.after !== null) {
      const parsed = typeof input.after === 'string' ? parseId<'Account'>(input.after) : null;
      if (parsed === null || !parsed.ok) return err({ code: 'validation.failed' });
      after = parsed.value;
    }
    return this.deps.unitOfWork.run<CustomerOrderAccounts, CustomerOrderStatsFailure>(
      context.market,
      async () => {
        const accountIds = await this.deps.orders.accountsWithConfirmedOrders(
          context.market,
          after,
          limit,
        );
        return ok({ accountIds });
      },
      { readOnly: true },
    );
  }
}
