import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { Reward } from '../../domain/calculation/types';
import type { PromotionsFailure } from '../failures';
import { activeSettings } from '../market-switch';
import type { PromotionsDependencies } from '../promotions-dependencies';

/** The most gifts one store's answer lists. */
const MAX_GIFTS = 5;

/** A store's live follower offer, as the store page and the "followed" answer show it. */
export interface StoreFollowGiftView {
  readonly promotionId: string;
  readonly name: string;
  readonly reward:
    | { readonly kind: 'PERCENT'; readonly bps: number }
    | { readonly kind: 'FIXED'; readonly amountMinor: string };
  readonly currency: string;
  readonly minSpendMinor: string | null;
  readonly endsAt: string | null;
}

const rewardView = (reward: Reward): StoreFollowGiftView['reward'] => {
  if (reward.kind === 'PERCENT') return { kind: 'PERCENT', bps: reward.bps };
  return { kind: 'FIXED', amountMinor: reward.amount.toString() };
};

/**
 * `promotions.view-store-follow-gift` (the "Follow gift", customers management phase 3): the
 * store's live store-follower promotions, shown on the store page and right after the customer
 * follows. Only ACTIVE promotions of that seller that have started and not ended, not in test mode
 * and without a code; the newest first, at most 5. Anonymous: what a store offers its followers is
 * public; whether this customer follows the store is not read here. The offer is applied by the
 * quote, which asks `engagement` whether the customer follows the store.
 */
export class ViewStoreFollowGift extends UseCase<
  { readonly sellerId: string },
  { readonly gifts: readonly StoreFollowGiftView[] },
  PromotionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'promotions.view-store-follow-gift',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PromotionsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly sellerId: string },
  ): Promise<Result<{ readonly gifts: readonly StoreFollowGiftView[] }, PromotionsFailure>> {
    const seller = typeof input?.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
    if (seller === null || !seller.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'sellerId', code: 'value' }] });
    }
    const switched = await activeSettings(this.deps, context);
    if (!switched.ok) {
      // A Market with promotions off offers no gift; an outage stays an outage.
      return switched.error.code === 'promotions.disabled' ? ok({ gifts: [] }) : switched;
    }
    const { deps } = this;
    const live = await deps.unitOfWork.run(
      context.market,
      async () =>
        ok(
          await deps.promotions.listLiveOfTypes(context.market, deps.clock.now(), [
            'STORE_FOLLOWER',
          ]),
        ),
      { readOnly: true },
    );
    if (!live.ok) return err({ code: 'promotions.unavailable' });
    const gifts = live.value
      .filter(
        (record) =>
          record.ownerSellerId === seller.value && !record.testMode && record.code === null,
      )
      .sort((a, b) => b.startsAt.epochMilliseconds - a.startsAt.epochMilliseconds)
      .slice(0, MAX_GIFTS)
      .map((record): StoreFollowGiftView => ({
        promotionId: record.id,
        name: record.name,
        reward: rewardView(record.reward),
        currency: record.currency,
        minSpendMinor: record.minSpendMinor === null ? null : record.minSpendMinor.toString(),
        endsAt: record.endsAt === null ? null : record.endsAt.toString(),
      }));
    return ok({ gifts });
  }
}
