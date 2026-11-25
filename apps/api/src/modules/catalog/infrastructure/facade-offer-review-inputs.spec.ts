import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { Id } from '@mondapac/shared-kernel';
import type { OfferReviewPolicySettings, SettingsFacade } from '../../settings';
import {
  SAFE_OFFER_REVIEW_SETTINGS,
  type OfferReviewInputs,
} from '../application/ports/offer-review';
import { TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { FacadeOfferReviewInputs } from './facade-offer-review-inputs';

const POLICY: OfferReviewPolicySettings = {
  mode: 'risk-based',
  probationOffers: 10,
  referenceSellers: 3,
  priceBandPercent: 50,
  samplingPercent: 5,
  certificateBadges: 'review',
};

function inputsWith(answer: () => Promise<unknown>): OfferReviewInputs {
  const facade = { offerReviewPolicy: answer } as unknown as SettingsFacade;
  return new FacadeOfferReviewInputs(facade);
}

describe.each(TEST_MARKET_IDS)('FacadeOfferReviewInputs in market %s', (code) => {
  const context = testCallContext(testMarketContext(code, 'default'), 'anonymous');

  it('passes the stored mode and badge setting through', async () => {
    for (const mode of ['all', 'risk-based', 'off'] as const) {
      const inputs = inputsWith(() =>
        Promise.resolve({ ...POLICY, mode, certificateBadges: 'automatic' }),
      );
      expect(await inputs.settings(context)).toEqual({ mode, certificateBadges: 'automatic' });
    }
  });

  it('answers review everything when the facade throws (fail closed)', async () => {
    const inputs = inputsWith(() => Promise.reject(new Error('settings down')));
    expect(await inputs.settings(context)).toEqual(SAFE_OFFER_REVIEW_SETTINGS);
    expect(SAFE_OFFER_REVIEW_SETTINGS).toEqual({ mode: 'all', certificateBadges: 'review' });
  });

  it('reads an unknown mode as all and an unknown badge setting as review', async () => {
    const inputs = inputsWith(() =>
      Promise.resolve({ ...POLICY, mode: 'bogus', certificateBadges: 'weird' }),
    );
    expect(await inputs.settings(context)).toEqual({ mode: 'all', certificateBadges: 'review' });
  });

  it('counts every seller as in probation until the counter exists, every other fact off', async () => {
    const inputs = inputsWith(() => Promise.resolve(POLICY));
    expect(
      await inputs.facts(context, {
        sellerId: 's' as Id<'Seller'>,
        productId: 'p' as Id<'Product'>,
      }),
    ).toEqual({
      emergencyStop: false,
      probation: true,
      fullReview: false,
      sensitiveCategory: false,
    });
  });
});
