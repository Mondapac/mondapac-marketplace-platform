import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { MemoryAttributeDefinitionStore } from '../../../../../test/support/catalog-attribute-editor-fakes';
import { MemoryAttributeValueSuggestionStore } from '../../../../../test/support/catalog-suggestion-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_VIEW } from '../../contracts/permissions';
import { AttributeDefinition } from '../../domain/attribute-definition';
import {
  AttributeValueSuggestion,
  MAX_OPEN_SUGGESTIONS_PER_SELLER,
  type SuggestionStatus,
} from '../../domain/attribute-value-suggestion';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import { OwnAttributeSuggestionsList } from './own-attribute-suggestions-list.use-case';

// The seller's own value suggestions (the seller panel's "Value suggestions" page), in memory on
// both Market fixtures: only the seller's own rows, newest first, keyset pages, the status filter,
// the outcome of each decision, a product that is not the seller's never named, the count of
// waiting ones, the closed query and the access rule. The SQL is in
// test/db/catalog-attribute-suggestions.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const T0 = Temporal.Instant.from('2026-11-05T01:00:00Z');
const SELLER = '01990000-0000-7000-8000-0000000000a3' as Id<'Seller'>;
const OTHER_SELLER = '01990000-0000-7000-8000-0000000000a4' as Id<'Seller'>;
const ADMIN = '01990000-0000-7000-8000-0000000000a1' as Id<'Account'>;
const PRODUCT = '01990000-0000-7000-8000-0000000000b1' as Id<'Product'>;
const FOREIGN_PRODUCT = '01990000-0000-7000-8000-0000000000b2' as Id<'Product'>;
const DEFINITION = '01990000-0000-7000-8000-0000000000c1' as Id<'AttributeDefinition'>;
const GONE_DEFINITION = '01990000-0000-7000-8000-0000000000c9' as Id<'AttributeDefinition'>;

const suggestionId = (n: number) =>
  `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}` as Id<'AttributeValueSuggestion'>;

describe.each(['AU', 'ZZ'] as const)('own attribute suggestions list in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const english = policy.locales(market).default;

  const context = (population: 'seller' | 'admin' = 'seller'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ADMIN,
        sessionId: '01990000-0000-7000-8000-0000000000a2' as never,
        sellerId: population === 'seller' ? SELLER : null,
      }),
    );

  let definitions: MemoryAttributeDefinitionStore;
  let suggestions: MemoryAttributeValueSuggestionStore;
  let allow: boolean;
  let unitFails: boolean;

  const check: AuthorisationCheck = {
    check: (_context, declaration) =>
      Promise.resolve(
        allow &&
          declaration.rule.kind === 'permissions' &&
          declaration.rule.allOf.includes(CATALOG_OWN_PRODUCT_VIEW.key)
          ? { allowed: true }
          : { allowed: false, denial: { code: 'access.denied' } },
      ),
  };
  const unitOfWork = {
    run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => {
      if (unitFails) return { ok: false, error: { code: 'unit.failed' } };
      return work();
    },
  } as unknown as UnitOfWork;
  const products = {
    findById: (_m: MarketContext, id: Id<'Product'>) =>
      Promise.resolve(
        id === PRODUCT
          ? { state: { id, scope: 'SELLER', ownerSellerId: SELLER, productCode: 'P-1' } }
          : id === FOREIGN_PRODUCT
            ? { state: { id, scope: 'SELLER', ownerSellerId: OTHER_SELLER, productCode: 'P-2' } }
            : null,
      ),
  };
  const ownReader = {
    findWorkingCopies: (_m: MarketContext, ids: readonly Id<'Product'>[]) =>
      Promise.resolve(
        ids.map((productId) => ({
          productId,
          content: { texts: { [english]: { name: `Name of ${productId.slice(-2)}` } } },
        })),
      ),
  };

  const build = () =>
    new OwnAttributeSuggestionsList(createUseCaseGate(markets, check), {
      unitOfWork,
      suggestions,
      attributeStore: definitions,
      products: products as never,
      ownReader: ownReader as never,
      policy,
    });

  const row = (
    n: number,
    status: SuggestionStatus,
    extra: Partial<AttributeValueSuggestion['state']> = {},
  ) => {
    const decided = status !== 'open';
    const suggestion = AttributeValueSuggestion.rehydrate({
      id: suggestionId(n),
      marketId: market.marketId,
      definitionId: DEFINITION,
      sellerId: SELLER,
      productId: PRODUCT,
      label: `Value ${n}`,
      status,
      optionCode: status === 'approved' ? 'xl' : status === 'mapped' ? 'small' : null,
      rejectReason: status === 'rejected' ? 'Not a size we sell.' : null,
      decidedByAccountId: decided ? ADMIN : null,
      decidedAt: decided ? T0.add({ minutes: n }) : null,
      noticeState: decided ? 'sent' : 'none',
      noticeAttempts: decided ? 1 : 0,
      noticeNextAttemptAt: null,
      version: decided ? 3 : 1,
      createdAt: T0.add({ seconds: n }),
      ...extra,
    });
    suggestions.rows.set(suggestion.state.id, suggestion);
    return suggestion;
  };

  beforeEach(() => {
    allow = true;
    unitFails = false;
    definitions = new MemoryAttributeDefinitionStore();
    suggestions = new MemoryAttributeValueSuggestionStore();
    const built = AttributeDefinition.create({
      id: DEFINITION,
      revisionId: '01990000-0000-7000-8000-0000000000d1' as never,
      marketId: market.marketId,
      code: 'pack-size',
      dataType: 'select',
      localizable: false,
      material: false,
      isVariantOption: false,
      bounds: {},
      names: { [english]: 'Pack size' },
      options: [
        { code: 'small', labels: { [english]: 'Small' }, active: true, position: 0 },
        { code: 'xl', labels: { [english]: 'Extra large' }, active: true, position: 1 },
      ],
      createdByKind: 'admin',
      now: T0,
    });
    if (!built.ok) throw new Error(built.error.code);
    definitions.rows.set(DEFINITION, built.value);
  });

  it('lists only the seller’s own suggestions, newest first, with each outcome', async () => {
    row(1, 'open');
    row(2, 'approved');
    row(3, 'mapped');
    row(4, 'rejected');
    row(5, 'open', { sellerId: OTHER_SELLER });
    const answer = await build().execute(context(), {});
    if (!answer.ok) throw new Error(answer.error.code);
    const { items, nextAfterId, openCount, maxOpen, locales } = answer.value;
    expect(items.map((item) => item.id)).toEqual([4, 3, 2, 1].map(suggestionId));
    expect(nextAfterId).toBeNull();
    expect(openCount).toBe(1);
    expect(maxOpen).toBe(MAX_OPEN_SUGGESTIONS_PER_SELLER);
    expect(locales.default).toBe(english);
    const [rejected, mapped, approved, open] = items;
    expect(rejected).toMatchObject({
      status: 'rejected',
      label: 'Value 4',
      rejectReason: 'Not a size we sell.',
      value: null,
      attribute: { code: 'pack-size', names: { [english]: 'Pack size' } },
      product: { id: PRODUCT, productCode: 'P-1', name: 'Name of b1' },
    });
    expect(mapped).toMatchObject({
      status: 'mapped',
      rejectReason: null,
      value: { code: 'small', labels: { [english]: 'Small' } },
    });
    expect(approved).toMatchObject({
      status: 'approved',
      value: { code: 'xl', labels: { [english]: 'Extra large' } },
      decidedAt: T0.add({ minutes: 2 }).toString(),
    });
    expect(open).toMatchObject({ status: 'open', decidedAt: null, value: null });
    // The admin who decided is never part of the answer.
    expect(JSON.stringify(items)).not.toContain(ADMIN);
  });

  it('pages by afterId and filters by status, counting the waiting ones whatever the filter', async () => {
    for (let n = 1; n <= 5; n += 1) row(n, n % 2 === 0 ? 'rejected' : 'open');
    const first = await build().execute(context(), { limit: 2 });
    if (!first.ok) throw new Error(first.error.code);
    expect(first.value.items.map((item) => item.id)).toEqual([5, 4].map(suggestionId));
    expect(first.value.nextAfterId).toBe(suggestionId(4));
    const second = await build().execute(context(), {
      limit: 2,
      afterId: first.value.nextAfterId,
    });
    if (!second.ok) throw new Error(second.error.code);
    expect(second.value.items.map((item) => item.id)).toEqual([3, 2].map(suggestionId));
    const rejected = await build().execute(context(), { status: 'rejected' });
    if (!rejected.ok) throw new Error(rejected.error.code);
    expect(rejected.value.items.map((item) => item.id)).toEqual([4, 2].map(suggestionId));
    expect(rejected.value.openCount).toBe(3);
  });

  it('never names a product that is not the seller’s, and keeps a row whose attribute is gone', async () => {
    row(1, 'open', { productId: FOREIGN_PRODUCT });
    row(2, 'open', { definitionId: GONE_DEFINITION, productId: PRODUCT });
    const answer = await build().execute(context(), {});
    if (!answer.ok) throw new Error(answer.error.code);
    const [gone, foreign] = answer.value.items;
    expect(foreign?.product).toEqual({ id: FOREIGN_PRODUCT, productCode: null, name: null });
    expect(gone?.attribute).toBeNull();
    expect(gone?.product.productCode).toBe('P-1');
  });

  it('refuses an open query, a bad status, id or limit', async () => {
    const use = build();
    const fieldOf = async (input: Record<string, unknown>) => {
      const answer = await use.execute(context(), input);
      if (answer.ok || answer.error.code !== 'validation.failed') throw new Error('expected 400');
      return answer.error.fields[0];
    };
    expect(await fieldOf({ sellerId: OTHER_SELLER })).toEqual({
      path: 'sellerId',
      code: 'unknown',
    });
    expect(await fieldOf({ status: 'decided' })).toEqual({ path: 'status', code: 'enum' });
    expect(await fieldOf({ afterId: 'x' })).toEqual({ path: 'afterId', code: 'format' });
    expect(await fieldOf({ limit: 51 })).toEqual({ path: 'limit', code: 'range' });
    expect(await fieldOf({ limit: -1 })).toEqual({ path: 'limit', code: 'range' });
  });

  it('denies an actor without the key or who is not a seller, and says when the store fails', async () => {
    allow = false;
    expect(await build().execute(context(), {})).toMatchObject({
      ok: false,
      error: { code: 'access.denied' },
    });
    allow = true;
    expect(await build().execute(context('admin'), {})).toMatchObject({
      ok: false,
      error: { code: 'access.denied' },
    });
    unitFails = true;
    expect(await build().execute(context(), {})).toMatchObject({
      ok: false,
      error: { code: 'access.unavailable' },
    });
  });
});
