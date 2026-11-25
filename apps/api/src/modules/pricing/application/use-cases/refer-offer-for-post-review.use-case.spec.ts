import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { OfferPostReviewReferral } from '../../../catalog';
import { POST_REVIEW_FLAG_REASONS } from '../../domain/events';
import {
  REFER_FOR_POST_REVIEW_SUBSCRIBER,
  postReviewFlagSubscriptions,
} from '../../presentation/subscribers/post-review-flag.subscriptions';
import { ReferOfferForPostReview } from './refer-offer-for-post-review.use-case';

// Pricing's hand-over of its R4 flag to catalog's post-publication review list (risk-based Offer
// approval slice 6): `pricing.refer-offer-for-post-review` and its subscription.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);

const OFFER = '01990000-0000-7000-8000-0000000e0001' as Id<'Offer'>;
const SELLER = '01990000-0000-7000-8000-00000000c001' as Id<'Seller'>;
const PRODUCT = '01990000-0000-7000-8000-00000000d001';
const RECORD = '01990000-0000-7000-8000-0000000f0001';
const DELIVERY: EventDelivery = {
  eventId: '01990000-0000-7000-8000-000000000e01' as Id<'event'>,
  subscriber: REFER_FOR_POST_REVIEW_SUBSCRIBER,
  attempt: 1,
};

describe.each(TEST_MARKET_IDS)('pricing.refer-offer-for-post-review in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const system = testCallContext(market, 'system');

  function rig(answer: { ok: true; code: string } | { ok: false; code: string } | 'throw') {
    const calls: { context: CallContext; referral: OfferPostReviewReferral }[] = [];
    const refer = new ReferOfferForPostReview(gate, {
      catalog: {
        referOfferForPostReview: (context, referral) => {
          calls.push({ context, referral });
          if (answer === 'throw') return Promise.reject(new Error('catalog down'));
          return Promise.resolve(
            answer.ok
              ? { ok: true as const, value: { code: answer.code } }
              : { ok: false as const, error: { code: answer.code } },
          );
        },
      },
    });
    return { refer, calls };
  }

  it("maps each pricing reason to catalog's, keyed on the record, in the delivery's Market", async () => {
    const expected = {
      'no-reference': 'price-no-reference',
      'reference-unavailable': 'price-reference-unavailable',
      'recheck-outside': 'price-recheck-outside',
    } as const;
    for (const reason of POST_REVIEW_FLAG_REASONS) {
      const r = rig({ ok: true, code: 'post-review.opened' });
      expect(
        await r.refer.execute(system, {
          delivery: DELIVERY,
          offerId: OFFER,
          sellerId: SELLER,
          recordId: RECORD,
          reason,
        }),
      ).toEqual({ ok: true, value: { code: 'post-review.opened' } });
      expect(r.calls).toEqual([
        {
          context: system,
          referral: {
            offerId: OFFER,
            sellerId: SELLER,
            reason: expected[reason],
            sourceRef: RECORD,
          },
        },
      ]);
      expect(r.calls[0]!.context.market.marketId).toBe(code);
    }
  });

  it('takes the system actor only', async () => {
    const r = rig({ ok: true, code: 'post-review.opened' });
    const admin = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: '01990000-0000-7000-8000-0000000a0001' as Id<'Account'>,
        sessionId: '01990000-0000-7000-8000-0000000b0001' as Id<'Session'>,
        sellerId: null,
      }),
    );
    expect(
      await r.refer.execute(admin, {
        delivery: DELIVERY,
        offerId: OFFER,
        sellerId: SELLER,
        recordId: RECORD,
        reason: 'no-reference',
      }),
    ).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(r.calls).toEqual([]);
  });

  describe('the subscription', () => {
    const event = {
      payload: {
        offerId: OFFER,
        productId: PRODUCT,
        sellerId: SELLER,
        recordId: RECORD,
        reason: 'recheck-outside',
      },
    };

    it('listens to its own flag under its subscriber name', () => {
      const [sub] = postReviewFlagSubscriptions(rig({ ok: true, code: 'x' }).refer);
      expect(sub!.name).toBe('pricing.refer-offer-for-post-review');
      expect(sub!.event.type).toBe('pricing.offer-post-review-flagged.v1');
    });

    it('settles a redelivery that catalog answers duplicate or offer-gone', async () => {
      for (const code of ['post-review.duplicate', 'post-review.offer-gone']) {
        const r = rig({ ok: true, code });
        const [sub] = postReviewFlagSubscriptions(r.refer);
        await expect(
          sub!.handle(event as never, DELIVERY, system as never),
        ).resolves.toBeUndefined();
        expect(r.calls).toHaveLength(1);
      }
    });

    it('throws on a refusal or a failure, so the delivery is retried', async () => {
      const refused = rig({ ok: false, code: 'conflict.retry' });
      const [sub] = postReviewFlagSubscriptions(refused.refer);
      await expect(sub!.handle(event as never, DELIVERY, system as never)).rejects.toThrow(
        'pricing.refer-offer-for-post-review refused: pricing.post-review.refused',
      );
      const down = rig('throw');
      const [other] = postReviewFlagSubscriptions(down.refer);
      await expect(other!.handle(event as never, DELIVERY, system as never)).rejects.toThrow(
        'catalog down',
      );
    });
  });
});
