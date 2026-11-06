import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext, MarketId, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import type { OfferSellUnits, SellUnitLabel } from '../../contracts/catalog.facade';
import { Offer, type OfferState } from '../../domain/offer';
import { OwnOfferReadSellUnits } from './own-offer-read-sell-units.use-case';

// `own-offer.read-sell-units` in memory (variants V5), on both Market fixtures. The readers'
// database behaviour is in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-11-05T00:00:00Z');

describe.each(['AU', 'ZZ'] as const)('own-offer.read-sell-units in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const ids = new SequenceIdGenerator(new FixedClock(T0));
  const sellerId = ids.next<'Seller'>();
  const productId = ids.next<'Product'>();
  const v1 = ids.next<'Variant'>();
  const v2 = ids.next<'Variant'>();

  const contextOf = (population: 'admin' | 'seller'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: population === 'seller' ? sellerId : null,
      }),
    );

  const offerState = (overrides: Partial<OfferState> = {}): OfferState => ({
    id: ids.next<'Offer'>(),
    marketId: code as MarketId,
    sellerId,
    productId,
    sellerSku: 'SKU-1',
    conditionCode: 'new',
    description: {},
    handling: 'SEALED_ORIGINAL',
    attestationRecordedAt: null,
    attestationAccountId: null,
    status: 'published',
    offSaleCauses: [],
    listed: true,
    submittedAt: T0,
    firstPublishedAt: T0,
    deletedAt: null,
    version: 2,
    createdAt: T0,
    ...overrides,
  });

  function rig(offer: OfferState | null = offerState(), locale = 'en') {
    const runs: (UnitOfWorkOptions | undefined)[] = [];
    const asked: string[] = [];
    const unitOfWork = {
      run: async <T, E>(
        _m: MarketContext,
        work: () => Promise<Result<T, E>>,
        options?: UnitOfWorkOptions,
      ) => {
        runs.push(options);
        return work();
      },
    } as unknown as UnitOfWork;
    const useCase = new OwnOfferReadSellUnits(gate, {
      unitOfWork,
      offers: {
        findById: () => Promise.resolve(offer === null ? null : Offer.restore(offer)),
      } as never,
      reader: {
        read: (_m, offerIds) =>
          Promise.resolve(
            new Map<(typeof offerIds)[number], OfferSellUnits>([
              [
                offerIds[0]!,
                {
                  sellerId,
                  productId,
                  status: 'published',
                  listed: true,
                  // The reader returns creation order; the answer is ordered by number.
                  sellUnits: [
                    { variantId: v2, state: 'proposed', selling: false, variantSku: 'PK-2' },
                    { variantId: v1, state: 'published', selling: true, variantSku: null },
                  ],
                },
              ],
            ]),
          ),
      },
      labelsReader: {
        read: (_m, keys, askedLocale) => {
          asked.push(askedLocale);
          return Promise.resolve(
            new Map<string, SellUnitLabel>(
              keys
                .filter((key) => key.variantId === v1)
                .map((key) => [
                  `${key.offerId}:${key.variantId}`,
                  { productName: 'Rice', variantLabel: 'Small' },
                ]),
            ),
          );
        },
      },
      productSellUnitFacts: {
        read: () =>
          Promise.resolve({
            scope: 'PLATFORM' as const,
            productCode: 'MP-000123',
            variants: [
              { variantId: v1, variantNo: 1 },
              { variantId: v2, variantNo: 12 },
            ],
          }),
      },
      policy: {
        locales: () => ({ default: locale, supported: [locale] }),
      } as never,
    });
    return { useCase, offer, runs, asked };
  }

  it('reads the units ordered by number, in one read-only unit, with the default locale', async () => {
    const r = rig();
    const out = await r.useCase.execute(contextOf('seller'), { offerId: r.offer!.id });
    expect(out).toEqual({
      ok: true,
      value: {
        productScope: 'PLATFORM',
        sellerSku: 'SKU-1',
        units: [
          {
            variantId: v1,
            variantNo: 1,
            variantCode: 'MP-000123-01',
            state: 'published',
            label: 'Small',
            selling: true,
            variantSku: null,
          },
          {
            variantId: v2,
            variantNo: 12,
            variantCode: 'MP-000123-12',
            state: 'proposed',
            label: null,
            selling: false,
            variantSku: 'PK-2',
          },
        ],
      },
    });
    expect(r.runs).toEqual([{ readOnly: true }]);
    expect(r.asked).toEqual(['en']);
  });

  it('answers another seller’s, a deleted and an unknown Offer with one byte-identical refusal', async () => {
    const answers = await Promise.all(
      [
        null,
        offerState({ sellerId: ids.next<'Seller'>() }),
        offerState({ status: 'deleted', deletedAt: T0 }),
      ].map((offer) => {
        const r = rig(offer);
        return r.useCase.execute(contextOf('seller'), { offerId: r.offer?.id ?? ids.next() });
      }),
    );
    for (const answer of answers)
      expect(answer).toEqual({ ok: false, error: { code: 'offer.not-found' } });
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
  });

  it('refuses an admin actor and a malformed id', async () => {
    const r = rig();
    expect(await r.useCase.execute(contextOf('admin'), { offerId: r.offer!.id })).toMatchObject({
      ok: false,
    });
    expect(await r.useCase.execute(contextOf('seller'), { offerId: 'nope' })).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'offerId', code: 'format' }] },
    });
  });
});
