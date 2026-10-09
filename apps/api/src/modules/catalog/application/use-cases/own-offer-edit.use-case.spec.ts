import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, MarketId, Result } from '@mondapac/shared-kernel';
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
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { Offer, type OfferState } from '../../domain/offer';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type { CheckClaimText, ClaimTextVerdict } from '../claim-text/check-claim-text.service';
import { OwnOfferEdit } from './own-offer-edit.use-case';

// `own-offer.edit` in memory (catalog design 4.4, 8.2; slice 7b-1), on both Market fixtures with
// the Market's real configuration. The database behaviour is in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const realPolicy = new ConfigCatalogMarketPolicy(markets);
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-10-09T00:00:00Z');

describe.each(['AU', 'ZZ'] as const)('own-offer.edit in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const locale = realPolicy.locales(market).default;
  const condition = realPolicy.conditions(market)[0]!;
  const sellerId = ids.next<'Seller'>();

  const contextOf = (population: 'admin' | 'seller' | 'customer', owner = sellerId): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: population === 'seller' ? owner : null,
      }),
    );

  const offerState = (overrides: Partial<OfferState> = {}): OfferState => ({
    id: ids.next<'Offer'>(),
    marketId: code as MarketId,
    sellerId,
    productId: ids.next<'Product'>(),
    sellerSku: 'SKU-1',
    conditionCode: condition,
    description: { [locale]: 'A tidy listing' },
    handling: null,
    attestationRecordedAt: null,
    attestationAccountId: null,
    status: 'draft',
    offSaleCauses: [],
    listed: false,
    submittedAt: null,
    firstPublishedAt: null,
    deletedAt: null,
    version: 2,
    createdAt: T0,
    ...overrides,
  });

  function rig(
    options: {
      offer?: OfferState | null;
      eligible?: boolean;
      saveRefusal?: 'offer.sku-taken';
      saveThrows?: Error;
      /** The state a second read of the Offer answers (another edit landed in between). */
      secondRead?: OfferState;
      checkResult?: { ok: false; error: { code: string } };
      verdicts?: (texts: readonly { locale: string; text: string }[]) => ClaimTextVerdict[];
      reserve?:
        | { code: 'request.throttled'; retryAfterSeconds: number }
        | { code: 'access.unavailable' }
        | null;
    } = {},
  ) {
    const state = options.offer === undefined ? offerState() : options.offer;
    const saved: Offer[] = [];
    const checked: { locale: string; text: string }[][] = [];
    const reserved: number[] = [];
    const unitOfWork = {
      run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    let reads = 0;
    const check = {
      execute: (_c: CallContext, texts: readonly { locale: string; text: string }[]) => {
        checked.push([...texts]);
        if (options.checkResult !== undefined) return Promise.resolve(options.checkResult);
        const verdicts =
          options.verdicts?.(texts) ??
          texts.map((item) => ({
            code: 'clean' as const,
            field: 'offer.description' as const,
            ref: null,
            locale: item.locale,
          }));
        return Promise.resolve({ ok: true as const, value: verdicts });
      },
    } as unknown as CheckClaimText;
    const useCase = new OwnOfferEdit(gate, {
      unitOfWork,
      offers: {
        add: () => Promise.reject(new Error('unused')),
        findById: () => {
          reads += 1;
          const current =
            reads > 1 && options.secondRead !== undefined ? options.secondRead : state;
          return Promise.resolve(current === null ? null : Offer.restore(current));
        },
        save: (_m, offer) => {
          if (options.saveThrows !== undefined) return Promise.reject(options.saveThrows);
          if (options.saveRefusal !== undefined) return Promise.resolve(options.saveRefusal);
          saved.push(offer);
          return Promise.resolve(null);
        },
      },
      eligibility: { isEligible: () => Promise.resolve(options.eligible ?? true) },
      check,
      save: {
        reserveSaves: () => {
          reserved.push(1);
          return Promise.resolve(options.reserve ?? null);
        },
      },
      policy: realPolicy,
      clock,
    });
    return { useCase, state, saved, checked, reserved };
  }

  const form = (offerId: Id<'Offer'>, extra: Record<string, unknown> = {}) => ({
    offerId,
    sellerSku: 'SKU-2',
    conditionCode: condition,
    description: { [locale]: 'A tidy listing' },
    ...extra,
  });

  it('stores the changed fields for the actor’s own draft Offer and reports them', async () => {
    const r = rig();
    const outcome = await r.useCase.execute(contextOf('seller'), form(r.state!.id));
    expect(outcome).toEqual({ ok: true, value: { changedFields: ['sellerSku'] } });
    expect(r.saved).toHaveLength(1);
    expect(r.saved[0]!.state).toMatchObject({ sellerSku: 'SKU-2', version: 3, sellerId });
    expect(r.saved[0]!.pendingHistory).toMatchObject({
      changeKind: 'edited',
      changedFields: ['sellerSku'],
    });
    expect(r.reserved).toHaveLength(1);
  });

  it('checks only the texts that changed, and not an empty text', async () => {
    const r = rig({
      offer: offerState({ description: { [locale]: 'same', other: 'old' } }),
    });
    const supported = realPolicy.locales(market).supported;
    const second = supported.find((l) => l !== locale);
    const description: Record<string, string> = { [locale]: 'same' };
    if (second !== undefined) description[second] = 'brand new';
    const outcome = await r.useCase.execute(
      contextOf('seller'),
      form(r.state!.id, { description }),
    );
    expect(outcome.ok).toBe(true);
    const texts = r.checked.flat().map((item) => item.text);
    expect(texts).not.toContain('same');
    if (second !== undefined) expect(texts).toEqual(['brand new']);
    const empty = await rig().useCase.execute(
      contextOf('seller'),
      form(rig().state!.id, { description: { [locale]: '' } }),
    );
    expect(empty.ok).toBe(true);
  });

  it('refuses the whole edit when a changed text holds a claim, and stores nothing', async () => {
    const r = rig({
      verdicts: (texts) =>
        texts.map((item) => ({
          code: 'claim-text.found' as const,
          field: 'offer.description' as const,
          ref: null,
          locale: item.locale,
          hits: [],
        })),
    });
    const outcome = await r.useCase.execute(
      contextOf('seller'),
      form(r.state!.id, { description: { [locale]: 'certified' } }),
    );
    expect(outcome).toMatchObject({ ok: false, error: { code: 'claim-text.refused' } });
    expect(r.saved).toHaveLength(0);
  });

  it('answers a byte-identical offer.not-found for an unknown, another seller’s and deleted Offer', async () => {
    const other = ids.next<'Seller'>();
    const cases = [
      rig({ offer: null }),
      rig({ offer: offerState({ sellerId: other }) }),
      rig({ offer: offerState({ status: 'deleted', deletedAt: T0 }) }),
    ];
    const answers = [];
    for (const r of cases) {
      const id = r.state?.id ?? ids.next<'Offer'>();
      answers.push(JSON.stringify(await r.useCase.execute(contextOf('seller'), form(id))));
      expect(r.saved).toHaveLength(0);
      expect(r.checked).toHaveLength(0);
    }
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).toBe(JSON.stringify({ ok: false, error: { code: 'offer.not-found' } }));
  });

  it('returns a waiting Offer to draft', async () => {
    const r = rig({
      offer: offerState({ status: 'pending-first-publish', submittedAt: T0, handling: 'FRESH' }),
    });
    const outcome = await r.useCase.execute(contextOf('seller'), form(r.state!.id));
    expect(outcome.ok).toBe(true);
    expect(r.saved[0]!.state).toMatchObject({ status: 'draft', submittedAt: null });
  });

  it('refuses a published Offer as not editable', async () => {
    const r = rig({
      offer: offerState({ status: 'published', firstPublishedAt: T0, handling: 'FRESH' }),
    });
    const outcome = await r.useCase.execute(contextOf('seller'), form(r.state!.id));
    expect(outcome).toEqual({ ok: false, error: { code: 'offer.not-editable' } });
    expect(r.saved).toHaveLength(0);
  });

  it.each(['sellerId', 'handling', 'attestation', 'tags', 'status', 'productId'])(
    'refuses a request that names %s',
    async (key) => {
      const r = rig();
      const outcome = await r.useCase.execute(
        contextOf('seller'),
        form(r.state!.id, { [key]: 'x' }),
      );
      expect(outcome).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: key, code: 'unknown' }] },
      });
      expect(r.saved).toHaveLength(0);
      expect(r.reserved).toHaveLength(0);
    },
  );

  it('refuses a malformed offer id, an unknown condition and an unsupported locale', async () => {
    const r = rig();
    const ctx = contextOf('seller');
    expect(await r.useCase.execute(ctx, form(r.state!.id, { offerId: 'nope' }))).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'offerId', code: 'format' }] },
    });
    expect(
      await r.useCase.execute(ctx, form(r.state!.id, { conditionCode: 'refurbished-x' })),
    ).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'conditionCode', code: 'unknown' }] },
    });
    expect(
      await r.useCase.execute(ctx, form(r.state!.id, { description: { 'xx-XX': 'text' } })),
    ).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'description', code: 'locale' }] },
    });
    expect(r.saved).toHaveLength(0);
  });

  it('refuses an admin and a customer, and a seller that may not sell', async () => {
    const r = rig();
    for (const population of ['admin', 'customer'] as const) {
      expect(await r.useCase.execute(contextOf(population), form(r.state!.id))).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    }
    const ineligible = rig({ eligible: false });
    expect(
      await ineligible.useCase.execute(contextOf('seller'), form(ineligible.state!.id)),
    ).toEqual({
      ok: false,
      error: { code: 'seller.not-eligible' },
    });
    expect(r.saved).toHaveLength(0);
  });

  it('answers a spent budget before any read or check', async () => {
    const r = rig({ reserve: { code: 'request.throttled', retryAfterSeconds: 7 } });
    const outcome = await r.useCase.execute(contextOf('seller'), form(r.state!.id));
    expect(outcome).toEqual({
      ok: false,
      error: { code: 'request.throttled', retryAfterSeconds: 7 },
    });
    expect(r.checked).toHaveLength(0);
    expect(r.saved).toHaveLength(0);
  });

  it('answers a taken SKU and a lost race', async () => {
    const taken = rig({ saveRefusal: 'offer.sku-taken' });
    expect(await taken.useCase.execute(contextOf('seller'), form(taken.state!.id))).toEqual({
      ok: false,
      error: { code: 'offer.sku-taken' },
    });
    const stale = rig({ saveThrows: new StaleAggregateError('offer', 'x') });
    expect(await stale.useCase.execute(contextOf('seller'), form(stale.state!.id))).toEqual({
      ok: false,
      error: { code: 'conflict.stale' },
    });
    const broken = rig({ saveThrows: new Error('db down') });
    await expect(
      broken.useCase.execute(contextOf('seller'), form(broken.state!.id)),
    ).rejects.toThrow('db down');
  });

  it('returns a changes-needed Offer to draft', async () => {
    const r = rig({
      offer: offerState({ status: 'changes-needed', submittedAt: T0, handling: 'FRESH' }),
    });
    const outcome = await r.useCase.execute(contextOf('seller'), form(r.state!.id));
    expect(outcome.ok).toBe(true);
    expect(r.saved[0]!.state).toMatchObject({ status: 'draft', submittedAt: null });
  });

  it('reports no changed field when a waiting Offer is edited with an unchanged form', async () => {
    const r = rig({
      offer: offerState({ status: 'pending-first-publish', submittedAt: T0, handling: 'FRESH' }),
    });
    const outcome = await r.useCase.execute(
      contextOf('seller'),
      form(r.state!.id, { sellerSku: r.state!.sellerSku }),
    );
    expect(outcome).toEqual({ ok: true, value: { changedFields: [] } });
    expect(r.saved).toHaveLength(1);
    expect(r.saved[0]!.state.status).toBe('draft');
  });

  it('writes nothing when another edit landed between the claim check and the write', async () => {
    const r = rig({ secondRead: offerState({ version: 3 }) });
    const outcome = await r.useCase.execute(
      contextOf('seller'),
      form(r.state!.id, { description: { [locale]: 'a new text' } }),
    );
    expect(outcome).toEqual({ ok: false, error: { code: 'conflict.stale' } });
    expect(r.saved).toHaveLength(0);
  });

  it.each([
    ['validation.failed', 'validation.failed'],
    ['access.denied', 'access.denied'],
    ['access.unavailable', 'access.unavailable'],
    ['claim-text.check-unavailable', 'access.unavailable'],
  ])('maps a claim-check failure %s to %s and stores nothing', async (from, to) => {
    const r = rig({ checkResult: { ok: false, error: { code: from } } });
    const outcome = await r.useCase.execute(
      contextOf('seller'),
      form(r.state!.id, { description: { [locale]: 'a new text' } }),
    );
    expect(outcome).toMatchObject({ ok: false, error: { code: to } });
    expect(r.saved).toHaveLength(0);
  });
});
