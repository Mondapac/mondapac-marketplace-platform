import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  CUSTOMER_PAYMENTS_MAX_WINDOW,
  isAdmin,
  PAYMENTS_CUSTOMER_PAYMENT_VIEW,
  type AdminCustomerPaymentsFailure,
  type CustomerPaymentsDependencies,
} from './admin-customer-payments.use-case';

/**
 * `ordering.admin-customer-order-ids`: the ids of one customer's orders, newest first, at most
 * `limit` (1 to 10,001), for payments' disputes of a customer. Same rule as above. In-process only.
 */
export class AdminCustomerOrderIds extends UseCase<
  { readonly accountId: Id<'Account'>; readonly limit: number },
  readonly Id<'Order'>[],
  AdminCustomerPaymentsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-customer-order-ids',
    rule: { kind: 'permissions', allOf: [PAYMENTS_CUSTOMER_PAYMENT_VIEW] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomerPaymentsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    request: { readonly accountId: Id<'Account'>; readonly limit: number },
  ): Promise<Result<readonly Id<'Order'>[], AdminCustomerPaymentsFailure>> {
    if (!isAdmin(context)) return err({ code: 'access.denied' });
    const limit = Math.min(Math.max(request.limit, 1), CUSTOMER_PAYMENTS_MAX_WINDOW);
    const read = await this.deps.unitOfWork.run(
      context.market,
      async () => ok(await this.deps.payments.orderIds(context.market, request.accountId, limit)),
      { readOnly: true },
    );
    return read.ok ? read : err({ code: 'access.unavailable' });
  }
}
