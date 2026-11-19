import { err, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  accountOfOrder,
  accountOfRefund,
  type ReadModelFailure,
} from '../customer-read-model-flow';
import {
  markHandled,
  syncSellerCustomers,
  type SellerCustomerDependencies,
} from '../seller-customers-flow';
import type { SyncCustomerInput } from './sync-customer-read-model.use-case';

/**
 * `customers.sync-seller-customers`: from a subscription on an `ordering` order or refund event or
 * an `engagement` follow event. Rule `system`. Brings the customer's per-seller rows in line with
 * `ordering` and `engagement` (a replace, never an increment), once per delivery.
 */
export class SyncSellerCustomers extends UseCase<
  SyncCustomerInput,
  { readonly rows: number },
  ReadModelFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.sync-seller-customers',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerCustomerDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SyncCustomerInput,
  ): Promise<Result<{ readonly rows: number }, ReadModelFailure>> {
    let accountId;
    if ('accountId' in input) {
      const parsed =
        typeof input.accountId === 'string' ? parseId<'Account'>(input.accountId) : null;
      if (parsed === null || !parsed.ok) return err({ code: 'validation.failed' });
      accountId = parsed.value;
    } else {
      const found =
        'refundId' in input
          ? await accountOfRefund(this.deps, context, input.orderId, input.refundId)
          : await accountOfOrder(this.deps, context, input.orderId);
      if (!found.ok) return found;
      if (found.value === null) return markHandled(this.deps, context, input.delivery);
      accountId = found.value;
    }
    return syncSellerCustomers(this.deps, context, accountId, input.delivery);
  }
}
