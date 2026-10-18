import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { OfferHit } from '../domain/offer-document';
import { ConfigSearchPolicy } from '../infrastructure/config-search-policy';
import type { OfferSearchReader, OfferSearchRequest } from './ports/offer-search.reader';
import type { PublicVisibility } from './ports/public-visibility';
import type { ShelfDocumentsReader } from './ports/shelf-documents.reader';
import type { ShelfSources, ShelfSpecial } from './ports/shelf-sources';
import type { ShelfDependencies } from './shelf-dependencies';
import { FILL_DEPTH, ListBestsellers, RANKED_DEPTH } from './use-cases/list-bestsellers.use-case';
import { ListSpecials, SPECIALS_DEPTH } from './use-cases/list-specials.use-case';

// The two shelf reads in memory on both Market fixtures (AU in AUD, ZZ in JPY): the order comes
// from ordering's ranking or pricing's specials, the documents from the read model, a short
// best-sellers shelf is filled in browse order, and nothing is shown that catalog and sellers do
// not show now. A source or check that fails is `search.unavailable`.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const ENDS = Temporal.Instant.from('2026-10-20T00:00:00Z');

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const offer = (n: number): Id<'Offer'> => id<'Offer'>(0x1000 + n);
const variant = (n: number): Id<'Variant'> => id<'Variant'>(0x2000 + n);
const SELLER = id<'Seller'>(0x51);
const CATEGORY = id<'Category'>(0xca);
const OTHER_CATEGORY = id<'Category'>(0xcb);

const hit = (n: number, categoryIds: readonly Id<'Category'>[] = [CATEGORY]): OfferHit => ({
  offerId: offer(n),
  productId: id<'Product'>(0x900 + n),
  sellerId: SELLER,
  name: `Product ${n}`,
  shortText: null,
  categoryIds,
  rank: 0,
});

class MemoryShelves implements ShelfDocumentsReader {
  documents: OfferHit[] = [];
  readonly browsed: number[] = [];
  byOfferIds(_market: MarketContext, offerIds: readonly Id<'Offer'>[]) {
    return Promise.resolve(this.documents.filter((d) => offerIds.includes(d.offerId)));
  }
  browseAll(_market: MarketContext, limit: number) {
    this.browsed.push(limit);
    return Promise.resolve(
      [...this.documents].sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit),
    );
  }
}

class StubReader implements OfferSearchReader {
  hits: OfferHit[] = [];
  readonly requests: OfferSearchRequest[] = [];
  search(_market: MarketContext, request: OfferSearchRequest) {
    this.requests.push(request);
    return Promise.resolve(this.hits.slice(0, request.limit));
  }
}

class StubSources implements ShelfSources {
  ranked: Id<'Offer'>[] | null = [];
  specials_: ShelfSpecial[] | null = [];
  readonly asked: { kind: string; actor: string; limit: number }[] = [];
  bestSellingOfferIds(context: CallContext, limit: number) {
    this.asked.push({ kind: 'bestsellers', actor: context.actor.kind, limit });
    return Promise.resolve(this.ranked);
  }
  specials(context: CallContext, limit: number) {
    this.asked.push({ kind: 'specials', actor: context.actor.kind, limit });
    return Promise.resolve(this.specials_);
  }
}

class StubVisibility implements PublicVisibility {
  hidden = new Set<Id<'Offer'>>();
  failing = false;
  visible(_context: CallContext, offers: readonly { offerId: Id<'Offer'> }[]) {
    if (this.failing) return Promise.resolve(null);
    return Promise.resolve(
      new Set(offers.filter((o) => !this.hidden.has(o.offerId)).map((o) => o.offerId)),
    );
  }
}

describe.each([
  ['AU', 'AUD'],
  ['ZZ', 'JPY'],
] as const)('storefront shelves in market %s', (code, currency) => {
  const market = testMarketContext(code, 'default');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const anonymous = testCallContext(market, 'anonymous', 'shelf-anon-abcdef');
  const system = testCallContext(market, 'system', 'shelf-system-abcd');

  let shelves: MemoryShelves;
  let reader: StubReader;
  let sources: StubSources;
  let visibility: StubVisibility;
  let deps: ShelfDependencies;

  beforeEach(() => {
    shelves = new MemoryShelves();
    reader = new StubReader();
    sources = new StubSources();
    visibility = new StubVisibility();
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      reader,
      shelves,
      sources,
      visibility,
      policy: new ConfigSearchPolicy(markets),
    };
  });

  const special = (n: number, variantNo = n): ShelfSpecial => ({
    offerId: offer(n),
    variantId: variant(variantNo),
    price: { amount: 800n, currency },
    regularPrice: { amount: 1000n, currency },
    taxInclusive: true,
    endsAt: ENDS,
  });

  describe('ListBestsellers', () => {
    const run = (input: object, context = anonymous) =>
      new ListBestsellers(gate, deps).execute(context, input);

    it('shows ranked Offers in rank order, then fills from browse order without repeats', async () => {
      shelves.documents = [hit(1), hit(2), hit(3), hit(4)];
      sources.ranked = [offer(3), offer(9), offer(1)];

      const result = await run({ limit: 4 });

      expect(result).toEqual({
        ok: true,
        value: {
          items: [3, 1, 2, 4].map((n) => {
            const { rank: _rank, ...item } = hit(n);
            return item;
          }),
        },
      });
      expect(sources.asked).toEqual([
        { kind: 'bestsellers', actor: 'anonymous', limit: RANKED_DEPTH },
      ]);
      expect(shelves.browsed).toEqual([FILL_DEPTH]);
    });

    it('keeps only the category, and fills from that category in browse order', async () => {
      shelves.documents = [hit(1, [OTHER_CATEGORY]), hit(2)];
      sources.ranked = [offer(1), offer(2)];
      reader.hits = [hit(5), hit(2)];

      const result = await run({ category: CATEGORY, limit: 3 });

      expect(result.ok && result.value.items.map((i) => i.offerId)).toEqual([offer(2), offer(5)]);
      expect(reader.requests).toEqual([
        expect.objectContaining({ text: null, categoryId: CATEGORY, limit: FILL_DEPTH, offset: 0 }),
      ]);
      expect(shelves.browsed).toEqual([]);
    });

    it('drops what catalog or sellers no longer show, and caps at the limit', async () => {
      shelves.documents = [hit(1), hit(2), hit(3)];
      sources.ranked = [offer(1), offer(2), offer(3)];
      visibility.hidden.add(offer(1));

      const result = await run({ limit: 1 });

      expect(result.ok && result.value.items.map((i) => i.offerId)).toEqual([offer(2)]);
    });

    it('is unavailable when the ranking or the check fails, never an unchecked list', async () => {
      shelves.documents = [hit(1)];
      sources.ranked = null;
      expect(await run({})).toEqual({ ok: false, error: { code: 'search.unavailable' } });

      sources.ranked = [offer(1)];
      visibility.failing = true;
      expect(await run({})).toEqual({ ok: false, error: { code: 'search.unavailable' } });
    });

    it.each([
      [{ limit: 0 }, 'limit'],
      [{ limit: 25 }, 'limit'],
      [{ limit: 1.5 }, 'limit'],
      [{ category: 'not-a-uuid' }, 'category'],
    ])('refuses %j before any read', async (input, path) => {
      const result = await run(input);

      expect(result).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path, code: expect.any(String) }] },
      });
      expect(sources.asked).toEqual([]);
    });

    it('is not for the system actor (rule anonymous)', async () => {
      const result = await run({}, system);

      expect(result.ok).toBe(false);
      expect(sources.asked).toEqual([]);
    });
  });

  describe('ListSpecials', () => {
    const run = (input: object, context = anonymous) =>
      new ListSpecials(gate, deps).execute(context, input);

    it('shows each Offer once with its special and regular price in the Market currency', async () => {
      shelves.documents = [hit(1), hit(2)];
      sources.specials_ = [special(2), special(1), special(2, 22)];

      const result = await run({});

      expect(result.ok && result.value.items).toEqual([
        expect.objectContaining({
          offerId: offer(2),
          variantId: variant(2),
          price: { amount: 800n, currency },
          regularPrice: { amount: 1000n, currency },
          taxInclusive: true,
          specialEndsAt: ENDS,
        }),
        expect.objectContaining({ offerId: offer(1), variantId: variant(1) }),
      ]);
      expect(sources.asked).toEqual([
        { kind: 'specials', actor: 'anonymous', limit: SPECIALS_DEPTH },
      ]);
    });

    it('leaves out unindexed, other-category and hidden Offers', async () => {
      shelves.documents = [hit(1), hit(2, [OTHER_CATEGORY]), hit(3)];
      sources.specials_ = [special(1), special(2), special(3), special(4)];
      visibility.hidden.add(offer(3));

      const result = await run({ category: CATEGORY });

      expect(result.ok && result.value.items.map((i) => i.offerId)).toEqual([offer(1)]);
    });

    it('is unavailable when pricing or the check fails', async () => {
      sources.specials_ = null;
      expect(await run({})).toEqual({ ok: false, error: { code: 'search.unavailable' } });

      sources.specials_ = [special(1)];
      shelves.documents = [hit(1)];
      visibility.failing = true;
      expect(await run({})).toEqual({ ok: false, error: { code: 'search.unavailable' } });
    });
  });
});
