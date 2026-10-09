import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
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
import type { SaveDraft } from '../working-copy/save-draft.service';
import { OwnProductSaveDraft } from './own-product-save-draft.use-case';

// `own-product.save-draft` in memory (catalog design 8.2): who may call it and how the request is
// parsed. The claim-text control, the ownership check and the limit are SaveDraft's and
// SaveWorkingCopy's own specs and the database spec.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };

describe.each(['AU', 'ZZ'])('own-product.save-draft in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const clock = new FixedClock(Temporal.Instant.from('2026-10-09T00:00:00Z'));
  const ids = new SequenceIdGenerator(clock);
  const seller = ids.next<'Seller'>();
  const productId = ids.next<'Product'>();

  const contextOf = (population: 'admin' | 'seller' | 'customer'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: population === 'seller' ? seller : null,
      }),
    );

  function rig(eligible = true) {
    const calls: unknown[] = [];
    const saveDraft = {
      execute: (_context: CallContext, input: unknown) => {
        calls.push(input);
        return Promise.resolve({ ok: true as const, value: { variantIds: [], refusedFields: [] } });
      },
    } as unknown as SaveDraft;
    const useCase = new OwnProductSaveDraft(createUseCaseGate(markets, admitAll), {
      saveDraft,
      eligibility: { isEligible: () => Promise.resolve(eligible) },
    });
    return { useCase, calls };
  }
  const request = (extra: object = {}) => ({
    productId,
    content: { texts: {} },
    variantIds: [],
    ...extra,
  });

  it('passes a parsed request to the draft save for a seller who may sell', async () => {
    const { useCase, calls } = rig();
    const saved = await useCase.execute(contextOf('seller'), request());
    expect(saved.ok).toBe(true);
    expect(calls).toEqual([{ productId, content: { texts: {} }, variantIds: [] }]);
  });

  it('refuses an admin, a customer and a seller who may not sell, saving nothing', async () => {
    const { useCase, calls } = rig();
    for (const population of ['admin', 'customer'] as const) {
      expect(await useCase.execute(contextOf(population), request())).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    }
    const notEligible = rig(false);
    expect(await notEligible.useCase.execute(contextOf('seller'), request())).toEqual({
      ok: false,
      error: { code: 'seller.not-eligible' },
    });
    expect(calls).toHaveLength(0);
    expect(notEligible.calls).toHaveLength(0);
  });

  it('refuses a malformed product id, variant id and variant list', async () => {
    const { useCase, calls } = rig();
    const fields = async (input: object) => {
      const result = await useCase.execute(contextOf('seller'), input as never);
      return result.ok ? null : result.error;
    };
    expect(await fields(request({ productId: 'x' }))).toEqual({
      code: 'validation.failed',
      fields: [{ path: 'productId', code: 'format' }],
    });
    expect(await fields(request({ variantIds: ['x'] }))).toEqual({
      code: 'validation.failed',
      fields: [{ path: 'variantIds[0]', code: 'format' }],
    });
    expect(await fields(request({ variantIds: 'x' }))).toEqual({
      code: 'validation.failed',
      fields: [{ path: 'variantIds', code: 'type' }],
    });
    expect(calls).toHaveLength(0);
  });
});
