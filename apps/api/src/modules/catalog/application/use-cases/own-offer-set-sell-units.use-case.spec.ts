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
import { RecordingOutbox } from '../../../../../test/support/catalog-tag-fakes';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { Offer, type OfferState } from '../../domain/offer';
import type { SellUnitState } from '../../domain/offer-sell-unit';
import type { OfferSellUnitRepository } from '../ports/offer-sell-unit.repository';
import { OwnOfferSetSellUnits } from './own-offer-set-sell-units.use-case';

// `own-offer.set-sell-units` in memory (variants V5), on both Market fixtures. The database
// behaviour (uniques, triggers, grants) is in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-11-05T00:00:00Z');

describe.each(['AU', 'ZZ'] as const)('own-offer.set-sell-units in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const sellerId = ids.next<'Seller'>();
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
    productId: ids.next<'Product'>(),
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

  function rig(
    options: {
      offer?: OfferState | null;
      eligible?: boolean;
      units?: (SellUnitState & { variantNo: number })[];
      refusal?: 'offer.sku-taken';
    } = {},
  ) {
    const state = options.offer === undefined ? offerState() : options.offer;
    const units = options.units ?? [
      { variantId: v1, variantNo: 1, variantSku: null, selling: true },
      { variantId: v2, variantNo: 2, variantSku: null, selling: true },
    ];
    const outbox = new RecordingOutbox();
    const writes: SellUnitState[][] = [];
    const sellUnits: OfferSellUnitRepository = {
      unitsOf: () => Promise.resolve(units),
      save: (_m, _o, states) => {
        if (options.refusal !== undefined) return Promise.resolve({ refusal: options.refusal });
        writes.push([...states]);
        return Promise.resolve({
          refusal: null,
          stored: states.map((s) => ({
            variantId: s.variantId as never,
            rowId: ids.next(),
            version: 1,
          })),
        });
      },
    };
    const unitOfWork = {
      run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const useCase = new OwnOfferSetSellUnits(gate, {
      unitOfWork,
      offers: {
        findById: () => Promise.resolve(state === null ? null : Offer.restore(state)),
      } as never,
      sellUnits,
      eligibility: { isEligible: () => Promise.resolve(options.eligible ?? true) },
      outbox,
      clock,
    });
    return { useCase, state, outbox, writes };
  }

  it('turns a unit off sale, stores only that unit and emits one event', async () => {
    const r = rig();
    const out = await r.useCase.execute(contextOf('seller'), {
      offerId: r.state!.id,
      units: [{ variantId: v2, selling: false }],
    });
    expect(out).toEqual({ ok: true, value: { changedVariantIds: [v2] } });
    expect(r.writes).toEqual([[{ variantId: v2, variantSku: null, selling: false }]]);
    expect(r.outbox.types).toEqual(['catalog.offer-sell-unit-changed.v1']);
    expect(r.outbox.appended[0]!.payload).toEqual({
      offerId: r.state!.id,
      variantId: v2,
      selling: false,
    });
  });

  it('sets a SKU without an event (the switch did not change)', async () => {
    const r = rig();
    const out = await r.useCase.execute(contextOf('seller'), {
      offerId: r.state!.id,
      units: [{ variantId: v1, variantSku: 'TEE-RED' }],
    });
    expect(out).toEqual({ ok: true, value: { changedVariantIds: [v1] } });
    expect(r.outbox.appended).toHaveLength(0);
  });

  it('stores nothing when the request matches the stored state', async () => {
    const r = rig();
    const out = await r.useCase.execute(contextOf('seller'), {
      offerId: r.state!.id,
      units: [{ variantId: v1, selling: true }],
    });
    expect(out).toEqual({ ok: true, value: { changedVariantIds: [] } });
    expect(r.writes).toHaveLength(0);
  });

  it('refuses to take the last selling unit off sale', async () => {
    const r = rig();
    const out = await r.useCase.execute(contextOf('seller'), {
      offerId: r.state!.id,
      units: [
        { variantId: v1, selling: false },
        { variantId: v2, selling: false },
      ],
    });
    expect(out).toEqual({ ok: false, error: { code: 'offer.none-selling' } });
    expect(r.writes).toHaveLength(0);
  });

  it('answers offer.sku-taken when the store refuses the SKU', async () => {
    const r = rig({ refusal: 'offer.sku-taken' });
    const out = await r.useCase.execute(contextOf('seller'), {
      offerId: r.state!.id,
      units: [{ variantId: v1, variantSku: 'SKU-1' }],
    });
    expect(out).toEqual({ ok: false, error: { code: 'offer.sku-taken' } });
    expect(r.outbox.appended).toHaveLength(0);
  });

  it.each([
    ['another seller’s Offer', { sellerId: ids.next<'Seller'>() }],
    ['a deleted Offer', { status: 'deleted' as const, deletedAt: T0, listed: false }],
  ])('answers offer.not-found for %s', async (_n, over) => {
    const r = rig({ offer: offerState(over) });
    const out = await r.useCase.execute(contextOf('seller'), {
      offerId: r.state!.id,
      units: [{ variantId: v1, selling: false }],
    });
    expect(out).toEqual({ ok: false, error: { code: 'offer.not-found' } });
  });

  it('answers offer.not-found for an unknown Offer and refuses a non-seller', async () => {
    const r = rig({ offer: null });
    expect(
      await r.useCase.execute(contextOf('seller'), {
        offerId: ids.next<'Offer'>(),
        units: [{ variantId: v1, selling: false }],
      }),
    ).toEqual({ ok: false, error: { code: 'offer.not-found' } });
    const denied = await r.useCase.execute(contextOf('admin'), {
      offerId: ids.next<'Offer'>(),
      units: [{ variantId: v1, selling: false }],
    });
    expect(denied).toMatchObject({ ok: false, error: { code: 'access.denied' } });
  });

  it('refuses a seller who may not sell', async () => {
    const r = rig({ eligible: false });
    expect(
      await r.useCase.execute(contextOf('seller'), {
        offerId: r.state!.id,
        units: [{ variantId: v1, selling: false }],
      }),
    ).toEqual({ ok: false, error: { code: 'seller.not-eligible' } });
  });

  it('refuses an unknown variant, an unknown key and an empty change', async () => {
    const r = rig();
    const run = (units: unknown) =>
      r.useCase.execute(contextOf('seller'), { offerId: r.state!.id, units: units as never });
    expect(await run([{ variantId: ids.next<'Variant'>(), selling: false }])).toMatchObject({
      ok: false,
      error: { code: 'validation.failed' },
    });
    expect(await run([{ variantId: v1, price: 1 }])).toMatchObject({
      ok: false,
      error: { code: 'validation.failed', fields: [{ code: 'unknown' }] },
    });
    expect(await run([{ variantId: v1 }])).toMatchObject({
      ok: false,
      error: { code: 'validation.failed' },
    });
    expect(await run([])).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    expect(await run([{ variantId: v1, variantSku: 'a b' }])).toMatchObject({
      ok: false,
      error: { code: 'validation.failed' },
    });
  });
});
