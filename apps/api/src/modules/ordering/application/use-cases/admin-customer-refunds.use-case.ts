import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ORDERING_ORDER_VIEW } from '../../contracts/permissions';
import { isActingAsSession } from '../acting-as';
import type { OrderingDependencies } from '../checkout-flow';
import { refundView, type RefundView } from '../refund-flow';

/** Refunds the Money tab shows; older ones are reached through the orders. */
export const CUSTOMER_REFUNDS_LIMIT = 100;

export type AdminCustomerRefundsFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

/**
 * `ordering.admin-customer-refunds`: the refunds of the orders one customer placed, newest first
 * (at most 100), each with its credit note id when it succeeded: the Money tab of the customer's
 * page. Rule: `permissions [ordering.order.view]` and the admin population. A customer with no
 * order, or of another Market, has none. Ids, codes, amounts and instants only.
 */
export class AdminCustomerRefunds extends UseCase<
  { readonly accountId: unknown },
  { readonly refunds: readonly RefundView[] },
  AdminCustomerRefundsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.admin-customer-refunds',
    rule: { kind: 'permissions', allOf: [ORDERING_ORDER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly accountId: unknown },
  ): Promise<Result<{ readonly refunds: readonly RefundView[] }, AdminCustomerRefundsFailure>> {
    const { actor } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'admin' ||
      isActingAsSession(actor)
    ) {
      return err({ code: 'access.denied' });
    }
    const parsed = typeof input.accountId === 'string' ? parseId<'Account'>(input.accountId) : null;
    if (parsed === null || !parsed.ok) {
      return err({
        code: 'validation.failed',
        fields: [{ path: 'accountId', code: 'format' }],
      });
    }
    const read = await this.deps.unitOfWork.run(
      context.market,
      async () =>
        ok(
          await this.deps.refunds.listForAccount(
            context.market,
            parsed.value,
            CUSTOMER_REFUNDS_LIMIT,
          ),
        ),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    return ok({
      refunds: read.value.map(({ refund, creditNoteId }) => refundView(refund, creditNoteId)),
    });
  }
}
