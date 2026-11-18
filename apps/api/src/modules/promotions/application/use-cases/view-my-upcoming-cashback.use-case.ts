import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PromotionsFailure } from '../failures';
import { activeSettings } from '../market-switch';
import type { PromotionsDependencies } from '../promotions-dependencies';

/** At most this many waiting cashbacks are answered (newest first); a customer rarely has more. */
export const UPCOMING_CASHBACK_LIMIT = 20;

/** A cashback that is earned but not yet in the wallet: display only, never a balance. */
export interface UpcomingCashbackView {
  readonly orderId: Id<'Order'>;
  readonly amountMinor: bigint;
  readonly currency: string;
  /**
   * When it is expected in the wallet: the seller order's payout release. Null when that day has
   * passed and the credit is on its way (the grant job runs every 15 minutes, or a payout hold
   * keeps it waiting).
   */
  readonly creditOn: Temporal.Instant | null;
}

export interface ViewMyUpcomingCashbackInput {
  /** Only this order's cashback (the order page); omitted for every waiting one. */
  readonly orderId?: string;
}

/**
 * `promotions.view-my-upcoming-cashback` (customers phase 4c, owner option A): the signed-in
 * customer's own cashback that waits for the seller's payout release, for the line "cashback X
 * will be credited on date Y" on the order page and the account. Rule `own-resources`: the account
 * comes from the session, so another customer's order simply has none. Nothing here changes a
 * balance, and a Market with promotions off answers an empty list.
 */
export class ViewMyUpcomingCashback extends UseCase<
  ViewMyUpcomingCashbackInput,
  { readonly cashback: readonly UpcomingCashbackView[] },
  PromotionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.view-my-upcoming-cashback',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PromotionsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ViewMyUpcomingCashbackInput,
  ): Promise<Result<{ readonly cashback: readonly UpcomingCashbackView[] }, PromotionsFailure>> {
    const actor = context.actor;
    if (actor.kind !== 'authenticated' || actor.population !== 'customer') {
      return err({ code: 'access.denied' });
    }
    let orderId: Id<'Order'> | undefined;
    if (input?.orderId !== undefined) {
      const parsed = typeof input.orderId === 'string' ? parseId<'Order'>(input.orderId) : null;
      if (parsed === null || !parsed.ok) {
        return err({ code: 'validation.failed', fields: [{ path: 'orderId', code: 'value' }] });
      }
      orderId = parsed.value;
    }
    const switched = await activeSettings(this.deps, context);
    if (!switched.ok) {
      return switched.error.code === 'promotions.disabled' ? ok({ cashback: [] }) : switched;
    }
    const { deps } = this;
    const now = deps.clock.now();
    return deps.unitOfWork.run(
      context.market,
      async () => {
        const waiting = await deps.credits.listWaitingCashback(
          context.market,
          actor.accountId,
          UPCOMING_CASHBACK_LIMIT,
          orderId,
        );
        const cashback: UpcomingCashbackView[] = [];
        for (const credit of waiting) {
          // A cashback with no order cannot be placed on a page; a zero one is nothing to show.
          if (credit.orderId === null || credit.amountMinor <= 0n) continue;
          const creditOn =
            credit.grantAfter !== null && Temporal.Instant.compare(credit.grantAfter, now) > 0
              ? credit.grantAfter
              : null;
          cashback.push({
            orderId: credit.orderId,
            amountMinor: credit.amountMinor,
            currency: credit.currency,
            creditOn,
          });
        }
        return ok({ cashback });
      },
      { readOnly: true },
    );
  }
}
