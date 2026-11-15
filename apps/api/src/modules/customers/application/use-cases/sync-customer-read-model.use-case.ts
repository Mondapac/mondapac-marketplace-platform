import { err, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import {
  accountOfOrder,
  accountOfRefund,
  syncCustomer,
  type ReadModelFailure,
} from '../customer-read-model-flow';
import type { ReadModelDependencies } from '../read-model-dependencies';

/** What changed: an account, a paid order or a refund; the account is found from the id given. */
export type SyncCustomerInput = {
  readonly delivery: EventDelivery;
} & (
  | { readonly accountId: string }
  | { readonly orderId: string }
  | { readonly orderId: string; readonly refundId: string }
);

/**
 * `customers.sync-customer-read-model`: from a subscription on an `identity` account event or an
 * `ordering` order or refund event. Rule `system`. Brings the customer's directory and stats rows
 * in line with `identity` and `ordering` (a replace, never an increment), once per delivery.
 */
export class SyncCustomerReadModel extends UseCase<
  SyncCustomerInput,
  { readonly kept: boolean },
  ReadModelFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.sync-customer-read-model',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReadModelDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SyncCustomerInput,
  ): Promise<Result<{ readonly kept: boolean }, ReadModelFailure>> {
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
      accountId = found.value;
    }
    return syncCustomer(this.deps, context, accountId, input.delivery);
  }
}
