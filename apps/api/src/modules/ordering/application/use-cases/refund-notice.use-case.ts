import { err, money, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { RefundNotice, RefundNoticeFailure } from '../../contracts';
import type { OrderingDependencies } from '../checkout-flow';

interface RefundNoticeInput {
  readonly orderId: string;
  readonly refundId: string;
}

/**
 * `refund-notice`: the succeeded refund behind `ordering.refund-succeeded.v1`, for the customer's
 * refund email (order detail decision 6: the customer is told when units were unavailable). Rule
 * `system`; `notifications` calls it through the ordering facade. It answers ids, the reason code,
 * the amount and the unit count; no name, address, email or Stripe id. Only a refund of that
 * order that Stripe confirmed answers.
 */
export class RefundNoticeQuery extends UseCase<
  RefundNoticeInput,
  RefundNotice,
  RefundNoticeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.refund-notice',
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
    input: RefundNoticeInput,
  ): Promise<Result<RefundNotice, RefundNoticeFailure>> {
    const orderId = typeof input?.orderId === 'string' ? parseId<'Order'>(input.orderId) : null;
    const refundId = typeof input?.refundId === 'string' ? parseId<'Refund'>(input.refundId) : null;
    if (orderId === null || !orderId.ok || refundId === null || !refundId.ok) {
      return err({ code: 'validation.failed' });
    }
    return this.deps.unitOfWork.run<RefundNotice, RefundNoticeFailure>(
      context.market,
      async () => {
        const refund = await this.deps.refunds.findById(context.market, refundId.value);
        const order = await this.deps.orders.findById(context.market, orderId.value);
        if (
          refund === null ||
          order === null ||
          refund.orderId !== order.id ||
          refund.state !== 'succeeded'
        ) {
          return err({ code: 'ordering.refund-not-found' } as const);
        }
        return ok({
          orderId: order.id,
          accountId: order.accountId,
          refundId: refund.id,
          reason: refund.reason,
          requestedBy: refund.actor.population,
          amount: money(refund.gross, refund.currency),
          units: refund.lines.reduce((sum, line) => sum + line.quantity, 0),
        });
      },
      { readOnly: true },
    );
  }
}
