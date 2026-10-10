import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, PendingEvent, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { fakeRunOnce } from '../../../../../test/support/fake-run-once';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import { NEW_SELLER_ADMIN_SETTINGS, type SellerFile } from '../../domain/seller-file';
import { MarketConfigSellerPolicy } from '../../infrastructure/market-config-seller-policy';
import type {
  RegisteredSellerPage,
  RegisteredSellerSource,
} from '../ports/registered-seller-source';
import type { SellerFileRepository } from '../ports/seller-file.repository';
import { BACKFILL_PAGE_SIZE, BackfillSellerFiles } from './backfill-seller-files.use-case';
import { CreateSellerFile } from './create-seller-file.use-case';
import { SellerSummariesSystem } from './seller-summaries-system.use-case';
import { SellerSummaries } from './seller-summaries.use-case';

// Sellers slice 1 in memory (sellers design 7.1, 7.5, 14.3 Q-M4; data design 3.1): the handler
// that creates a file from `identity.seller-registered.v1`, the backfill that only creates
// missing files, and `sellerSummaries` with its anonymous/system pair. Both Market fixtures (AU:
// approval required; ZZ: not). PostgreSQL behaviour is covered by test/db/sellers-files.db-spec.ts.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new MarketConfigSellerPolicy(markets);
const gate = createUseCaseGate(markets, null);
const MARKETS = [
  ['AU', true],
  ['ZZ', false],
] as const;

type RegisteredItem = { sellerId: Id<'Seller'>; origin: 'self' | 'invitation' };

interface Stored {
  readonly marketId: string;
  readonly file: SellerFile;
}

class FakeFiles implements SellerFileRepository {
  readonly stored = new Map<string, Stored>();
  /** Ids whose creation fails, for the backfill's per-seller isolation. */
  readonly failing = new Set<string>();
  reads = 0;

  addWithRoots(market: MarketContext, file: SellerFile): Promise<boolean> {
    const key = `${market.marketId}|${file.state.sellerId}`;
    if (this.failing.has(file.state.sellerId)) return Promise.reject(new Error('boom'));
    if (this.stored.has(key)) return Promise.resolve(false);
    this.stored.set(key, { marketId: market.marketId, file });
    return Promise.resolve(true);
  }

  findById(): Promise<SellerFile | null> {
    return Promise.reject(new Error('not used by slice 1'));
  }

  hold(): Promise<boolean> {
    return Promise.reject(new Error('not used here'));
  }

  recordDecision(): Promise<boolean> {
    return Promise.reject(new Error('not used here'));
  }

  staleDecisionIntents(): Promise<readonly Id<'Seller'>[]> {
    return Promise.reject(new Error('not used here'));
  }

  recordChange(): Promise<boolean> {
    return Promise.reject(new Error('not used here'));
  }

  saveDraft(): Promise<boolean> {
    return Promise.reject(new Error('not used by slice 1'));
  }

  /** Draft zones by `market|seller`, set by a test that needs a seller with a zone. */
  readonly zones = new Map<string, string>();

  draftZones(market: MarketContext, ids: readonly Id<'Seller'>[]) {
    const found = new Map<Id<'Seller'>, string>();
    for (const id of ids) {
      const zone = this.zones.get(`${market.marketId}|${id}`);
      if (zone !== undefined && this.stored.has(`${market.marketId}|${id}`)) found.set(id, zone);
    }
    return Promise.resolve<ReadonlyMap<Id<'Seller'>, string>>(found);
  }

  existingIds(market: MarketContext, ids: readonly Id<'Seller'>[]) {
    this.reads += 1;
    return Promise.resolve(
      new Set(ids.filter((id) => this.stored.has(`${market.marketId}|${id}`))),
    );
  }
}

function setUp() {
  const files = new FakeFiles();
  const clock = new FixedClock(START);
  const ids = new SequenceIdGenerator(clock);
  const events: { event: PendingEvent; causedBy: Id | undefined }[] = [];
  const outbox: OutboxWriter = {
    append: (_context, appended, causedBy) => {
      events.push(...appended.map((event) => ({ event, causedBy })));
      return Promise.resolve();
    },
  };
  const units: (UnitOfWorkOptions | undefined)[] = [];
  const unitOfWork: UnitOfWork = {
    run: <T, E>(
      _market: MarketContext,
      work: () => Promise<Result<T, E>>,
      options?: UnitOfWorkOptions,
    ) => {
      units.push(options);
      return work();
    },
    runOnce: fakeRunOnce(),
  };
  const registered: Record<string, RegisteredItem[]> = {};
  const source: RegisteredSellerSource = {
    page: (context, after, limit) => {
      const all = [...(registered[context.market.marketId] ?? [])].sort((a, b) =>
        a.sellerId < b.sellerId ? -1 : 1,
      );
      const rest = after === null ? all : all.filter((item) => item.sellerId > after);
      const items = rest.slice(0, limit);
      const page: RegisteredSellerPage = {
        items,
        next: rest.length > limit ? items[items.length - 1]!.sellerId : null,
      };
      return Promise.resolve(page);
    },
  };
  const deps = { unitOfWork, files, policy, outbox, clock };
  return {
    files,
    ids,
    events,
    units,
    registered,
    create: new CreateSellerFile(gate, deps),
    backfill: new BackfillSellerFiles(gate, { ...deps, registered: source }),
    summaries: new SellerSummaries(gate, { unitOfWork, files }),
    summariesSystem: new SellerSummariesSystem(gate, { unitOfWork, files }),
  };
}

type Setup = ReturnType<typeof setUp>;
const market = (code: string): MarketContext => testMarketContext(code, 'default');
const system = (code: string) => testCallContext(market(code), 'system');
const anonymous = (code: string) => testCallContext(market(code), 'anonymous');
const delivery = (t: Setup, subscriber = 'sellers.create-file'): EventDelivery => ({
  eventId: t.ids.next<'event'>(),
  subscriber,
  attempt: 1,
});

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterAll(() => jest.restoreAllMocks());

describe.each(MARKETS)('sellers.create-seller-file (%s; design 7.5)', (code, approvalRequired) => {
  it('creates the file with the Market policy read in the unit, and publishes ids only', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    const input = { delivery: delivery(t), sellerId, origin: 'self' as const };

    const result = await t.create.execute(system(code), input);

    expect(result).toEqual({ ok: true, value: { code: 'seller-file.created' } });
    const { file } = t.files.stored.get(`${code}|${sellerId}`)!;
    expect(file.state).toMatchObject({
      sellerId,
      marketId: code,
      origin: 'self',
      approvalRequiredAtRegistration: approvalRequired,
      draftComplete: false,
      version: 1,
      createdAt: START,
      lastChangedAt: START,
    });
    expect(t.events).toHaveLength(1);
    expect(t.events[0]!.causedBy).toBe(input.delivery.eventId);
    expect(t.events[0]!.event).toMatchObject({
      type: 'sellers.seller-file-created.v1',
      aggregateType: 'seller-file',
      aggregateId: sellerId,
      aggregateVersion: 1,
      payload: { sellerId },
    });
    expect(Object.keys(t.events[0]!.event.payload)).toEqual(['sellerId']);
  });

  it('is idempotent by the inbox: a repeated delivery creates and publishes nothing more', async () => {
    const t = setUp();
    const input = {
      delivery: delivery(t),
      sellerId: t.ids.next<'Seller'>(),
      origin: 'self' as const,
    };

    await t.create.execute(system(code), input);
    const again = await t.create.execute(system(code), input);

    expect(again).toEqual({ ok: true, value: { code: 'seller-file.already-handled' } });
    expect(t.files.stored.size).toBe(1);
    expect(t.events).toHaveLength(1);
  });

  it('is idempotent by the primary key: a file the backfill created first is left as it is', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    t.registered[code] = [{ sellerId, origin: 'invitation' }];
    await t.backfill.execute(system(code), {});

    const result = await t.create.execute(system(code), {
      delivery: delivery(t),
      sellerId,
      origin: 'self',
    });

    expect(result).toEqual({ ok: true, value: { code: 'seller-file.exists' } });
    expect(t.files.stored.get(`${code}|${sellerId}`)!.file.state.origin).toBe('invitation');
    expect(t.events).toHaveLength(1);
  });

  it('refuses every actor but the system actor', async () => {
    const t = setUp();
    const input = {
      delivery: delivery(t),
      sellerId: t.ids.next<'Seller'>(),
      origin: 'self' as const,
    };

    const result = await t.create.execute(anonymous(code), input);

    expect(result.ok).toBe(false);
    expect(t.files.stored.size).toBe(0);
  });

  it('keeps the Markets apart: the same seller id in the other Market is another file', async () => {
    const t = setUp();
    const sellerId = t.ids.next<'Seller'>();
    const other = code === 'AU' ? 'ZZ' : 'AU';

    await t.create.execute(system(code), { delivery: delivery(t), sellerId, origin: 'self' });
    await t.create.execute(system(other), { delivery: delivery(t), sellerId, origin: 'self' });

    expect([...t.files.stored.keys()].sort()).toEqual([`AU|${sellerId}`, `ZZ|${sellerId}`]);
  });
});

describe('the Market policy of sellers (design 14.1)', () => {
  it('reads each Market its own value', () => {
    expect(policy.approvalRequired(market('AU'))).toBe(true);
    expect(policy.approvalRequired(market('ZZ'))).toBe(false);
  });

  it('gives the safe value true to a Market with no sellers section, never another Market`s value', () => {
    const bare = new MarketRegistry(
      new Map(
        [...loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS)].map(([id, config]) => [
          id,
          { ...config, sellers: undefined },
        ]),
      ),
    );

    expect(new MarketConfigSellerPolicy(bare).approvalRequired(market('ZZ'))).toBe(true);
    expect(new MarketConfigSellerPolicy(bare).approvalRequired(market('AU'))).toBe(true);
  });

  it('creates nothing when the policy cannot be read: the delivery stays due', async () => {
    const t = setUp();
    const broken = new CreateSellerFile(gate, {
      unitOfWork: { run: () => Promise.reject(new Error('x')), runOnce: fakeRunOnce() },
      files: t.files,
      policy: {
        approvalRequired: () => {
          throw new Error('policy unreadable');
        },
        reservedWords: () => null,
        businessIdentifier: () => null,
      },
      outbox: { append: () => Promise.resolve() },
      clock: new FixedClock(START),
    });

    await expect(
      broken.execute(system('AU'), {
        delivery: delivery(t),
        sellerId: t.ids.next<'Seller'>(),
        origin: 'self',
      }),
    ).rejects.toThrow('policy unreadable');
    expect(t.files.stored.size).toBe(0);
  });
});

describe('the defaults of a new seller (data design 3.9)', () => {
  it('are all types allowed, category proposals off, AI off', () => {
    expect(NEW_SELLER_ADMIN_SETTINGS).toEqual({
      allProductTypesAllowed: true,
      categoryProposalsAllowed: false,
      aiEnabled: false,
    });
  });
});

describe.each(MARKETS)('sellers.backfill-seller-files (%s; design 14.3 Q-M4)', (code, required) => {
  const sellers = (t: Setup, count: number): RegisteredItem[] =>
    Array.from({ length: count }, (_, index) => ({
      sellerId: t.ids.next<'Seller'>(),
      origin: index % 2 === 0 ? 'self' : 'invitation',
    }));

  it('creates only the missing files, pages through every seller and never touches an existing one', async () => {
    const t = setUp();
    t.registered[code] = sellers(t, BACKFILL_PAGE_SIZE + 5);
    const existing = t.registered[code][3]!;
    await t.create.execute(system(code), {
      delivery: delivery(t),
      sellerId: existing.sellerId,
      origin: 'self',
    });
    const before = t.files.stored.get(`${code}|${existing.sellerId}`)!.file;

    const first = await t.backfill.execute(system(code), {});
    const second = await t.backfill.execute(system(code), {});

    expect(first).toEqual({
      ok: true,
      value: { created: BACKFILL_PAGE_SIZE + 4, existing: 1, failed: 0 },
    });
    expect(second).toEqual({
      ok: true,
      value: { created: 0, existing: BACKFILL_PAGE_SIZE + 5, failed: 0 },
    });
    expect(t.files.stored.size).toBe(BACKFILL_PAGE_SIZE + 5);
    expect(t.files.stored.get(`${code}|${existing.sellerId}`)!.file).toBe(before);
    expect(t.events).toHaveLength(BACKFILL_PAGE_SIZE + 5);
  });

  it("takes the Market's value at backfill time and the origin identity reports", async () => {
    const t = setUp();
    t.registered[code] = sellers(t, 2);

    await t.backfill.execute(system(code), {});

    for (const item of t.registered[code]) {
      expect(t.files.stored.get(`${code}|${item.sellerId}`)!.file.state).toMatchObject({
        origin: item.origin,
        approvalRequiredAtRegistration: required,
      });
    }
  });

  it('counts a seller whose file fails and goes on with the others', async () => {
    const t = setUp();
    t.registered[code] = sellers(t, 3);
    t.files.failing.add(t.registered[code][1]!.sellerId);

    const result = await t.backfill.execute(system(code), {});

    expect(result).toEqual({ ok: true, value: { created: 2, existing: 0, failed: 1 } });
    expect(t.files.stored.size).toBe(2);
  });

  it('reads one Market only and refuses a request actor', async () => {
    const t = setUp();
    const other = code === 'AU' ? 'ZZ' : 'AU';
    t.registered[other] = sellers(t, 2);
    t.registered[code] = sellers(t, 1);

    const refused = await t.backfill.execute(anonymous(code), {});
    await t.backfill.execute(system(code), {});

    expect(refused.ok).toBe(false);
    expect([...t.files.stored.keys()]).toEqual([`${code}|${t.registered[code][0]!.sellerId}`]);
  });

  it('stops on a page that does not advance', async () => {
    const t = setUp();
    const stuck = new BackfillSellerFiles(gate, {
      unitOfWork: { run: (_m, work) => work(), runOnce: fakeRunOnce() },
      files: t.files,
      policy,
      outbox: { append: () => Promise.resolve() },
      clock: new FixedClock(START),
      registered: {
        page: (_context, after) =>
          Promise.resolve({ items: [], next: after ?? t.ids.next<'Seller'>() }),
      },
    });

    await expect(stuck.execute(system(code), {})).resolves.toEqual({
      ok: true,
      value: { created: 0, existing: 0, failed: 0 },
    });
  });
});

describe.each(MARKETS)('sellers.seller-summaries (%s; design 7.1)', (code) => {
  async function withFiles(t: Setup, count: number) {
    const created: Id<'Seller'>[] = [];
    for (let index = 0; index < count; index += 1) {
      const sellerId = t.ids.next<'Seller'>();
      created.push(sellerId);
      await t.create.execute(system(code), { delivery: delivery(t), sellerId, origin: 'self' });
    }
    return created;
  }

  it('answers one entry per distinct id in first-occurrence order, the same to both callers', async () => {
    const t = setUp();
    const [a, b] = await withFiles(t, 2);
    const unknown = t.ids.next<'Seller'>();
    const request = [b!, unknown, a!, b!];

    const anonymousAnswer = await t.summaries.execute(anonymous(code), { sellerIds: request });
    const systemAnswer = await t.summariesSystem.execute(system(code), { sellerIds: request });

    const expected = [
      { sellerId: b, exists: true },
      { sellerId: unknown, exists: false },
      { sellerId: a, exists: true },
    ];
    expect(anonymousAnswer).toEqual({ ok: true, value: expected });
    expect(JSON.stringify(systemAnswer)).toBe(JSON.stringify(anonymousAnswer));
  });

  it('gives the draft zone, provisional, to the system pair only (Hassan L4)', async () => {
    const t = setUp();
    const [a, b] = await withFiles(t, 2);
    const unknown = t.ids.next<'Seller'>();
    t.files.zones.set(`${code}|${a}`, 'Pacific/Auckland');
    const request = [a!, b!, unknown];

    const asSystem = await t.summariesSystem.execute(system(code), { sellerIds: request });
    const asRequest = await t.summaries.execute(anonymous(code), { sellerIds: request });

    expect(asSystem).toEqual({
      ok: true,
      value: [
        {
          sellerId: a,
          exists: true,
          operatingTimezone: { zone: 'Pacific/Auckland', provisional: true },
        },
        { sellerId: b, exists: true },
        { sellerId: unknown, exists: false },
      ],
    });
    expect(asRequest).toEqual({
      ok: true,
      value: [
        { sellerId: a, exists: true },
        { sellerId: b, exists: true },
        { sellerId: unknown, exists: false },
      ],
    });
  });

  it('never gives a zone of the other Market, even to the system pair', async () => {
    const t = setUp();
    const other = code === 'AU' ? 'ZZ' : 'AU';
    const sellerId = t.ids.next<'Seller'>();
    await t.create.execute(system(other), { delivery: delivery(t), sellerId, origin: 'self' });
    t.files.zones.set(`${other}|${sellerId}`, 'Asia/Tokyo');

    const result = await t.summariesSystem.execute(system(code), { sellerIds: [sellerId] });

    expect(result).toEqual({ ok: true, value: [{ sellerId, exists: false }] });
  });

  it('answers an id of the other Market exactly as an unknown id, and reads read-only', async () => {
    const t = setUp();
    const other = code === 'AU' ? 'ZZ' : 'AU';
    const sellerId = t.ids.next<'Seller'>();
    await t.create.execute(system(other), { delivery: delivery(t), sellerId, origin: 'self' });
    const never = t.ids.next<'Seller'>();

    const result = await t.summaries.execute(anonymous(code), { sellerIds: [sellerId, never] });

    expect(result).toEqual({
      ok: true,
      value: [
        { sellerId, exists: false },
        { sellerId: never, exists: false },
      ],
    });
    expect(t.units.at(-1)).toEqual({ readOnly: true });
  });

  it('accepts exactly 100 ids, the upper bound', async () => {
    const t = setUp();
    const known = t.ids.next<'Seller'>();

    const result = await t.summaries.execute(anonymous(code), {
      sellerIds: [known, ...Array.from({ length: 99 }, () => t.ids.next<'Seller'>())],
    });

    expect(result.ok).toBe(true);
  });

  it('answers an empty list without reading', async () => {
    const t = setUp();

    const result = await t.summaries.execute(anonymous(code), { sellerIds: [] });

    expect(result).toEqual({ ok: true, value: [] });
    expect(t.files.reads).toBe(0);
  });

  it.each([
    [
      'more than 100 ids',
      () => Array.from({ length: 101 }, () => '0190b1c2-0000-7000-8000-000000000001'),
      'length',
    ],
    ['a malformed id', () => ['not-an-id'], 'format'],
    ['an id that is not a string', () => [42 as unknown as string], 'format'],
  ])('refuses %s whole, before any read', async (_name, build, fieldCode) => {
    const t = setUp();

    const result = await t.summaries.execute(anonymous(code), { sellerIds: build() });

    expect(result).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'sellerIds', code: fieldCode }] },
    });
    expect(t.files.reads).toBe(0);
  });

  it('is unavailable, never an empty answer, when the read fails', async () => {
    const t = setUp();
    const failing = new SellerSummaries(gate, {
      unitOfWork: { run: () => Promise.reject(new Error('db down')), runOnce: fakeRunOnce() },
      files: t.files,
    });

    const result = await failing.execute(anonymous(code), { sellerIds: [t.ids.next<'Seller'>()] });

    expect(result).toEqual({ ok: false, error: { code: 'sellers.unavailable' } });
  });

  it('refuses the system pair to a request actor', async () => {
    const t = setUp();

    const result = await t.summariesSystem.execute(anonymous(code), { sellerIds: [] });

    expect(result.ok).toBe(false);
  });
});
