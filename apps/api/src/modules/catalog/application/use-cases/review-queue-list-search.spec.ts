import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type {
  OfferQueueFilter,
  PendingRevisionRow,
  ProductLabel,
  QueueTextSearch,
  RevisionQueueFilter,
} from '../ports/own-catalog.reader';
import {
  parseQueueSearch,
  ReviewQueueList,
  REVIEW_QUEUE_SEARCH_MAX_LENGTH,
} from './review-queue-list.use-case';

// The search text `q` of the review queue: parsed (2 to 100 characters once trimmed), handed to
// both sources with the store names `sellers` matched, composed with the other filters and with
// `total`, while `totals` stays the whole queue. The fake sources apply the search as the
// repositories do (contains, any case, on the product code, the name the row shows and the
// matched stores), so the rows kept are checked for both kinds and both Market fixtures.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const ID = (n: number) => `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const AT = (minutes: number) => Temporal.Instant.from('2026-11-01T00:00:00Z').add({ minutes });

const DATES_CO = ID(0x2001);
const SPICE_HOUSE = ID(0x2002);
const STORES: Record<string, string> = { [DATES_CO]: 'Dates Co', [SPICE_HOUSE]: 'Spice House' };

describe('parseQueueSearch', () => {
  it.each([
    [undefined, null],
    [null, null],
    ['', null],
    ['ab', 'ab'],
    ['  Saffron  ', 'Saffron'],
    ['x'.repeat(REVIEW_QUEUE_SEARCH_MAX_LENGTH), 'x'.repeat(REVIEW_QUEUE_SEARCH_MAX_LENGTH)],
    // Code points, not UTF-16 units: 50 emoji are 50 characters.
    ['😀'.repeat(50), '😀'.repeat(50)],
    // A wildcard is kept as typed: the repository escapes it.
    ['50%_off', '50%_off'],
    ['خرما‌ها', 'خرما‌ها'],
  ])('reads %j as %j', (value, expected) => {
    expect(parseQueueSearch(value)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ['a', 'length'],
    ['  a  ', 'length'],
    ['   ', 'length'],
    ['x'.repeat(REVIEW_QUEUE_SEARCH_MAX_LENGTH + 1), 'length'],
    [` ${'x'.repeat(REVIEW_QUEUE_SEARCH_MAX_LENGTH + 1)} `, 'length'],
    [12, 'type'],
    [['ab', 'cd'], 'type'],
    ['ab\u0000cd', 'format'],
  ])('refuses %j as %s on q', (value, code) => {
    expect(parseQueueSearch(value)).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'q', code }] },
    });
  });
});

describe.each(['AU', 'ZZ'] as const)('review queue search in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const context = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ID(0xa1) as never,
        sessionId: ID(0xa2) as never,
        sellerId: null,
      }),
    );
  const check: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };

  // Offers: the name an Offer row shows is its product's published name (the label).
  const offers = [
    { id: ID(0x301), sellerId: DATES_CO, productId: ID(0x101), at: AT(1) },
    { id: ID(0x302), sellerId: SPICE_HOUSE, productId: ID(0x102), at: AT(2) },
    { id: ID(0x303), sellerId: SPICE_HOUSE, productId: ID(0x103), at: AT(3) },
  ];
  const labels: ProductLabel[] = [
    {
      productId: ID(0x101) as never,
      productCode: 'P-1001',
      typeCode: 'simple',
      scope: 'PLATFORM',
      name: 'Medjool dates',
    },
    {
      productId: ID(0x102) as never,
      productCode: 'P-1002',
      typeCode: 'simple',
      scope: 'PLATFORM',
      name: 'Saffron 1g',
    },
    {
      productId: ID(0x103) as never,
      productCode: 'SAF-50%',
      typeCode: 'simple',
      scope: 'PLATFORM',
      name: null,
    },
  ];
  const revisions: PendingRevisionRow[] = [
    revisionRow(0x401, DATES_CO, 'R-2001', 'Date syrup', AT(4), true),
    revisionRow(0x402, SPICE_HOUSE, 'R-2002', 'Cardamom pods', AT(5), false),
    revisionRow(0x403, SPICE_HOUSE, 'DATE-9', null, AT(6), true),
  ];

  const hits = (
    search: QueueTextSearch | undefined,
    fields: readonly (string | null)[],
    seller: string,
  ) =>
    search === undefined ||
    fields.some((field) => field?.toLowerCase().includes(search.text.toLowerCase()) ?? false) ||
    search.sellerIds.includes(seller as never);
  const keepsOffer = (offer: (typeof offers)[number], filter: OfferQueueFilter = {}) => {
    const label = labels.find((l) => l.productId === offer.productId);
    return (
      (filter.sellerId === undefined || filter.sellerId === offer.sellerId) &&
      hits(filter.search, [label?.productCode ?? null, label?.name ?? null], offer.sellerId)
    );
  };
  const keepsRevision = (row: PendingRevisionRow, filter: RevisionQueueFilter = {}) =>
    (filter.sellerId === undefined || filter.sellerId === row.sellerId) &&
    (filter.firstPublication === undefined || filter.firstPublication === row.firstPublication) &&
    hits(filter.search, [row.productCode, row.name], row.sellerId);

  let storeTerms: string[];
  let storeFails: boolean;
  let reads: number;
  let offerFilters: OfferQueueFilter[];
  let revisionFilters: RevisionQueueFilter[];

  const build = () =>
    new ReviewQueueList(createUseCaseGate(markets, check), {
      unitOfWork: {
        run: async (_m: MarketContext, work: () => Promise<unknown>) => {
          reads += 1;
          return work();
        },
      } as never,
      offers: {
        listPendingReview: (_m: MarketContext, _page: unknown, filter: OfferQueueFilter) => {
          offerFilters.push(filter);
          return Promise.resolve(
            offers
              .filter((offer) => keepsOffer(offer, filter))
              .map((offer) => ({
                state: {
                  id: offer.id,
                  version: 1,
                  sellerId: offer.sellerId,
                  productId: offer.productId,
                  sellerSku: `SKU-${offer.id.slice(-3)}`,
                  conditionCode: 'new',
                  description: {},
                  handling: null,
                  submittedAt: offer.at,
                },
              })),
          );
        },
      } as never,
      ownReader: {
        pendingReviewCount: (_m: MarketContext, filter?: OfferQueueFilter) =>
          Promise.resolve(offers.filter((offer) => keepsOffer(offer, filter)).length),
        pendingRevisionCount: (_m: MarketContext, filter?: RevisionQueueFilter) =>
          Promise.resolve(revisions.filter((row) => keepsRevision(row, filter)).length),
        listPendingRevisions: (
          _m: MarketContext,
          _p: unknown,
          _l: string,
          filter: RevisionQueueFilter,
        ) => {
          revisionFilters.push(filter);
          return Promise.resolve(revisions.filter((row) => keepsRevision(row, filter)));
        },
        productLabels: (_m: MarketContext, ids: readonly string[]) =>
          Promise.resolve(labels.filter((label) => ids.includes(label.productId))),
      } as never,
      policy: { locales: () => ({ default: 'en', supported: ['en'] }) } as never,
      sellerNames: {
        storeNames: (_c: CallContext, ids: readonly string[]) =>
          Promise.resolve(new Map(ids.map((id) => [id, STORES[id]!] as const))) as never,
      },
      storeSearch: {
        sellersMatching: (_c: CallContext, text: string) => {
          storeTerms.push(text);
          if (storeFails) return Promise.reject(new Error('sellers down'));
          const sellerIds = Object.entries(STORES)
            .filter(([, name]) => name.toLowerCase().includes(text.toLowerCase()))
            .map(([id]) => id) as never;
          return Promise.resolve({ sellerIds, capped: false });
        },
      },
      gtinRegistry: { duplicatesOf: () => Promise.resolve([]) },
      productApproveProbe: { probe: () => Promise.resolve(false) } as never,
    });

  beforeEach(() => {
    storeTerms = [];
    storeFails = false;
    reads = 0;
    offerFilters = [];
    revisionFilters = [];
  });

  const idsOf = (items: readonly { kind: string; offerId?: string; productId: string }[]) =>
    items.map((item) => (item.kind === 'offer-first-publication' ? item.offerId : item.productId));

  it('keeps the rows of both kinds whose product name contains the text, in any case', async () => {
    const result = await build().execute(context(), { q: '  DATE  ', paging: 'pages' });
    if (!result.ok) throw new Error(result.error.code);
    // Offer 0x301 by its name, revision 0x401 by its name, 0x403 by its code; Dates Co matches too.
    expect(idsOf(result.value.items as never)).toEqual([ID(0x301), ID(0x401), ID(0x403)]);
    expect(storeTerms).toEqual(['DATE']);
    expect(result.value.total).toBe(3);
    // The tab counts stay the whole queue's.
    expect(result.value.totals).toEqual({
      'product-revision': 3,
      'offer-first-publication': 3,
    });
    // Both sources get the same search, with the Market's default locale and the matched stores.
    const search = { text: 'DATE', locale: 'en', sellerIds: [DATES_CO] };
    expect(offerFilters[0]).toEqual({ search });
    expect(revisionFilters[0]).toEqual({ search });
  });

  it('keeps rows by product code, and by store name for both kinds', async () => {
    const byCode = await build().execute(context(), { q: 'p-100', paging: 'pages' });
    if (!byCode.ok) throw new Error(byCode.error.code);
    expect(idsOf(byCode.value.items as never)).toEqual([ID(0x301), ID(0x302)]);

    const byStore = await build().execute(context(), { q: 'spice', paging: 'pages' });
    if (!byStore.ok) throw new Error(byStore.error.code);
    expect(idsOf(byStore.value.items as never)).toEqual([
      ID(0x302),
      ID(0x303),
      ID(0x402),
      ID(0x403),
    ]);
    expect(byStore.value.items.every((item) => item.storeName === 'Spice House')).toBe(true);
    expect(byStore.value.total).toBe(4);
  });

  it('composes with kind, sellerId, firstPublication and the cursor read', async () => {
    const one = await build().execute(context(), {
      q: 'spice',
      kind: 'product-revision',
      firstPublication: true,
      paging: 'pages',
    });
    if (!one.ok) throw new Error(one.error.code);
    expect(idsOf(one.value.items as never)).toEqual([ID(0x403)]);
    expect(one.value.total).toBe(1);
    expect(offerFilters).toEqual([]);

    const seller = await build().execute(context(), {
      q: 'date',
      sellerId: SPICE_HOUSE,
      paging: 'pages',
    });
    if (!seller.ok) throw new Error(seller.error.code);
    expect(idsOf(seller.value.items as never)).toEqual([ID(0x403)]);

    const cursor = await build().execute(context(), { q: 'saffron', limit: 10 });
    if (!cursor.ok) throw new Error(cursor.error.code);
    expect(idsOf(cursor.value.items as never)).toEqual([ID(0x302)]);
    expect(cursor.value.total).toBe(1);
  });

  it('finds nothing for a text no row holds, and gives no search for an empty q', async () => {
    const none = await build().execute(context(), { q: 'kosher', paging: 'pages' });
    if (!none.ok) throw new Error(none.error.code);
    expect(none.value.items).toEqual([]);
    expect(none.value.total).toBe(0);
    expect(none.value.totals).toEqual({ 'product-revision': 3, 'offer-first-publication': 3 });

    const empty = await build().execute(context(), { q: '', paging: 'pages' });
    if (!empty.ok) throw new Error(empty.error.code);
    expect(empty.value.total).toBe(6);
    expect(storeTerms).toEqual(['kosher']);
  });

  it.each([
    [{ q: 'a' }, 'length'],
    [{ q: 'x'.repeat(101) }, 'length'],
    [{ q: 7 }, 'type'],
    [{ q: 'a', limit: 5 }, 'length'],
  ])('refuses %j as validation.failed on q before any read', async (input, reason) => {
    expect(await build().execute(context(), input)).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'q', code: reason }] },
    });
    expect(reads).toBe(0);
    expect(storeTerms).toEqual([]);
  });

  it('fails closed when the store names cannot be searched', async () => {
    storeFails = true;
    expect(await build().execute(context(), { q: 'dates' })).toEqual({
      ok: false,
      error: { code: 'access.unavailable' },
    });
    expect(reads).toBe(0);
  });
});

function revisionRow(
  n: number,
  sellerId: string,
  productCode: string,
  name: string | null,
  submittedAt: Temporal.Instant,
  firstPublication: boolean,
): PendingRevisionRow {
  return {
    productId: ID(n) as never,
    productVersion: 1,
    sellerId: sellerId as never,
    productCode,
    typeCode: 'simple',
    revisionId: ID(n + 0x1000) as never,
    revisionNo: 1,
    firstPublication,
    sensitiveReasons: [],
    hasImages: false,
    variantGtins: [],
    name,
    submittedAt,
  };
}
