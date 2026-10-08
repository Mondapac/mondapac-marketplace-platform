import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { SaveWorkingCopy } from '../../src/modules/catalog/application/working-copy/save-working-copy.service';
import type { RateCounter } from '../../src/modules/catalog/application/ports/rate-counter.repository';
import { Product } from '../../src/modules/catalog/domain/product';
import { configurableProductType } from '../../src/modules/catalog/domain/product-types/configurable';
import {
  DRAFT_SAVE_LIMITS,
  RATE_COUNTER_KINDS,
  rateVerdict,
} from '../../src/modules/catalog/domain/rate-limits';
import { HmacRateCounterKeys } from '../../src/modules/catalog/infrastructure/hmac-rate-counter-keys';
import { PrismaProductRepository } from '../../src/modules/catalog/infrastructure/prisma-product.repository';
import { PrismaRateCounterRepository } from '../../src/modules/catalog/infrastructure/prisma-rate-counter.repository';
import { PrismaWorkingCopyRepository } from '../../src/modules/catalog/infrastructure/prisma-working-copy.repository';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// Catalog slice 4c-3 on PostgreSQL (catalog data design 3.6 and 3.26), for both Market fixtures:
// the working-copy store, the rate-counter store and the SaveWorkingCopy service end to end
// (events appended in the unit, a rate-limited account, ownership, the Market boundary).

const T0 = Temporal.Instant.from('2026-10-08T00:00:00Z');
const clock = new FixedClock(T0);
// One generator for both Market fixtures: variant ids are unique across Markets.
const ids = new SequenceIdGenerator(clock);
let sequence = 0;
const uuid7 = (): string =>
  uuidV7(Date.now() + sequence++, crypto.getRandomValues(new Uint8Array(10)));

describe.each(TEST_MARKETS)(
  'catalog working copies in market %s (database integration)',
  (code) => {
    const market = marketOf(code);
    const other = marketOf(otherMarketOf(code));
    let persistence: Persistence;
    let products: PrismaProductRepository;
    let copies: PrismaWorkingCopyRepository;
    let counters: PrismaRateCounterRepository;
    let owner: Client;
    let appended: { type: string; aggregateVersion: number }[];
    let service: SaveWorkingCopy;

    beforeAll(async () => {
      persistence = createPersistence();
      products = new PrismaProductRepository(persistence.service);
      copies = new PrismaWorkingCopyRepository(persistence.service);
      counters = new PrismaRateCounterRepository(persistence.service);
      owner = new Client({ connectionString: ownerTestDatabaseUrl() });
      await owner.connect();
      service = new SaveWorkingCopy({
        unitOfWork: persistence.unitOfWork,
        products,
        workingCopies: copies,
        counters,
        counterKeys: new HmacRateCounterKeys(new Uint8Array(32).fill(9)),
        policy: {
          taxCategoryCodes: () => [],
          locales: () => ({ default: 'en', supported: ['en'] }),
          sensitiveChanges: () => {
            throw new Error('not used');
          },
          maxVariantsPerProduct: () => 3,
          approvalRequired: () => Promise.resolve(true),
        },
        outbox: {
          append: (_context, events) => {
            appended.push(
              ...events.map((event) => ({
                type: event.type,
                aggregateVersion: event.aggregateVersion,
              })),
            );
            return Promise.resolve();
          },
        },
        clock,
        ids,
      });
    });
    beforeEach(() => {
      appended = [];
    });
    afterAll(async () => {
      await owner.end();
      await persistence.close();
    });

    const inUnit = <T>(work: () => Promise<T>, target = market): Promise<T> =>
      persistence.unitOfWork
        .run(target, async () => ({ ok: true as const, value: await work() }))
        .then((result) => {
          if (!result.ok) throw new Error('unit failed');
          return result.value;
        });

    async function storedProduct(sellerId: Id<'Seller'>, target = market): Promise<Product> {
      const created = Product.create({
        id: uuid7() as Id<'Product'>,
        marketId: target.marketId,
        scope: 'SELLER',
        sellerId,
        handler: configurableProductType,
        familyCode: 'default',
        productCode: await inUnit(() => products.nextProductCode(target), target),
        variantId: null,
        now: T0,
      });
      if (!created.ok) throw new Error(created.error.code);
      await inUnit(() => products.add(target, created.value), target);
      return created.value;
    }

    const sellerContext = (sellerId: Id<'Seller'>, target = market): CallContext =>
      testCallContext(
        target,
        testAuthenticatedActor(target, {
          population: 'seller',
          accountId: uuid7() as Id<'Account'>,
          sessionId: uuid7() as Id<'Session'>,
          sellerId,
        }),
      );

    describe('the working-copy store', () => {
      it('round-trips a draft and saves over the previous one', async () => {
        const sellerId = uuid7() as Id<'Seller'>;
        const product = await storedProduct(sellerId);
        const account = uuid7() as Id<'Account'>;
        const first = {
          productId: product.state.id,
          content: { texts: { en: { name: 'Dates' } } },
          contentSchemaVersion: 1,
          baseRevisionId: null,
          lastSavedAt: T0,
          lastSavedByAccountId: account,
        };
        await inUnit(() => copies.save(market, first));
        expect(await inUnit(() => copies.find(market, product.state.id))).toEqual(first);

        const second = { ...first, content: { n: 2 }, lastSavedAt: T0.add({ minutes: 5 }) };
        await inUnit(() => copies.save(market, second));
        expect(await inUnit(() => copies.find(market, product.state.id))).toEqual(second);
        const { rows } = await owner.query(
          'SELECT count(*)::int AS n FROM catalog.product_working_copies WHERE product_id = $1',
          [product.state.id],
        );
        expect((rows[0] as { n: number }).n).toBe(1);
      });

      it('does not find a working copy through another Market', async () => {
        const product = await storedProduct(uuid7() as Id<'Seller'>);
        await inUnit(() =>
          copies.save(market, {
            productId: product.state.id,
            content: {},
            contentSchemaVersion: 1,
            baseRevisionId: null,
            lastSavedAt: T0,
            lastSavedByAccountId: uuid7() as Id<'Account'>,
          }),
        );
        expect(await inUnit(() => copies.find(other, product.state.id), other)).toBeNull();
      });

      it('refuses a draft whose product does not exist in the Market', async () => {
        await expect(
          inUnit(() =>
            copies.save(market, {
              productId: uuid7() as Id<'Product'>,
              content: {},
              contentSchemaVersion: 1,
              baseRevisionId: null,
              lastSavedAt: T0,
              lastSavedByAccountId: uuid7() as Id<'Account'>,
            }),
          ),
        ).rejects.toThrow();
      });
    });

    describe('the rate-counter store', () => {
      const keys = new HmacRateCounterKeys(new Uint8Array(32).fill(3));
      const counterFor = (subject: string): RateCounter[] =>
        DRAFT_SAVE_LIMITS.map((limit) => ({
          limit,
          keyHash: keys.keyOf(market, limit.kind, subject),
        }));

      it('counts every attempt and refuses after the limit, restarting an ended window', async () => {
        const subject = uuid7();
        let last = await inUnit(() => counters.reserve(market, counterFor(subject), T0));
        for (let attempt = 1; attempt < 61; attempt += 1) {
          last = await inUnit(() => counters.reserve(market, counterFor(subject), T0));
        }
        expect(last.map((reservation) => reservation.count)).toEqual([61, 61]);
        expect(rateVerdict(DRAFT_SAVE_LIMITS, last, T0)).toEqual({
          allowed: false,
          retryAfterSeconds: 60,
        });
        const later = await inUnit(() =>
          counters.reserve(market, counterFor(subject), T0.add({ minutes: 1 })),
        );
        expect(later.find((r) => r.kind === 'draft-save.account.minute')?.count).toBe(1);
        expect(later.find((r) => r.kind === 'draft-save.account.day')?.count).toBe(62);
      });

      it('restarts a window at exactly its length and not a second before', async () => {
        const subject = uuid7();
        await inUnit(() => counters.reserve(market, counterFor(subject), T0));
        const before = await inUnit(() =>
          counters.reserve(market, counterFor(subject), T0.add({ seconds: 59 })),
        );
        expect(before.find((r) => r.kind === 'draft-save.account.minute')?.count).toBe(2);
        const at = await inUnit(() =>
          counters.reserve(market, counterFor(subject), T0.add({ seconds: 60 })),
        );
        expect(at.find((r) => r.kind === 'draft-save.account.minute')?.count).toBe(1);
      });

      it('keeps two accounts apart', async () => {
        const a = uuid7();
        const b = uuid7();
        for (let n = 0; n < 3; n += 1)
          await inUnit(() => counters.reserve(market, counterFor(a), T0));
        const first = await inUnit(() => counters.reserve(market, counterFor(b), T0));
        expect(first[0]!.count).toBe(1);
      });

      it('lists exactly the kinds its CHECK accepts', async () => {
        const { rows } = await owner.query(
          "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'rate_counters_kind_check' AND conrelid = 'catalog.rate_counters'::regclass",
        );
        const def = (rows[0] as { def: string }).def;
        const inCheck = [...def.matchAll(/'([a-z.-]+)'::text/g)].map((m) => m[1]).sort();
        expect(inCheck).toEqual([...RATE_COUNTER_KINDS]);
      });

      it('counts concurrent attempts exactly once each', async () => {
        const subject = uuid7();
        await Promise.all(
          Array.from({ length: 10 }, () =>
            inUnit(() => counters.reserve(market, counterFor(subject), T0)),
          ),
        );
        const after = await inUnit(() => counters.reserve(market, counterFor(subject), T0));
        expect(after[0]!.count).toBe(11);
      });

      it('keeps Markets apart and purges only old windows of the Market', async () => {
        const subject = uuid7();
        await inUnit(() => counters.reserve(market, counterFor(subject), T0));
        const otherKeys = DRAFT_SAVE_LIMITS.map((limit) => ({
          limit,
          keyHash: keys.keyOf(other, limit.kind, subject),
        }));
        const inOther = await inUnit(() => counters.reserve(other, otherKeys, T0), other);
        expect(inOther[0]!.count).toBe(1);
        const purged = await inUnit(() =>
          counters.purgeStartedBefore(market, T0.add({ hours: 48 })),
        );
        expect(purged).toBeGreaterThan(0);
        const { rows } = await owner.query(
          'SELECT count(*)::int AS n FROM catalog.rate_counters WHERE market_id = $1',
          [other.marketId],
        );
        expect((rows[0] as { n: number }).n).toBeGreaterThan(0);
      });

      it('refuses a kind outside the table before touching it', async () => {
        await expect(
          inUnit(() =>
            counters.reserve(
              market,
              [
                {
                  limit: { kind: 'made-up' as never, limit: 1, windowMinutes: 1 },
                  keyHash: new Uint8Array(32),
                },
              ],
              T0,
            ),
          ),
        ).rejects.toThrow(TypeError);
      });
    });

    describe('SaveWorkingCopy end to end', () => {
      it('stores the draft, mints variants and appends their events with versions in order', async () => {
        const sellerId = uuid7() as Id<'Seller'>;
        const product = await storedProduct(sellerId);

        const saved = await service.execute(sellerContext(sellerId), {
          productId: product.state.id,
          content: { texts: { en: { name: 'Dates' } } },
          variantIds: [null, null],
        });

        expect(saved.ok).toBe(true);
        const variantIds = saved.ok ? saved.value.variantIds : [];
        expect(variantIds).toHaveLength(2);
        expect(appended.map((event) => event.type)).toEqual([
          'catalog.variant-added.v1',
          'catalog.variant-added.v1',
        ]);
        expect(appended.map((event) => event.aggregateVersion)).toEqual([2, 3]);
        const reloaded = await inUnit(() => products.findById(market, product.state.id));
        expect(reloaded?.liveVariants.map((variant) => variant.id)).toEqual(variantIds);
        const draft = await inUnit(() => copies.find(market, product.state.id));
        expect(draft?.content).toEqual({ texts: { en: { name: 'Dates' } } });
      });

      it('retires a deleted proposed variant in the same unit as the save', async () => {
        const sellerId = uuid7() as Id<'Seller'>;
        const product = await storedProduct(sellerId);
        const context = sellerContext(sellerId);
        const first = await service.execute(context, {
          productId: product.state.id,
          content: {},
          variantIds: [null, null],
        });
        if (!first.ok) throw new Error(first.error.code);
        appended = [];
        const [keep] = first.value.variantIds;

        const second = await service.execute(context, {
          productId: product.state.id,
          content: { n: 2 },
          variantIds: [keep!],
        });

        expect(second.ok).toBe(true);
        expect(appended.map((event) => event.type)).toEqual(['catalog.variant-removed.v1']);
        const { rows } = await owner.query(
          "SELECT count(*)::int AS n FROM catalog.product_variants WHERE product_id = $1 AND state = 'retired'",
          [product.state.id],
        );
        expect((rows[0] as { n: number }).n).toBe(1);
      });

      it('answers a byte-identical not-found for another seller’s product and an unknown id', async () => {
        const product = await storedProduct(uuid7() as Id<'Seller'>);
        const foreign = await service.execute(sellerContext(uuid7() as Id<'Seller'>), {
          productId: product.state.id,
          content: {},
          variantIds: [],
        });
        const unknown = await service.execute(sellerContext(uuid7() as Id<'Seller'>), {
          productId: uuid7() as Id<'Product'>,
          content: {},
          variantIds: [],
        });
        expect(foreign).toEqual({ ok: false, error: { code: 'product.not-found' } });
        expect(unknown).toEqual(foreign);
        expect(await inUnit(() => copies.find(market, product.state.id))).toBeNull();
      });

      it('rolls back the draft and the variants together when the outbox refuses', async () => {
        const sellerId = uuid7() as Id<'Seller'>;
        const product = await storedProduct(sellerId);
        const failing = new SaveWorkingCopy({
          unitOfWork: persistence.unitOfWork,
          products,
          workingCopies: copies,
          counters,
          counterKeys: new HmacRateCounterKeys(new Uint8Array(32).fill(9)),
          policy: {
            taxCategoryCodes: () => [],
            locales: () => ({ default: 'en', supported: ['en'] }),
            sensitiveChanges: () => {
              throw new Error('not used');
            },
            maxVariantsPerProduct: () => 3,
            approvalRequired: () => Promise.resolve(true),
          },
          outbox: { append: () => Promise.reject(new Error('outbox down')) },
          clock,
          ids,
        });
        await expect(
          failing.execute(sellerContext(sellerId), {
            productId: product.state.id,
            content: { a: 1 },
            variantIds: [null],
          }),
        ).rejects.toThrow('outbox down');
        expect(await inUnit(() => copies.find(market, product.state.id))).toBeNull();
        const reloaded = await inUnit(() => products.findById(market, product.state.id));
        expect(reloaded?.liveVariants).toHaveLength(0);
      });

      it('refuses a NUL character in the content before the database sees it', async () => {
        const sellerId = uuid7() as Id<'Seller'>;
        const product = await storedProduct(sellerId);
        const refused = await service.execute(sellerContext(sellerId), {
          productId: product.state.id,
          content: { a: 'x\u0000y' },
          variantIds: [],
        });
        expect(refused).toEqual({ ok: false, error: { code: 'working-copy.invalid-content' } });
        expect(await inUnit(() => copies.find(market, product.state.id))).toBeNull();
      });

      it('answers conflict.stale to a save that read an older product and writes no draft', async () => {
        const sellerId = uuid7() as Id<'Seller'>;
        const product = await storedProduct(sellerId);
        // The loser reads version 1, then another save moves the product to version 2 before it writes.
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const slowProducts = {
          ...products,
          nextProductCode: products.nextProductCode.bind(products),
          add: products.add.bind(products),
          findById: async (target: typeof market, id: Id<'Product'>) => {
            const loaded = await products.findById(target, id);
            await held;
            return loaded;
          },
          save: products.save.bind(products),
        };
        const slow = new SaveWorkingCopy({
          unitOfWork: persistence.unitOfWork,
          products: slowProducts,
          workingCopies: copies,
          counters,
          counterKeys: new HmacRateCounterKeys(new Uint8Array(32).fill(9)),
          policy: {
            taxCategoryCodes: () => [],
            locales: () => ({ default: 'en', supported: ['en'] }),
            sensitiveChanges: () => {
              throw new Error('not used');
            },
            maxVariantsPerProduct: () => 3,
            approvalRequired: () => Promise.resolve(true),
          },
          outbox: { append: () => Promise.resolve() },
          clock,
          ids,
        });
        const loser = slow.execute(sellerContext(sellerId), {
          productId: product.state.id,
          content: { who: 'loser' },
          variantIds: [null],
        });
        const winner = await service.execute(sellerContext(sellerId), {
          productId: product.state.id,
          content: { who: 'winner' },
          variantIds: [null],
        });
        expect(winner.ok).toBe(true);
        release();
        expect(await loser).toEqual({ ok: false, error: { code: 'conflict.stale' } });
        const draft = await inUnit(() => copies.find(market, product.state.id));
        expect(draft?.content).toEqual({ who: 'winner' });
      });

      it('throttles an account after 60 saves in a minute', async () => {
        const sellerId = uuid7() as Id<'Seller'>;
        const product = await storedProduct(sellerId);
        const context = sellerContext(sellerId);
        let last;
        for (let attempt = 0; attempt < 61; attempt += 1) {
          last = await service.execute(context, {
            productId: product.state.id,
            content: { attempt },
            variantIds: [],
          });
        }
        expect(last).toEqual({
          ok: false,
          error: { code: 'request.throttled', retryAfterSeconds: 60 },
        });
      });
    });
  },
);
