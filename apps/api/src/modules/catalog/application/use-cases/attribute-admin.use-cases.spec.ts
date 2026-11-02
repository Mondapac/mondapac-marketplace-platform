import type { CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  MemoryAttributeAdminReader,
  definitionRecord,
  featureSetRecord,
  revisionRecord,
} from '../../../../../test/support/catalog-attribute-admin-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import { AttributeAdminGet } from './attribute-admin-get.use-case';
import { AttributeAdminList } from './attribute-admin-list.use-case';
import { FeatureSetAdminGet } from './feature-set-admin-get.use-case';
import { FeatureSetAdminList } from './feature-set-admin-list.use-case';

// The four admin reads of attributes and feature sets in memory (attributes plan, package A1), on
// both Market fixtures: the access rule, the admin population, the closed query, the filters and
// the page, the counts, the history and the Market boundary. The SQL is in
// test/db/catalog-attribute-admin.db-spec.ts; the routes in test/catalog-attribute-admin.e2e.spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const ID = (n: number) => `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

describe.each(['AU', 'ZZ'] as const)('admin attribute reads in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const other: MarketContext = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const locales = policy.locales(market);
  const locale = locales.default;
  const second = locales.supported.find((l) => l !== locale) ?? null;

  const context = (
    population: 'admin' | 'seller' = 'admin',
    target: MarketContext = market,
  ): CallContext =>
    testCallContext(
      target,
      testAuthenticatedActor(target, {
        population,
        accountId: ID(0xa1) as never,
        sessionId: ID(0xa2) as never,
        sellerId: population === 'seller' ? (ID(0xa3) as never) : null,
      }),
    );

  let reader: MemoryAttributeAdminReader;
  let units: { market: string; options: UnitOfWorkOptions | undefined }[];
  let allow: boolean;
  let unitFails: boolean;

  const check: AuthorisationCheck = {
    check: () =>
      Promise.resolve(
        allow ? { allowed: true } : { allowed: false, denial: { code: 'access.denied' } },
      ),
  };
  const unitOfWork = {
    run: <T, E>(m: MarketContext, work: () => Promise<Result<T, E>>, o?: UnitOfWorkOptions) => {
      units.push({ market: m.marketId, options: o });
      return unitFails ? Promise.resolve({ ok: false, error: new Error('down') }) : work();
    },
  } as unknown as UnitOfWork;
  const gate = () => createUseCaseGate(markets, check);
  const list = () =>
    new AttributeAdminList(gate(), { unitOfWork, attributeAdminReader: reader, policy });
  const get = () =>
    new AttributeAdminGet(gate(), { unitOfWork, attributeAdminReader: reader, policy });
  const sets = () => new FeatureSetAdminList(gate(), { unitOfWork, attributeAdminReader: reader });
  const set = () =>
    new FeatureSetAdminGet(gate(), { unitOfWork, attributeAdminReader: reader, policy });

  const names = (english: string, other?: string) =>
    other === undefined || second === null
      ? { [locale]: english }
      : { [locale]: english, [second]: other };

  beforeEach(() => {
    reader = new MemoryAttributeAdminReader();
    units = [];
    allow = true;
    unitFails = false;
    reader.seedDefinition(
      market.marketId,
      definitionRecord(ID(1), 'brand', { names: names('Brand', 'Brand-x') }),
    );
    reader.seedDefinition(
      market.marketId,
      definitionRecord(ID(2), 'pack-size', {
        dataType: 'select',
        isVariantOption: true,
        names: names('Pack size', 'Pack-x'),
        values: [
          { code: 'g500', labels: { [locale]: '500 g' }, active: true, position: 1 },
          { code: 'g250', labels: names('250 g', '250-x'), active: true, position: 0 },
        ],
      }),
      [
        revisionRecord(ID(0x21), 1, {
          names: { [locale]: 'Pack' },
          options: [{ code: 'g250', labels: { [locale]: '250 g' }, active: true, position: 0 }],
        }),
        revisionRecord(ID(0x22), 2, {
          names: names('Pack size', 'Pack-x'),
          authorKind: 'admin',
          authorAccountId: ID(0xad) as never,
          options: [
            { code: 'g250', labels: names('250 g', '250-x'), active: true, position: 0 },
            { code: 'g500', labels: { [locale]: '500 g' }, active: true, position: 1 },
          ],
        }),
      ],
    );
    reader.seedDefinition(
      market.marketId,
      definitionRecord(ID(3), 'storage', {
        dataType: 'long-text',
        status: 'archived',
        material: true,
        names: { [locale]: 'Storage' },
      }),
    );
    reader.seedFeatureSet(
      market.marketId,
      featureSetRecord(ID(10), 'default', [
        {
          groupCode: 'general',
          attributes: [
            { code: 'brand', required: true, isVariantOption: false },
            { code: 'gone', required: false, isVariantOption: false },
          ],
        },
        {
          groupCode: 'pack',
          attributes: [{ code: 'pack-size', required: false, isVariantOption: true }],
        },
      ]),
    );
    reader.seedFeatureSet(
      market.marketId,
      featureSetRecord(ID(11), 'rice', [
        {
          groupCode: 'core',
          attributes: [{ code: 'brand', required: false, isVariantOption: false }],
        },
      ]),
    );
    reader.counts.set(`${market.marketId}:brand`, 7);
    reader.counts.set(`${market.marketId}:pack-size`, 4);
    reader.optionCounts.set(`${market.marketId}:pack-size:g250`, 3);
    reader.featureSetCounts.set(`${market.marketId}:${ID(10)}`, 9);
    // The other Market's canary: never seen from this one.
    reader.seedDefinition(other.marketId, definitionRecord(ID(90), 'canary'));
  });

  it('declares the view key on all four reads', () => {
    for (const type of [
      AttributeAdminList,
      AttributeAdminGet,
      FeatureSetAdminList,
      FeatureSetAdminGet,
    ]) {
      expect(type.access.rule).toEqual({ kind: 'permissions', allOf: ['catalog.attribute.view'] });
    }
    expect(
      [AttributeAdminList, AttributeAdminGet, FeatureSetAdminList, FeatureSetAdminGet].map(
        (type) => type.access.name,
      ),
    ).toEqual([
      'catalog.attribute-admin-list',
      'catalog.attribute-admin-get',
      'catalog.feature-set-admin-list',
      'catalog.feature-set-admin-get',
    ]);
  });

  it('refuses without the key, and a seller even with it, before any unit', async () => {
    allow = false;
    await expect(list().execute(context(), {})).resolves.toMatchObject({
      ok: false,
      error: { code: 'access.denied' },
    });
    allow = true;
    for (const run of [
      list().execute(context('seller'), {}),
      get().execute(context('seller'), { attributeId: ID(1) }),
      sets().execute(context('seller'), {}),
      set().execute(context('seller'), { featureSetId: ID(10) }),
    ]) {
      await expect(run).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
    }
    expect(units).toEqual([]);
  });

  it('lists by code with counts, uses and missing locales, in one read-only unit', async () => {
    const result = await list().execute(context(), {});
    expect(units).toEqual([{ market: market.marketId, options: { readOnly: true } }]);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.items.map((item) => item.code)).toEqual(['brand', 'pack-size', 'storage']);
    expect(result.value.items[0]).toMatchObject({
      id: ID(1),
      dataType: 'text',
      status: 'active',
      productCount: 7,
      featureSetCount: 2,
      missingLocales: [],
    });
    expect(result.value.items[1]).toMatchObject({
      isVariantOption: true,
      productCount: 4,
      featureSetCount: 1,
      // The 500 g label has no second-locale text.
      missingLocales: second === null ? [] : [second],
    });
    expect(result.value.items[2]).toMatchObject({
      material: true,
      status: 'archived',
      productCount: 0,
    });
    expect(result.value).toMatchObject({
      total: 3,
      totalAll: 3,
      nextAfterId: null,
      truncated: false,
      locales: { default: locale },
      featureSets: [
        { id: ID(10), code: 'default' },
        { id: ID(11), code: 'rice' },
      ],
    });
    expect(result.value.locales.supported[0]).toBe(locale);
  });

  it('filters and pages', async () => {
    const codes = async (input: Record<string, unknown>) => {
      const result = await list().execute(context(), input);
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return result.value;
    };
    expect((await codes({ search: 'PACK' })).items.map((i) => i.code)).toEqual(['pack-size']);
    expect((await codes({ type: 'long-text' })).items.map((i) => i.code)).toEqual(['storage']);
    expect((await codes({ status: 'active' })).items.map((i) => i.code)).toEqual([
      'brand',
      'pack-size',
    ]);
    expect((await codes({ usedIn: ID(11) })).items.map((i) => i.code)).toEqual(['brand']);
    if (second !== null) {
      expect((await codes({ missing: second })).items.map((i) => i.code)).toEqual([
        'pack-size',
        'storage',
      ]);
    }
    const first = await codes({ limit: 2 });
    expect(first.items.map((i) => i.code)).toEqual(['brand', 'pack-size']);
    expect(first.nextAfterId).toBe(ID(2));
    expect(first.total).toBe(3);
    const next = await codes({ limit: 2, afterId: first.nextAfterId });
    expect(next.items.map((i) => i.code)).toEqual(['storage']);
    expect(next.nextAfterId).toBeNull();
  });

  it.each([
    [{ limit: 0 }, 'limit', 'range'],
    [{ limit: 101 }, 'limit', 'range'],
    [{ afterId: 'x' }, 'afterId', 'format'],
    [{ colour: 'red' }, 'colour', 'unknown'],
    [{ missing: 'xx-XX' }, 'missing', 'unknown'],
  ])('refuses the query %j', async (input, path, code) => {
    await expect(list().execute(context(), input as never)).resolves.toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path, code }] },
    });
  });

  it('answers access.unavailable when the unit fails', async () => {
    unitFails = true;
    await expect(list().execute(context(), {})).resolves.toEqual({
      ok: false,
      error: { code: 'access.unavailable' },
    });
    await expect(get().execute(context(), { attributeId: ID(1) })).resolves.toEqual({
      ok: false,
      error: { code: 'access.unavailable' },
    });
  });

  it('reads one attribute with its values by position, uses and history', async () => {
    const result = await get().execute(context(), { attributeId: ID(2) });
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value).toMatchObject({
      id: ID(2),
      code: 'pack-size',
      productCount: 4,
      historyTruncated: false,
      usedIn: [
        {
          featureSetId: ID(10),
          featureSetCode: 'default',
          groupCode: 'pack',
          required: false,
          isVariantOption: true,
        },
      ],
    });
    expect(result.value.options.map((o) => [o.code, o.productCount])).toEqual([
      ['g250', 3],
      ['g500', 0],
    ]);
    expect(result.value.history.map((h) => [h.revisionNo, h.authorKind])).toEqual([
      [2, 'admin'],
      [1, 'seed'],
    ]);
    expect(result.value.history[1]!.changes).toEqual([]);
    expect(result.value.history[0]!.changes).toEqual(
      expect.arrayContaining([
        { field: `name.${locale}`, before: 'Pack', after: 'Pack size' },
        { field: 'option.g500.added', before: null, after: true },
      ]),
    );
  });

  it('answers attribute.not-found for a malformed id, an unknown one and another Market’s', async () => {
    for (const attributeId of ['nope', ID(404), ID(90), undefined]) {
      await expect(get().execute(context(), { attributeId })).resolves.toEqual({
        ok: false,
        error: { code: 'attribute.not-found' },
      });
    }
  });

  it('lists the feature sets with their counts, and reads one with its definitions', async () => {
    const listed = await sets().execute(context(), {});
    if (!listed.ok) throw new Error(listed.error.code);
    expect(listed.value.items).toEqual([
      {
        id: ID(10),
        code: 'default',
        status: 'active',
        revisionNo: 1,
        groupCount: 2,
        attributeCount: 3,
        productCount: 9,
      },
      {
        id: ID(11),
        code: 'rice',
        status: 'active',
        revisionNo: 1,
        groupCount: 1,
        attributeCount: 1,
        productCount: 0,
      },
    ]);
    await expect(sets().execute(context(), { extra: 1 } as never)).resolves.toMatchObject({
      ok: false,
      error: { code: 'validation.failed' },
    });

    const one = await set().execute(context(), { featureSetId: ID(10) });
    if (!one.ok) throw new Error(one.error.code);
    expect(one.value.productCount).toBe(9);
    expect(one.value.locales.default).toBe(locale);
    expect(one.value.groups[0]!.attributes).toEqual([
      {
        code: 'brand',
        required: true,
        isVariantOption: false,
        attributeId: ID(1),
        names: names('Brand', 'Brand-x'),
        dataType: 'text',
        status: 'active',
        material: false,
      },
      {
        code: 'gone',
        required: false,
        isVariantOption: false,
        attributeId: null,
        names: null,
        dataType: null,
        status: null,
        material: null,
      },
    ]);
    for (const featureSetId of ['x', ID(404)]) {
      await expect(set().execute(context(), { featureSetId })).resolves.toEqual({
        ok: false,
        error: { code: 'feature-set.not-found' },
      });
    }
  });
});
