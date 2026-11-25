import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { expectSystemOnly } from '../../../../../test/support/system-only-denial';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { AccessReviewer, AdminKeyHolders } from '../ports/access-reviewers';
import { AccessReviewersUnavailableError } from '../ports/access-reviewers';
import {
  MAX_OFFER_REVIEW_ALERT_RECIPIENTS,
  OFFER_REVIEW_ALERT_KEY,
  OfferReviewAlertRecipients,
} from './offer-review-alert-recipients.use-case';

// The recipients of the Offer review queue backlog mail (slice 8b) on both Market fixtures: the
// system actor only, the fixed approve key (never caller input), the Market of the context, the
// cap, and a failed read that answers unavailable, never a guess. The rule itself (active,
// verified, active second factor, the key held) is covered in reviewer-notice.spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

const holder = (n: number): AccessReviewer => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return { accountId: parsed.value as Id<'Account'>, email: `admin.${n}@admin.test` };
};

describe.each([['AU'], ['ZZ']] as const)('offerReviewAlertRecipients in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const system = testCallContext(market, 'system', 'alert-recipients-0001');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });

  let calls: { market: string; key: string }[];
  let answer: (market: MarketContext) => Promise<readonly AccessReviewer[]>;
  const keyHolders: AdminKeyHolders = {
    holdersOf: (asked, key) => {
      calls.push({ market: asked.marketId, key });
      return answer(asked);
    },
  };
  const build = () => new OfferReviewAlertRecipients(gate, { keyHolders });

  beforeEach(() => {
    calls = [];
    answer = () => Promise.resolve([holder(1), holder(2)]);
  });
  afterEach(() => jest.restoreAllMocks());

  it('declares rule system under its own name', () => {
    expect(OfferReviewAlertRecipients.access).toEqual({
      name: 'identity.offer-review-alert-recipients',
      rule: { kind: 'system' },
    });
  });

  it('answers the addresses of the holders of the Offer approve key in the context Market', async () => {
    expect(await build().execute(system, {})).toEqual(
      ok(['admin.1@admin.test', 'admin.2@admin.test']),
    );
    expect(calls).toEqual([{ market: market.marketId, key: 'catalog.product.approve' }]);
    expect(OFFER_REVIEW_ALERT_KEY).toBe('catalog.product.approve');
  });

  it('takes no key from input: extra input never changes the key asked', async () => {
    await build().execute(system, { key: 'identity.seller-access.approve' } as never);
    expect(calls.map((c) => c.key)).toEqual([OFFER_REVIEW_ALERT_KEY]);
  });

  it('is for the system actor only, and reads nothing for another actor', async () => {
    await expectSystemOnly(code, (context) => build().execute(context, {}));
    expect(calls).toEqual([]);
  });

  it(`caps the answer at ${MAX_OFFER_REVIEW_ALERT_RECIPIENTS}, with an error log of the count only`, async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const many = Array.from({ length: MAX_OFFER_REVIEW_ALERT_RECIPIENTS + 5 }, (_, n) =>
      holder(n + 1),
    );
    answer = () => Promise.resolve(many);
    const result = await build().execute(system, {});
    expect(result.ok && result.value).toEqual(
      many.slice(0, MAX_OFFER_REVIEW_ALERT_RECIPIENTS).map((h) => h.email),
    );
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: 'identity.offer-review-alert-recipients.capped',
        count: MAX_OFFER_REVIEW_ALERT_RECIPIENTS + 5,
      }),
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain('@admin.test');
  });

  it('answers access.unavailable when the read fails, never a guess', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    answer = () => Promise.reject(new AccessReviewersUnavailableError());
    expect(await build().execute(system, {})).toEqual(err({ code: 'access.unavailable' }));
  });

  it('answers an empty list when no admin qualifies', async () => {
    answer = () => Promise.resolve([]);
    expect(await build().execute(system, {})).toEqual(ok([]));
  });
});
