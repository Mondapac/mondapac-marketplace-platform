import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { InMemoryOfferPendingChanges } from '../../../../../test/support/catalog-offer-edit-review-fakes';
import { activeTagState } from '../../../../../test/support/catalog-tag-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { Offer, type OfferState } from '../../domain/offer';
import { OfferPendingChange } from '../../domain/offer-pending-change';
import type { OfferReviewReason } from '../../domain/offer-review-policy';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type { CategoryOfferReviewFlagsStore } from '../ports/category-offer-review-flags.store';
import type { OfferChangeQueueFilter } from '../ports/offer-pending-change.repository';
import type { OfferRepository } from '../ports/offer.repository';
import type { OwnCatalogReader } from '../ports/own-catalog.reader';
import { AdminOfferChangeView } from './admin-offer-change-view.use-case';
import { AdminOfferChangesExport } from './admin-offer-changes-export.use-case';
import { AdminOfferChangesList } from './admin-offer-changes-list.use-case';
import { OfferReviewStopsView } from './offer-review-stops-view.use-case';

// The admin review queue's APIs of risk-based Offer approval slice 5, in memory on both Market
// fixtures: the Edits super list (filters, search, page and keyset reads, totals), the live values
// next to the proposed ones, one change by id, the export, and the stop banner's counts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-11-25T00:00:00Z');

describe.each([
  ['AU', 'halal'],
  ['ZZ', 'zz-cert'],
] as const)('offer review queue APIs in market %s', (code, typeCode) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const otherMarket: MarketContext = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const ids = new SequenceIdGenerator(new FixedClock(T0));
  const locale = policy.locales(market).default;
  const SELLER_A = ids.next<'Seller'>();
  const SELLER_B = ids.next<'Seller'>();
  const CATEGORY = ids.next<'Category'>();

  const adminContext = (target: MarketContext = market): CallContext =>
    testCallContext(
      target,
      testAuthenticatedActor(target, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
  const sellerContext = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: SELLER_A,
      }),
    );

  interface Seeded {
    readonly offer: OfferState;
    readonly change: OfferPendingChange;
    readonly name: string;
    readonly inCategory: boolean;
  }

  function rig(options: { storeMatches?: readonly Id<'Seller'>[]; capped?: boolean } = {}) {
    const pendingChanges = new InMemoryOfferPendingChanges();
    const offers = new Map<string, Offer>();
    const seeded: Seeded[] = [];
    const searches: string[] = [];
    let approveHeld = true;
    // Category and text search need the product: the fake keeps the product name and category.
    pendingChanges.productFilter = (row, filter: OfferChangeQueueFilter) => {
      const entry = seeded.find((s) => s.change.state.id === row.id);
      if (entry === undefined) return false;
      if (
        filter.categoryId !== undefined &&
        !(entry.inCategory && filter.categoryId === CATEGORY)
      ) {
        return false;
      }
      if (filter.search !== undefined) {
        const text = filter.search.text.toLowerCase();
        return (
          entry.name.toLowerCase().includes(text) || filter.search.sellerIds.includes(row.sellerId)
        );
      }
      return true;
    };
    const unitOfWork = {
      run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const offerRepository = {
      findManyByIds: (m: MarketContext, wanted: readonly string[]) =>
        Promise.resolve(
          wanted.flatMap((id) => {
            const offer = offers.get(id);
            return offer !== undefined && offer.state.marketId === m.marketId ? [offer] : [];
          }),
        ),
    } as unknown as OfferRepository;
    const ownReader = {
      productLabels: (_m: MarketContext, productIds: readonly string[]) =>
        Promise.resolve(
          productIds.flatMap((productId) => {
            const entry = seeded.find((s) => s.offer.productId === productId);
            return entry === undefined
              ? []
              : [
                  {
                    productId,
                    productCode: `P-${entry.name}`,
                    typeCode: 'simple',
                    name: entry.name,
                  },
                ];
          }),
        ),
    } as unknown as OwnCatalogReader;
    const deps = {
      unitOfWork,
      pendingChanges,
      offers: offerRepository,
      ownReader,
      policy,
      sellerNames: {
        storeNames: (_c: CallContext, sellerIds: readonly Id<'Seller'>[]) =>
          Promise.resolve(
            new Map(sellerIds.map((id) => [id, id === SELLER_A ? 'Dates Co' : 'Rice Co'])),
          ),
      },
      storeSearch: {
        sellersMatching: (_c: CallContext, text: string) => {
          searches.push(text);
          return Promise.resolve({
            sellerIds: options.storeMatches ?? [],
            capped: options.capped ?? false,
          });
        },
      },
      productApproveProbe: { execute: () => Promise.resolve({ ok: approveHeld }) },
    };
    const list = new AdminOfferChangesList(gate, deps);

    /** A live Offer and its held change, `minutes` after T0. */
    function held(
      minutes: number,
      input: {
        readonly seller?: Id<'Seller'>;
        readonly reasons?: readonly OfferReviewReason[];
        readonly name?: string;
        readonly inCategory?: boolean;
        readonly target?: MarketContext;
      } = {},
    ): Seeded {
      const target = input.target ?? market;
      const state: OfferState = {
        id: ids.next<'Offer'>(),
        marketId: target.marketId,
        sellerId: input.seller ?? SELLER_A,
        productId: ids.next<'Product'>(),
        sellerSku: `SKU-${minutes}`,
        conditionCode: policy.conditions(market)[0]!,
        description: { [locale]: 'Lamb shoulder, 1 kg' },
        handling: 'SEALED_ORIGINAL',
        attestationRecordedAt: null,
        attestationAccountId: null,
        status: 'published',
        offSaleCauses: [],
        listed: true,
        submittedAt: T0,
        firstPublishedAt: T0,
        deletedAt: null,
        version: 5,
        createdAt: T0,
      };
      const certificate = {
        certificateId: ids.next(),
        versionId: ids.next(),
        typeRevisionId: ids.next(),
      };
      const tags = [
        activeTagState(ids.next<'OfferTag'>(), typeCode, certificate, T0),
        // A removed tag is history, never a live tag type.
        activeTagState(ids.next<'OfferTag'>(), 'vegan', certificate, T0, { status: 'removed' }),
      ];
      offers.set(state.id, Offer.restore(state, tags));
      const made = OfferPendingChange.propose({
        id: ids.next<'OfferPendingChange'>(),
        marketId: target.marketId,
        offerId: state.id,
        sellerId: state.sellerId,
        baseOfferVersion: 4,
        proposedDescription: { [locale]: 'Call 0412 345 678' },
        proposedHandling: 'FRESH',
        reasons: input.reasons ?? ['contact-text'],
        policyVersion: 3,
        submittedByAccountId: ids.next<'Account'>(),
        now: T0.add({ minutes }),
      });
      if (!made.ok) throw new Error(made.error.code);
      void pendingChanges.insert(target, made.value);
      const entry = {
        offer: state,
        change: made.value,
        name: input.name ?? `Dates ${minutes}`,
        inCategory: input.inCategory ?? false,
      };
      seeded.push(entry);
      return entry;
    }

    return {
      list,
      view: new AdminOfferChangeView(gate, deps),
      exporter: new AdminOfferChangesExport(gate, {
        changes: list,
        sheetWriter: {
          xlsx: (_name: string, rows: AsyncIterable<readonly string[]>) =>
            (async function* () {
              for await (const row of rows) yield new TextEncoder().encode(row.join('|') + '\n');
            })(),
        },
        clock: new FixedClock(T0),
      }),
      held,
      searches,
      offers,
      denyApprove: () => {
        approveHeld = false;
      },
    };
  }

  const idsOf = (result: Result<{ items: readonly { changeId: string }[] }, unknown>) =>
    result.ok ? result.value.items.map((item) => item.changeId) : result;

  describe('admin-offer-changes.list', () => {
    it('answers a page with total, the tab count and the live values next to the proposed ones', async () => {
      const r = rig();
      const a = r.held(1, { reasons: ['contact-text', 'handling'] });
      const b = r.held(2, { seller: SELLER_B });
      const result = await r.list.execute(adminContext(), {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({
        page: 1,
        pageSize: 25,
        paging: 'pages',
        hasNext: false,
        total: 2,
        totalPending: 2,
        searchCapped: false,
        nextAfterId: null,
      });
      expect(result.value.items.map((i) => i.changeId)).toEqual([
        a.change.state.id,
        b.change.state.id,
      ]);
      expect(result.value.items[0]).toEqual(
        expect.objectContaining({
          sellerId: SELLER_A,
          storeName: 'Dates Co',
          reasons: ['contact-text', 'handling'],
          proposedDescription: { [locale]: 'Call 0412 345 678' },
          proposedHandling: 'FRESH',
          live: {
            description: { [locale]: 'Lamb shoulder, 1 kg' },
            handling: 'SEALED_ORIGINAL',
            tagTypes: [typeCode],
          },
          offer: {
            productId: a.offer.productId,
            sellerSku: 'SKU-1',
            conditionCode: a.offer.conditionCode,
            status: 'published',
            version: 5,
          },
          product: { productCode: 'P-Dates 1', typeCode: 'simple', name: 'Dates 1' },
          actions: ['approve', 'request-changes', 'reject'],
        }),
      );
    });

    it('filters by reasons, seller, category and age, and every filter composes', async () => {
      const r = rig();
      const a = r.held(10, { reasons: ['contact-text'], inCategory: true });
      const b = r.held(20, { reasons: ['handling'], seller: SELLER_B, inCategory: true });
      const c = r.held(30, { reasons: ['certificate-badge', 'emergency-stop'] });
      const admin = adminContext();
      expect(idsOf(await r.list.execute(admin, { reasons: 'handling,emergency-stop' }))).toEqual([
        b.change.state.id,
        c.change.state.id,
      ]);
      expect(idsOf(await r.list.execute(admin, { reasons: ['contact-text'] }))).toEqual([
        a.change.state.id,
      ]);
      expect(idsOf(await r.list.execute(admin, { sellerId: SELLER_B }))).toEqual([
        b.change.state.id,
      ]);
      expect(idsOf(await r.list.execute(admin, { categoryId: CATEGORY }))).toEqual([
        a.change.state.id,
        b.change.state.id,
      ]);
      // "Older than 24 h" is submittedTo = now - 24 h; here: before minute 25.
      const before = T0.add({ minutes: 25 }).toString();
      expect(idsOf(await r.list.execute(admin, { submittedTo: before }))).toEqual([
        a.change.state.id,
        b.change.state.id,
      ]);
      expect(
        idsOf(
          await r.list.execute(admin, {
            categoryId: CATEGORY,
            submittedFrom: T0.add({ minutes: 15 }).toString(),
            reasons: 'handling',
          }),
        ),
      ).toEqual([b.change.state.id]);
      const counted = await r.list.execute(admin, { categoryId: CATEGORY });
      expect(counted.ok && [counted.value.total, counted.value.totalPending]).toEqual([2, 3]);
    });

    it('searches with the review queue rules: name, code or a matched store; reports a capped search', async () => {
      const r = rig({ storeMatches: [SELLER_B], capped: true });
      const a = r.held(1, { name: 'Saffron threads' });
      const b = r.held(2, { seller: SELLER_B, name: 'Rice' });
      r.held(3, { name: 'Dates' });
      const result = await r.list.execute(adminContext(), { q: '  saffron ' });
      expect(idsOf(result)).toEqual([a.change.state.id, b.change.state.id]);
      expect(result.ok && result.value.searchCapped).toBe(true);
      expect(r.searches).toEqual(['saffron']);
      for (const q of ['s', 'x'.repeat(101), 'a\u0000b', 7]) {
        const refused = await r.list.execute(adminContext(), { q });
        expect(refused.ok).toBe(false);
        expect(!refused.ok && refused.error).toMatchObject({ code: 'validation.failed' });
      }
    });

    it('fails the read when the store search fails, rather than drop the store matches', async () => {
      const r = rig();
      r.held(1);
      const failing = new AdminOfferChangesList(gate, {
        ...(r.list as unknown as { deps: ConstructorParameters<typeof AdminOfferChangesList>[1] })
          .deps,
        storeSearch: { sellersMatching: () => Promise.reject(new Error('down')) },
      });
      expect(await failing.execute(adminContext(), { q: 'dates' })).toEqual({
        ok: false,
        error: { code: 'access.unavailable' },
      });
    });

    it('pages by number in pages and prev-next mode, newest first on request', async () => {
      const r = rig();
      const rows = [1, 2, 3, 4, 5].map((n) => r.held(n));
      const admin = adminContext();
      const second = await r.list.execute(admin, { page: 2, pageSize: 2 });
      expect(idsOf(second)).toEqual([rows[2]!.change.state.id, rows[3]!.change.state.id]);
      expect(second.ok && [second.value.total, second.value.hasNext]).toEqual([5, true]);
      const prevNext = await r.list.execute(admin, { page: 3, pageSize: 2, paging: 'prev-next' });
      expect(idsOf(prevNext)).toEqual([rows[4]!.change.state.id]);
      expect(prevNext.ok && [prevNext.value.total, prevNext.value.hasNext]).toEqual([null, false]);
      const newest = await r.list.execute(admin, { direction: 'desc', pageSize: 2 });
      expect(idsOf(newest)).toEqual([rows[4]!.change.state.id, rows[3]!.change.state.id]);
      expect(newest.ok && newest.value.nextAfterId).toBeNull();
      const beyond = await r.list.execute(admin, { page: 9, pageSize: 2 });
      expect(beyond.ok && beyond.value.items).toEqual([]);
    });

    it('keeps the keyset read of slice 2c, with the filters, never mixed with page keys', async () => {
      const r = rig();
      const rows = [1, 2, 3].map((n) => r.held(n, { reasons: ['handling'] }));
      r.held(4, { reasons: ['contact-text'] });
      const admin = adminContext();
      const first = await r.list.execute(admin, { limit: 2, reasons: 'handling' });
      expect(idsOf(first)).toEqual([rows[0]!.change.state.id, rows[1]!.change.state.id]);
      const cursor = first.ok ? first.value.nextAfterId : null;
      expect(cursor).toBe(rows[1]!.change.state.id);
      const next = await r.list.execute(admin, { limit: 2, afterId: cursor, reasons: 'handling' });
      expect(idsOf(next)).toEqual([rows[2]!.change.state.id]);
      expect(next.ok && next.value.nextAfterId).toBeNull();
      expect(await r.list.execute(admin, { limit: 2, page: 1 })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'page', code: 'conflict' }] },
      });
    });

    it('refuses a bad filter, an unknown key and a non-admin, and hides the actions without the key', async () => {
      const r = rig();
      r.held(1);
      const admin = adminContext();
      const refusals: [Record<string, unknown>, string, string][] = [
        [{ reasons: 'nope' }, 'reasons', 'value'],
        [{ reasons: [] }, 'reasons', 'type'],
        [{ sellerId: 'x' }, 'sellerId', 'format'],
        [{ categoryId: 'x' }, 'categoryId', 'format'],
        [{ submittedFrom: 'yesterday' }, 'submittedFrom', 'format'],
        [{ sort: 'risk' }, 'sort', 'value'],
        [{ pageSize: 51 }, 'pageSize', 'range'],
        [{ limit: 0 }, 'limit', 'range'],
        [{ afterId: 'x', limit: 2 }, 'afterId', 'format'],
        [{ status: 'pending' }, 'status', 'unknown'],
      ];
      for (const [input, path, fieldCode] of refusals) {
        const refused = await r.list.execute(admin, input);
        expect(!refused.ok && refused.error).toEqual({
          code: 'validation.failed',
          fields: [expect.objectContaining({ path, code: fieldCode })],
        });
      }
      expect(
        await r.list.execute(admin, { afterId: ids.next<'OfferPendingChange'>(), limit: 2 }),
      ).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'afterId', code: 'unknown' }] },
      });
      expect(await r.list.execute(sellerContext(), {})).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      r.denyApprove();
      const viewer = await r.list.execute(admin, {});
      expect(viewer.ok && viewer.value.items[0]?.actions).toEqual([]);
    });

    it('never lists a change of the other Market (canary)', async () => {
      const r = rig();
      const mine = r.held(1);
      const theirs = r.held(2, { target: otherMarket });
      expect(idsOf(await r.list.execute(adminContext(), {}))).toEqual([mine.change.state.id]);
      expect(idsOf(await r.list.execute(adminContext(otherMarket), {}))).toEqual([
        theirs.change.state.id,
      ]);
    });
  });

  describe('admin-offer-change.view', () => {
    it('reads one change with its live values, and answers not-found for the other Market', async () => {
      const r = rig();
      const a = r.held(1);
      const read = await r.view.execute(adminContext(), { changeId: a.change.state.id });
      expect(read.ok && read.value).toMatchObject({
        changeId: a.change.state.id,
        status: 'pending',
        live: { handling: 'SEALED_ORIGINAL', tagTypes: [typeCode] },
        proposedHandling: 'FRESH',
        storeName: 'Dates Co',
      });
      expect(
        await r.view.execute(adminContext(otherMarket), { changeId: a.change.state.id }),
      ).toEqual({ ok: false, error: { code: 'offer-change.not-found' } });
      expect(await r.view.execute(adminContext(), { changeId: 'x' })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'changeId', code: 'format' }] },
      });
      expect(await r.view.execute(sellerContext(), { changeId: a.change.state.id })).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    });
  });

  describe('admin-offer-changes.export', () => {
    const text = async (chunks: AsyncIterable<string | Uint8Array>) => {
      let out = '';
      for await (const chunk of chunks) {
        out += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
      }
      return out;
    };

    it('exports the filtered rows as CSV and XLSX, codes and labels only', async () => {
      const r = rig();
      const a = r.held(1, { reasons: ['handling'], name: '=cmd' });
      r.held(2, { reasons: ['contact-text'] });
      const csv = await r.exporter.execute(adminContext(), { reasons: 'handling' });
      expect(csv.ok && csv.value.filename).toBe('offer-changes-2026-11-25.csv');
      const body = csv.ok ? await text(csv.value.chunks) : '';
      const lines = body.replace('﻿', '').trim().split(/\r?\n/);
      expect(lines[0]).toBe(
        'change_id,offer_id,product_code,product_name,seller_id,store_name,seller_sku,fields,reasons,submitted_at',
      );
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain(`${a.change.state.id},${a.offer.id},P-=cmd,'=cmd,${SELLER_A}`);
      expect(lines[1]).toContain('description; handling,handling');
      // The proposed description is the seller's free text: never in the file.
      expect(body).not.toContain('0412');
      const xlsx = await r.exporter.execute(adminContext(), { format: 'xlsx' });
      expect(xlsx.ok && xlsx.value.filename).toBe('offer-changes-2026-11-25.xlsx');
      expect(xlsx.ok ? (await text(xlsx.value.chunks)).trim().split('\n') : []).toHaveLength(3);
    });

    it('refuses a bad format, an unknown key, a capped search and a seller', async () => {
      const r = rig({ capped: true });
      r.held(1);
      expect(await r.exporter.execute(adminContext(), { format: 'pdf' })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'format', code: 'value' }] },
      });
      expect(await r.exporter.execute(adminContext(), { page: 1 })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'page', code: 'unknown' }] },
      });
      expect(await r.exporter.execute(adminContext(), { q: 'dates' })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'q', code: 'too-broad' }] },
      });
      expect(await r.exporter.execute(sellerContext(), {})).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    });
  });

  describe('offer-review.stops-view', () => {
    const stopsRig = (input: {
      readonly flagged?: readonly { reviewStop: boolean; alwaysReview: boolean }[] | 'fail';
      readonly marketStop?: boolean | null;
      readonly sellers?: number | null;
    }) =>
      new OfferReviewStopsView(gate, {
        unitOfWork: {
          run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
        } as unknown as UnitOfWork,
        categoryFlags: {
          listFlagged: () =>
            input.flagged === 'fail'
              ? Promise.reject(new Error('down'))
              : Promise.resolve(
                  (input.flagged ?? []).map((flags) => ({
                    categoryId: ids.next<'Category'>(),
                    version: 1,
                    alwaysReviewChangedAt: null,
                    reviewStopChangedAt: null,
                    ...flags,
                  })),
                ),
        } as unknown as CategoryOfferReviewFlagsStore,
        stops: {
          marketStop: () =>
            Promise.resolve(input.marketStop === undefined ? false : input.marketStop),
          stoppedSellerCount: () =>
            Promise.resolve(input.sellers === undefined ? 0 : input.sellers),
        },
      });

    it('counts the stops: Market, sellers and categories (only review stops count)', async () => {
      const view = stopsRig({
        flagged: [
          { reviewStop: true, alwaysReview: false },
          { reviewStop: true, alwaysReview: true },
          { reviewStop: false, alwaysReview: true },
        ],
        marketStop: true,
        sellers: 3,
      });
      expect(await view.execute(adminContext(), {})).toEqual({
        ok: true,
        value: { marketStop: true, stoppedSellers: 3, stoppedCategories: 2, active: true },
      });
    });

    it('is inactive with no stop, and shows what it can when a part is unreadable', async () => {
      expect(await stopsRig({}).execute(adminContext(), {})).toEqual({
        ok: true,
        value: { marketStop: false, stoppedSellers: 0, stoppedCategories: 0, active: false },
      });
      expect(
        await stopsRig({ flagged: 'fail', marketStop: null, sellers: 1 }).execute(
          adminContext(),
          {},
        ),
      ).toEqual({
        ok: true,
        value: { marketStop: null, stoppedSellers: 1, stoppedCategories: null, active: true },
      });
      expect(await stopsRig({}).execute(sellerContext(), {})).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    });
  });
});
