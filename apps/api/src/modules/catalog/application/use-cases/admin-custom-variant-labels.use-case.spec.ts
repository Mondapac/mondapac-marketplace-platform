import type { CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AccessDeclaration, AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type {
  CustomVariantLabelRow,
  CustomVariantLabelsReader,
} from '../ports/custom-variant-labels.reader';
import { AdminCustomVariantLabels } from './admin-custom-variant-labels.use-case';

// The "Custom variant labels" report in memory, on both Market fixtures. SQL is in
// test/db/catalog-custom-variant-labels.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const T0 = Temporal.Instant.from('2026-11-04T00:00:00Z');
const AFTER = '0197c1f0-0000-7000-8000-000000000001';

describe.each(['AU', 'ZZ'] as const)('custom variant labels report in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const ids = new SequenceIdGenerator(new FixedClock(T0));
  const supported = policy.locales(market).supported;

  const context = (population: 'admin' | 'seller'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: population === 'seller' ? ids.next<'Seller'>() : null,
      }),
    );

  function setup(options: { allow?: boolean; unitFails?: boolean } = {}) {
    const checked: AccessDeclaration[] = [];
    const check: AuthorisationCheck = {
      check: (_c, declaration) => {
        checked.push(declaration);
        return Promise.resolve(
          options.allow === false
            ? { allowed: false, denial: { code: 'access.denied' } }
            : { allowed: true },
        );
      },
    };
    const units: { market: string; options: UnitOfWorkOptions | undefined }[] = [];
    const unitOfWork = {
      run: <T, E>(m: MarketContext, work: () => Promise<Result<T, E>>, o?: UnitOfWorkOptions) => {
        units.push({ market: m.marketId, options: o });
        return options.unitFails === true
          ? Promise.resolve({ ok: false, error: new Error('down') })
          : work();
      },
    } as unknown as UnitOfWork;
    const calls: { market: string; afterId: string | null; limit: number; locales: unknown }[] = [];
    const rows: CustomVariantLabelRow[] = [
      {
        productId: ids.next<'Product'>(),
        productCode: 'MP-004127',
        variantId: ids.next<'Variant'>(),
        variantNo: 2,
        variantCode: 'MP-004127-02',
        differences: [{ locale: supported[0]!, stored: 'Big', built: 'Large' }],
      },
    ];
    const reader: CustomVariantLabelsReader = {
      page: (m, query) => {
        calls.push({ market: m.marketId, ...query });
        return Promise.resolve({ rows, nextAfterId: AFTER });
      },
    };
    const useCase = new AdminCustomVariantLabels(createUseCaseGate(markets, check), {
      unitOfWork,
      customVariantLabelsReader: reader,
      policy,
    });
    return { useCase, checked, units, calls, rows };
  }

  it('declares the permission rule under its own name', () => {
    expect(AdminCustomVariantLabels.access).toEqual({
      name: 'catalog.admin-custom-variant-labels',
      rule: { kind: 'permissions', allOf: ['catalog.product.view'] },
    });
  });

  it('reads nothing when the gate refuses, and refuses a seller session', async () => {
    const refused = setup({ allow: false });
    expect(await refused.useCase.execute(context('admin'), {})).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(refused.units).toEqual([]);

    const seller = setup();
    expect(await seller.useCase.execute(context('seller'), {})).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(seller.units).toEqual([]);
  });

  it('reads one page in a read-only unit with the Market locales and the defaults', async () => {
    const { useCase, units, calls, rows } = setup();

    const result = await useCase.execute(context('admin'), {});

    expect(result).toEqual({ ok: true, value: { items: rows, nextAfterId: AFTER } });
    expect(units).toEqual([{ market: code, options: { readOnly: true } }]);
    expect(calls).toEqual([{ market: code, afterId: null, limit: 50, locales: supported }]);
  });

  it('passes a valid cursor and limit through', async () => {
    const { useCase, calls } = setup();
    await useCase.execute(context('admin'), { afterId: AFTER.toUpperCase(), limit: 100 });
    expect(calls[0]).toMatchObject({ afterId: AFTER, limit: 100 });
  });

  it.each<[Record<string, unknown>, string]>([
    [{ extra: 1 }, 'extra'],
    [{ afterId: 'nope' }, 'afterId'],
    [{ afterId: 5 }, 'afterId'],
    [{ limit: 0 }, 'limit'],
    [{ limit: 101 }, 'limit'],
    [{ limit: 1.5 }, 'limit'],
    [{ limit: '5' }, 'limit'],
  ])('refuses the query %j', async (input, field) => {
    const { useCase, units } = setup();
    const result = await useCase.execute(context('admin'), input);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain(field);
    expect(units).toEqual([]);
  });

  it('answers access.unavailable when the unit fails', async () => {
    const { useCase } = setup({ unitFails: true });
    expect(await useCase.execute(context('admin'), {})).toEqual({
      ok: false,
      error: { code: 'access.unavailable' },
    });
  });
});
