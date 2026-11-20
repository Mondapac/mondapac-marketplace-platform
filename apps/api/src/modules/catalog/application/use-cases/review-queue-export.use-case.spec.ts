import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { SheetWriter } from '../../../../platform/list-export/sheet-writer';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import {
  REVIEW_QUEUE_MAX_PAGE,
  REVIEW_QUEUE_PAGE_MAX,
  type ReviewQueueList,
  type ReviewQueueListFailure,
  type ReviewQueueListOutput,
  type ReviewQueueRow,
} from './review-queue-list.use-case';
import { ReviewQueueExport } from './review-queue-export.use-case';

// The review queue export in memory, on both Market fixtures: it reads the queue's own use case
// page by page (so the filters and the order are the list's), writes CSV and XLSX, and refuses a
// queue longer than the pages the list reaches instead of cutting it.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const SENT = Temporal.Instant.from('2026-11-10T01:02:03Z');
const ID = (n: number) => `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const revision = (n: number, over: Partial<ReviewQueueRow> = {}): ReviewQueueRow =>
  ({
    kind: 'product-revision',
    productId: ID(0x100 + n),
    revisionId: ID(0x200 + n),
    revisionNo: 1,
    version: 1,
    sellerId: ID(0x2000),
    storeName: 'Dates Co',
    product: { productCode: `P${n}`, typeCode: 'simple', name: `Product ${n}` },
    firstPublication: true,
    reasons: ['new-product', 'photo'],
    requiredChecks: ['claims'],
    hasImages: true,
    warnings: ['gtin.duplicate'],
    submittedAt: SENT.toString(),
    actions: [],
    ...over,
  }) as ReviewQueueRow;
const offerRow = (n: number): ReviewQueueRow => ({
  kind: 'offer-first-publication',
  offerId: ID(0x300 + n),
  version: 4,
  sellerId: ID(0x2000),
  storeName: null,
  productId: ID(0x100 + n),
  product: { productCode: `P${n}`, typeCode: 'simple', name: '=cmd' },
  sellerSku: `SKU-${n}`,
  conditionCode: 'new',
  description: {},
  handling: null,
  submittedAt: SENT.toString(),
  actions: [],
});

describe.each(['AU', 'ZZ'] as const)('review queue export in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const context = (population: 'admin' | 'seller' = 'admin'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ID(0xa1) as never,
        sessionId: ID(0xa2) as never,
        sellerId: population === 'seller' ? (ID(0xa3) as never) : null,
      }),
    );
  let allow: boolean;
  let queue: ReviewQueueRow[];
  let calls: Record<string, unknown>[];
  let listFails: boolean;
  const check: AuthorisationCheck = {
    check: () =>
      Promise.resolve(
        allow ? { allowed: true } : { allowed: false, denial: { code: 'access.denied' } },
      ),
  };
  // The queue's use case, as the list answers it: the page asked, `hasNext` while rows remain.
  const reviewQueue = {
    execute: (_c: CallContext, input: Record<string, unknown>) => {
      calls.push(input);
      if (listFails) return Promise.resolve({ ok: false, error: { code: 'access.unavailable' } });
      const page = input['page'] as number;
      const size = input['pageSize'] as number;
      const items = queue.slice((page - 1) * size, page * size);
      return Promise.resolve({
        ok: true,
        value: {
          items,
          nextAfterId: null,
          page,
          pageSize: size,
          paging: 'prev-next',
          hasNext: page * size < queue.length,
          total: null,
          totals: { 'product-revision': 0, 'offer-first-publication': 0 },
        } satisfies ReviewQueueListOutput,
      } as Result<ReviewQueueListOutput, ReviewQueueListFailure>);
    },
  } as unknown as ReviewQueueList;
  const sheetWriter: SheetWriter = {
    async *xlsx(name, rows) {
      yield new TextEncoder().encode(`sheet:${name}\n`);
      for await (const row of rows) yield new TextEncoder().encode(`${row.join('|')}\n`);
    },
  };
  const useCase = () =>
    new ReviewQueueExport(createUseCaseGate(markets, check), {
      reviewQueue,
      sheetWriter,
      clock: { now: () => SENT },
    });
  const text = async (chunks: AsyncIterable<string | Uint8Array>): Promise<string> => {
    let out = '';
    for await (const chunk of chunks) {
      out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    }
    return out;
  };

  beforeEach(() => {
    allow = true;
    queue = [];
    calls = [];
    listFails = false;
  });

  it('writes both kinds as CSV with a BOM, passing the filters and order to the list', async () => {
    queue = [revision(1), offerRow(2)];
    const result = await useCase().execute(context(), { direction: 'desc', sellerId: ID(0x2000) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toEqual([
      {
        direction: 'desc',
        sellerId: ID(0x2000),
        page: 1,
        pageSize: REVIEW_QUEUE_PAGE_MAX,
        paging: 'prev-next',
      },
    ]);
    expect(result.value.filename).toBe('review-queue-2026-11-10.csv');
    const body = await text(result.value.chunks);
    expect(body.startsWith('﻿')).toBe(true);
    const lines = body.replace('﻿', '').trim().split(/\r?\n/);
    expect(lines).toEqual([
      'kind,product_code,product_name,seller_id,store_name,seller_sku,first_publication,reasons,required_checks,has_images,warnings,submitted_at',
      `product-revision,P1,Product 1,${ID(0x2000)},Dates Co,,yes,new-product; photo,claims,yes,gtin.duplicate,${SENT.toString()}`,
      `offer-first-publication,P2,'=cmd,${ID(0x2000)},,SKU-2,,,,,,${SENT.toString()}`,
    ]);
  });

  it('writes XLSX and reads every page of a long queue', async () => {
    queue = Array.from({ length: REVIEW_QUEUE_PAGE_MAX + 1 }, (_, n) => revision(n + 1));
    const result = await useCase().execute(context(), { format: 'xlsx' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toHaveLength(2);
    const lines = (await text(result.value.chunks)).trim().split('\n');
    expect(lines[0]).toBe('sheet:Review queue');
    expect(lines).toHaveLength(2 + REVIEW_QUEUE_PAGE_MAX + 1);
  });

  it('refuses the whole file when the queue is longer than the pages the list reaches', async () => {
    queue = Array.from({ length: REVIEW_QUEUE_PAGE_MAX * REVIEW_QUEUE_MAX_PAGE + 1 }, (_, n) =>
      revision(n + 1),
    );
    expect(await useCase().execute(context(), {})).toEqual({
      ok: false,
      error: { code: 'batch.too-large', max: REVIEW_QUEUE_PAGE_MAX * REVIEW_QUEUE_MAX_PAGE },
    });
    // A queue of exactly the cap is still exported.
    queue.pop();
    expect((await useCase().execute(context(), {})).ok).toBe(true);
  });

  it('refuses a bad format, an unknown or page key, a seller caller and a denied gate, and passes list failures on', async () => {
    queue = [revision(1)];
    const run = (input: Record<string, unknown>, ctx = context()) => useCase().execute(ctx, input);
    expect(await run({ format: 'pdf' })).toMatchObject({
      ok: false,
      error: { code: 'validation.failed' },
    });
    expect(await run({ page: 2 })).toMatchObject({
      ok: false,
      error: { code: 'validation.failed' },
    });
    expect(await run({ colour: 'red' })).toMatchObject({
      ok: false,
      error: { code: 'validation.failed' },
    });
    expect(await run({}, context('seller'))).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    listFails = true;
    expect(await run({})).toEqual({ ok: false, error: { code: 'access.unavailable' } });
    listFails = false;
    allow = false;
    expect(await run({})).toEqual({ ok: false, error: { code: 'access.denied' } });
  });
});
