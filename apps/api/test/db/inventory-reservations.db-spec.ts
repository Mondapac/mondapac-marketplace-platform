import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { StockRepository } from '../../src/modules/inventory/application/ports/stock.repository';
import type { ReserveRequest } from '../../src/modules/inventory/contracts/ordering-port';
import { ExpireReservations } from '../../src/modules/inventory/application/use-cases/expire-reservations.use-case';
import { ReleaseOwnReservation } from '../../src/modules/inventory/application/use-cases/release-own-reservation.use-case';
import { ReleaseReservation } from '../../src/modules/inventory/application/use-cases/release-reservation.use-case';
import { Reserve } from '../../src/modules/inventory/application/use-cases/reserve.use-case';
import { CancelCommittedLine } from '../../src/modules/inventory/application/use-cases/cancel-committed-line.use-case';
import { CommitReservation } from '../../src/modules/inventory/application/use-cases/commit-reservation.use-case';
import { PruneReservations } from '../../src/modules/inventory/application/use-cases/prune-reservations.use-case';
import { RecordShipment } from '../../src/modules/inventory/application/use-cases/record-shipment.use-case';
import { HmacRateCounterKeys } from '../../src/modules/inventory/infrastructure/hmac-rate-counter-keys';
import { PrismaRateCounterRepository } from '../../src/modules/inventory/infrastructure/prisma-rate-counter.repository';
import { SetStockLevel } from '../../src/modules/inventory/application/use-cases/set-stock-level.use-case';
import { INVENTORY_EVENTS } from '../../src/modules/inventory/domain/events';
import { ConfigInventoryPolicyProvider } from '../../src/modules/inventory/infrastructure/config-inventory-policy-provider';
import { PrismaAvailabilityReader } from '../../src/modules/inventory/infrastructure/prisma-availability.reader';
import { PrismaAvailabilitySignalRepository } from '../../src/modules/inventory/infrastructure/prisma-availability-signal.repository';
import { PrismaReservationRepository } from '../../src/modules/inventory/infrastructure/prisma-reservation.repository';
import { PrismaSellerInventoryRepository } from '../../src/modules/inventory/infrastructure/prisma-seller-inventory.repository';
import { PrismaStockRepository } from '../../src/modules/inventory/infrastructure/prisma-stock.repository';
import type { OfferSellUnitsSource } from '../../src/modules/inventory/application/ports/offer-sell-units';
import type { AuthorisationCheck } from '../../src/platform/authz';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { EventCatalogue } from '../../src/platform/events/event-catalogue';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
  testMarketId,
} from '../support/test-config';
import { createPersistence, marketOf, modelMap, type Persistence } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Inventory slice 4 on PostgreSQL (inventory design 3.1, 4.2, 4.3, 5.1; data design 3.6 to 3.8,
// 4.3, 4.4), for both Market fixtures, as the application role: the real repositories, the real
// `inventory.lock-stock-items` statement, the real unit of work and the outbox writer. The
// concurrency tests run parallel reservers on one sell unit (never oversold) and carts that cross
// two sellers in opposite order (no deadlock, no lock timeout). Every row has fresh ids, so the
// other files sharing the run database are not affected.

const T0 = Temporal.Instant.from('2026-10-09T01:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };

type ReserveAnswer = Awaited<ReturnType<Reserve['execute']>>;

describe.each(TEST_MARKETS)('inventory reservations in market %s (database)', (code) => {
  const market = marketOf(code);
  const config = markets.get(testMarketId(code)).inventory!;
  const minutes = config.reservationMinutes;
  const threshold = config.defaultLowStockThreshold;
  const high = threshold + 30;
  const ids = new UuidV7IdGenerator(new FixedClock(T0));
  const clock = new FixedClock(T0);
  let db: Persistence;
  let sql: Client;
  let reserve: Reserve;
  let releaseOwn: ReleaseOwnReservation;
  let release: ReleaseReservation;
  let expire: ExpireReservations;
  let commit: CommitReservation;
  let cancelLine: CancelCommittedLine;
  let ship: RecordShipment;
  let prune: PruneReservations;
  let setStockLevel: SetStockLevel;
  let reader: PrismaAvailabilityReader;
  const catalogOffers = new Map<
    Id<'Offer'>,
    { sellerId: Id<'Seller'>; variantId: Id<'Variant'> }
  >();

  beforeAll(async () => {
    db = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    const catalogue = new EventCatalogue();
    catalogue.register('inventory', INVENTORY_EVENTS);
    catalogue.seal();
    const gate = createUseCaseGate(markets, admitAll);
    const common = {
      unitOfWork: db.unitOfWork,
      reservations: new PrismaReservationRepository(db.service),
      inventories: new PrismaSellerInventoryRepository(db.service),
      policies: new ConfigInventoryPolicyProvider(markets),
      signals: new PrismaAvailabilitySignalRepository(db.service),
      outbox: new PrismaOutboxWriterFactory(
        modelMap,
        db.service,
        catalogue,
        ids,
        NO_PERMISSION_KEYS,
      ).forModule('inventory'),
      counters: new PrismaRateCounterRepository(db.service),
      counterKeys: new HmacRateCounterKeys(new Uint8Array(32).fill(9)),
      stock: new PrismaStockRepository(db.service),
      ids,
      clock,
    };
    reserve = new Reserve(gate, common);
    commit = new CommitReservation(gate, common);
    cancelLine = new CancelCommittedLine(gate, common);
    ship = new RecordShipment(gate, common);
    prune = new PruneReservations(gate, common);
    releaseOwn = new ReleaseOwnReservation(gate, common);
    release = new ReleaseReservation(gate, common);
    expire = new ExpireReservations(gate, common);
    const offers: OfferSellUnitsSource = {
      sellUnitsOf: (_c, offerIds) =>
        Promise.resolve(
          new Map(
            offerIds.flatMap((id) => {
              const offer = catalogOffers.get(id);
              return offer === undefined
                ? []
                : [
                    [
                      id,
                      {
                        sellerId: offer.sellerId,
                        deleted: false,
                        productId: ids.next<'Product'>(),
                        sellUnitVariantIds: new Set([offer.variantId]),
                      },
                    ] as const,
                  ];
            }),
          ),
        ),
    };
    setStockLevel = new SetStockLevel(gate, {
      unitOfWork: db.unitOfWork,
      inventories: common.inventories,
      stock: new PrismaStockRepository(db.service),
      signals: common.signals,
      offers,
      policies: common.policies,
      outbox: common.outbox,
      ids,
      clock,
    });
    reader = new PrismaAvailabilityReader(db.service);
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });

  const rows = async (text: string, params: unknown[] = []) =>
    (await sql.query<Record<string, unknown>>(text, params)).rows;

  const customer = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );

  /**
   * A seller with a seller inventory, two sources (priority 1, 2) and one sell unit per entry of
   * `stock` (on hand in source 1 and source 2; null means no item in that source).
   */
  async function seller(stock: readonly (readonly [number | null, number | null])[]) {
    const sellerId = ids.next<'Seller'>();
    const inventoryId = ids.next<'SellerInventory'>();
    const sourceIds = [ids.next<'InventorySource'>(), ids.next<'InventorySource'>()] as const;
    await sql.query(
      `INSERT INTO inventory.seller_inventories (id, market_id, tenant_id, seller_id, version, created_at)
       VALUES ($1, $2, $3, $4, 1, $5)`,
      [inventoryId, code, market.tenantId, sellerId, new Date(T0.epochMilliseconds)],
    );
    for (const [at, sourceId] of sourceIds.entries()) {
      await sql.query(
        `INSERT INTO inventory.sources (id, market_id, tenant_id, seller_id, name, is_default, priority, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          sourceId,
          code,
          market.tenantId,
          sellerId,
          `Source ${at + 1}`,
          at === 0,
          at + 1,
          new Date(T0.epochMilliseconds),
        ],
      );
    }
    const units = [];
    for (const levels of stock) {
      const offerId = ids.next<'Offer'>();
      const variantId = ids.next<'Variant'>();
      catalogOffers.set(offerId, { sellerId, variantId });
      const items: Id<'StockItem'>[] = [];
      for (const [at, onHand] of levels.entries()) {
        const itemId = ids.next<'StockItem'>();
        items.push(itemId);
        if (onHand === null) continue;
        await sql.query(
          `INSERT INTO inventory.stock_items (id, market_id, tenant_id, offer_id, variant_id, source_id, seller_id, on_hand, version, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9)`,
          [
            itemId,
            code,
            market.tenantId,
            offerId,
            variantId,
            sourceIds[at],
            sellerId,
            onHand,
            new Date(T0.epochMilliseconds),
          ],
        );
      }
      units.push({ offerId, variantId, items });
    }
    return { sellerId, sourceIds, units };
  }
  type Unit = Awaited<ReturnType<typeof seller>>['units'][number];

  const cart = (lines: readonly Unit[], quantity = 1, checkoutRef = ids.next<'Checkout'>()) =>
    ({
      checkoutRef,
      lines: lines.map(({ offerId, variantId }) => ({ offerId, variantId, quantity })),
    }) satisfies ReserveRequest;

  /** What a real caller does with `409 conflict.retry`: ask again. Counts the retries it needed. */
  async function reserving(context: CallContext, request: ReserveRequest) {
    let retries = 0;
    for (;;) {
      const answer = await reserve.execute(context, request);
      if (answer.ok || answer.error.code !== 'conflict.retry' || retries >= 20) {
        return { answer, retries };
      }
      retries += 1;
    }
  }

  const reservationsOf = (holder: string) =>
    rows(
      `SELECT id, status, release_cause, checkout_ref, expires_at, created_at, version, tenant_id
         FROM inventory.reservations WHERE market_id = $1 AND holder_account_id = $2
        ORDER BY created_at, id`,
      [code, holder],
    );
  const linesOf = (reservationId: string) =>
    rows(
      `SELECT stock_item_id, quantity, state, expires_at, offer_id, variant_id
         FROM inventory.reservation_lines WHERE market_id = $1 AND reservation_id = $2 ORDER BY id`,
      [code, reservationId],
    );
  const heldOn = async (itemIds: readonly string[], at = clock.now()) => {
    const held = await db.unitOfWork.run(market, async () => {
      return ok(
        await new PrismaReservationRepository(db.service).heldQuantities(
          market,
          itemIds as Id<'StockItem'>[],
          at,
        ),
      );
    });
    if (!held.ok) throw new Error('held');
    return itemIds.map((id) => held.value.get(id as Id<'StockItem'>) ?? 0);
  };

  it('holds a cart on the first source in priority order and stores the Market, tenant and expiry', async () => {
    const s = await seller([[high, high]]);
    const who = customer();

    const result = await reserve.execute(who, cart(s.units, 2));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [stored] = await reservationsOf(
      who.actor.kind === 'authenticated' ? who.actor.accountId : '',
    );
    expect(stored).toMatchObject({
      status: 'active',
      release_cause: null,
      tenant_id: market.tenantId,
    });
    expect(new Date(stored!.expires_at as Date).getTime() - clock.now().epochMilliseconds).toBe(
      minutes * 60_000,
    );
    expect(await linesOf(result.value.reservationId)).toEqual([
      expect.objectContaining({
        stock_item_id: s.units[0]!.items[0],
        quantity: 2,
        state: 'active',
      }),
    ]);
    expect(await heldOn(s.units[0]!.items)).toEqual([2, 0]);
  });

  it('never splits a line and falls through to the next source that fits whole (AC 2)', async () => {
    const s = await seller([[2, high]]);

    const result = await reserve.execute(customer(), cart(s.units, 3));

    expect(result.ok).toBe(true);
    expect(await heldOn(s.units[0]!.items)).toEqual([0, 3]);
  });

  describe('concurrency (inventory design 4.2, 4.3; AC 1)', () => {
    it('never oversells: N parallel reservers of the last units get exactly the stock', async () => {
      const stock = 5;
      const s = await seller([[stock, null]]);
      const reservers = 10;

      const answers = await Promise.all(
        Array.from({ length: reservers }, () => reserving(customer(), cart(s.units, 1))),
      );

      const won = answers.filter((a) => a.answer.ok).length;
      const refused = answers.filter(
        (a) => !a.answer.ok && a.answer.error.code === 'inventory.insufficient',
      ).length;
      expect(won).toBe(stock);
      expect(refused).toBe(reservers - stock);
      expect(await heldOn(s.units[0]!.items)).toEqual([stock, 0]);
      const [{ held }] = (await rows(
        `SELECT COALESCE(SUM(quantity), 0)::int AS held FROM inventory.reservation_lines
          WHERE market_id = $1 AND stock_item_id = $2 AND state = 'active'`,
        [code, s.units[0]!.items[0]],
      )) as [{ held: number }];
      expect(held).toBeLessThanOrEqual(stock);
    });

    it('gives the last unit to exactly one of two buyers (AC 1)', async () => {
      const s = await seller([[1, null]]);

      const answers = await Promise.all([
        reserving(customer(), cart(s.units, 1)),
        reserving(customer(), cart(s.units, 1)),
      ]);

      expect(answers.filter((a) => a.answer.ok)).toHaveLength(1);
      const loser = answers.find((a) => !a.answer.ok)!;
      expect(loser.answer).toMatchObject({
        error: { code: 'inventory.insufficient', details: { lines: [{ reason: 'out' }] } },
      });
    });

    it('does not deadlock when carts cross two sellers in opposite order', async () => {
      const a = await seller([[high * 4, high]]);
      const b = await seller([[high * 4, high]]);
      const pairs = 8;
      const calls = Array.from({ length: pairs }, () => [
        reserve.execute(customer(), cart([a.units[0]!, b.units[0]!])),
        reserve.execute(customer(), cart([b.units[0]!, a.units[0]!])),
      ]).flat();

      const answers: ReserveAnswer[] = await Promise.all(calls);

      // One lock statement in ascending id order: nobody times out or is chosen as a deadlock victim.
      expect(answers.map((x) => (x.ok ? 'ok' : x.error.code))).toEqual(
        Array.from({ length: pairs * 2 }, () => 'ok'),
      );
      expect(await heldOn([...a.units[0]!.items, ...b.units[0]!.items])).toEqual([
        pairs * 2,
        0,
        pairs * 2,
        0,
      ]);
    });

    it('serialises the same holder racing with itself: one ACTIVE reservation remains', async () => {
      const s = await seller([[high, high]]);
      const who = customer();
      const holder = who.actor.kind === 'authenticated' ? who.actor.accountId : '';

      await Promise.all(Array.from({ length: 4 }, () => reserving(who, cart(s.units, 1))));

      const mine = await reservationsOf(holder);
      expect(mine.filter((r) => r.status === 'active')).toHaveLength(1);
      expect(
        mine.filter((r) => r.status === 'released').every((r) => r.release_cause === 'superseded'),
      ).toBe(true);
    });
  });

  it('is all or nothing: a failing second line leaves no reservation and keeps the earlier one (AC 3)', async () => {
    const s = await seller([
      [high, 0],
      [1, null],
    ]);
    const who = customer();
    const holder = who.actor.kind === 'authenticated' ? who.actor.accountId : '';
    const first = await reserve.execute(who, cart([s.units[0]!], 1));
    if (!first.ok) throw new Error('first');
    // The seller's own limit lifts the cap so the short line fails on stock, not on the cap.
    await sql.query(
      `INSERT INTO inventory.offer_purchase_limits (id, market_id, tenant_id, offer_id, seller_id, max_per_customer, version, created_at)
       VALUES ($1, $2, $3, $4, $5, 5, 1, $6)`,
      [
        ids.next<'OfferPurchaseLimit'>(),
        code,
        market.tenantId,
        s.units[1]!.offerId,
        s.sellerId,
        new Date(T0.epochMilliseconds),
      ],
    );

    const second = await reserve.execute(who, cart(s.units, 2));

    expect(second).toMatchObject({
      ok: false,
      error: {
        code: 'inventory.insufficient',
        details: { lines: [{ offerId: s.units[1]!.offerId, reason: 'not-enough' }] },
      },
    });
    // The supersede of the first reservation was undone with the rest of the unit (design 4.2 step 7).
    const mine = await reservationsOf(holder);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      id: first.value.reservationId,
      status: 'active',
      release_cause: null,
    });
    expect((await linesOf(first.value.reservationId))[0]).toMatchObject({ state: 'active' });
  });

  it("supersedes the holder's earlier reservation, header and lines, in the same unit (design 3.1)", async () => {
    const s = await seller([[high, high]]);
    const who = customer();
    const holder = who.actor.kind === 'authenticated' ? who.actor.accountId : '';
    const first = await reserve.execute(who, cart(s.units, 2));
    if (!first.ok) throw new Error('first');

    const second = await reserve.execute(who, cart(s.units, 3));

    expect(second.ok).toBe(true);
    const mine = new Map((await reservationsOf(holder)).map((r) => [r.id, r]));
    expect(mine.size).toBe(2);
    expect(mine.get(first.value.reservationId)).toMatchObject({
      status: 'released',
      release_cause: 'superseded',
    });
    expect(mine.get(second.ok ? second.value.reservationId : '')).toMatchObject({
      status: 'active',
      release_cause: null,
    });
    expect((await linesOf(first.value.reservationId)).map((l) => l.state)).toEqual(['released']);
    expect(await heldOn(s.units[0]!.items)).toEqual([3, 0]);
  });

  it('answers an exact replay with the same reservation and writes nothing', async () => {
    const s = await seller([[high, high]]);
    const who = customer();
    const holder = who.actor.kind === 'authenticated' ? who.actor.accountId : '';
    const same = cart(s.units, 2);

    const first = await reserve.execute(who, same);
    const again = await reserve.execute(who, same);

    expect(again).toEqual(first);
    expect(await reservationsOf(holder)).toHaveLength(1);
  });

  describe('the per-customer cap (design 5.1)', () => {
    it('refuses D + 1 on a high-stock unit: the Market cap D binds (design 5.1)', async () => {
      const s = await seller([[high + 100, null]]);
      const d = config.defaultCustomerCap;

      const over = await reserve.execute(customer(), cart(s.units, d + 1));
      const exact = await reserve.execute(customer(), cart(s.units, d));

      expect(over).toMatchObject({ error: { details: { lines: [{ reason: 'over-limit' }] } } });
      expect(exact.ok).toBe(true);
    });

    it('limits a low sell unit to min(D, ceil(onlyLeft / 2)) and a limited Offer to its limit', async () => {
      const s = await seller([
        [threshold, null],
        [high, null],
      ]);
      const [low, limited] = s.units as [Unit, Unit];
      await sql.query(
        `INSERT INTO inventory.offer_purchase_limits (id, market_id, tenant_id, offer_id, seller_id, max_per_customer, version, created_at)
         VALUES ($1, $2, $3, $4, $5, 2, 1, $6)`,
        [
          ids.next<'OfferPurchaseLimit'>(),
          code,
          market.tenantId,
          limited.offerId,
          s.sellerId,
          new Date(T0.epochMilliseconds),
        ],
      );
      const half = Math.min(config.defaultCustomerCap, Math.ceil(threshold / 2));

      const tooMany = await reserve.execute(customer(), cart([low], half + 1));
      const fine = await reserve.execute(customer(), cart([low], half));
      const overLimit = await reserve.execute(customer(), cart([limited], 3));
      const withinLimit = await reserve.execute(customer(), cart([limited], 2));

      expect(tooMany).toMatchObject({ error: { details: { lines: [{ reason: 'over-limit' }] } } });
      expect(fine.ok).toBe(true);
      expect(overLimit).toMatchObject({
        error: { details: { lines: [{ reason: 'over-limit' }] } },
      });
      expect(withinLimit.ok).toBe(true);
    });
  });

  it('refuses a retired sell unit and a sell unit with no stock (design 3.3)', async () => {
    const s = await seller([
      [high, high],
      [0, 0],
    ]);
    await sql.query(`UPDATE inventory.stock_items SET retired_at = $1 WHERE id = ANY($2::uuid[])`, [
      new Date(T0.epochMilliseconds),
      s.units[0]!.items,
    ]);

    const result = await reserve.execute(customer(), cart(s.units));

    expect(result).toMatchObject({
      ok: false,
      error: {
        details: {
          lines: [
            { offerId: s.units[0]!.offerId, reason: 'retired' },
            { offerId: s.units[1]!.offerId, reason: 'out' },
          ],
        },
      },
    });
  });

  describe('expiry (design 3.1, 4.1, 11; AC 4)', () => {
    it('derives expiry at read: the stock is sellable again before the job runs, then the job sets the status', async () => {
      const s = await seller([[1, null]]);
      const a = customer();
      const holderA = a.actor.kind === 'authenticated' ? a.actor.accountId : '';
      const first = await reserve.execute(a, cart(s.units));
      if (!first.ok) throw new Error('first');
      expect(await reserve.execute(customer(), cart(s.units))).toMatchObject({ ok: false });

      clock.advance(Temporal.Duration.from({ minutes }));
      // The status column still says active; reads already ignore the hold.
      expect((await reservationsOf(holderA))[0]!.status).toBe('active');
      expect(await heldOn(s.units[0]!.items)).toEqual([0, 0]);
      const availability = await db.unitOfWork.run(
        market,
        async () => {
          return ok(await reader.itemsOfSellUnits(market, s.units, clock.now()));
        },
        { readOnly: true },
      );
      expect(availability).toMatchObject({ ok: true, value: [{ onHand: 1, held: 0 }] });
      const b = await reserve.execute(customer(), cart(s.units));
      expect(b.ok).toBe(true);

      const run = await expire.execute(testCallContext(market, 'system'), {});

      expect(run.ok && run.value.expired).toBeGreaterThanOrEqual(1);
      const [expired] = await reservationsOf(holderA);
      expect(expired).toMatchObject({ status: 'expired', release_cause: null });
      expect((await linesOf(first.value.reservationId)).map((l) => l.state)).toEqual(['expired']);
      // The second buyer's hold is untouched.
      expect(await heldOn(s.units[0]!.items)).toEqual([1, 0]);
    });

    it('publishes the signal change the expiry causes, once', async () => {
      const s = await seller([[1, null]]);
      const first = await reserve.execute(customer(), cart(s.units));
      expect(first.ok).toBe(true);
      const signalId = async () =>
        (
          await rows(
            `SELECT id, status, version FROM inventory.availability_signals WHERE market_id = $1 AND offer_id = $2`,
            [code, s.units[0]!.offerId],
          )
        )[0]!;
      expect(await signalId()).toMatchObject({ status: 'out' });

      clock.advance(Temporal.Duration.from({ minutes: minutes + 1 }));
      await expire.execute(testCallContext(market, 'system'), {});
      const after = await signalId();
      const again = await expire.execute(testCallContext(market, 'system'), {});

      expect(after).toMatchObject({ status: 'low' });
      expect(again.ok && again.value.expired).toBe(0);
      expect(await signalId()).toMatchObject({ version: after.version });
    });
  });

  describe('releasing', () => {
    it('lets the holder release their own hold, the system release with a cause, and repeats change nothing', async () => {
      const s = await seller([[high, high]]);
      const who = customer();
      const other = customer();
      const holder = who.actor.kind === 'authenticated' ? who.actor.accountId : '';
      const first = await reserve.execute(who, cart(s.units, 2));
      if (!first.ok) throw new Error('first');
      const id = first.value.reservationId;

      expect(await releaseOwn.execute(other, { reservationId: id })).toEqual({
        ok: false,
        error: { code: 'inventory.reservation.not-found' },
      });
      expect((await reservationsOf(holder))[0]!.status).toBe('active');

      expect((await releaseOwn.execute(who, { reservationId: id })).ok).toBe(true);
      const system = testCallContext(market, 'system');
      expect(
        (await release.execute(system, { reservationId: id, cause: 'payment-failed' })).ok,
      ).toBe(true);

      expect((await reservationsOf(holder))[0]).toMatchObject({
        status: 'released',
        release_cause: 'customer',
      });
      expect(await heldOn(s.units[0]!.items)).toEqual([0, 0]);

      const next = await reserve.execute(who, cart(s.units, 1));
      if (!next.ok) throw new Error('next');
      expect(
        (
          await release.execute(system, {
            reservationId: next.value.reservationId,
            cause: 'cancelled',
          })
        ).ok,
      ).toBe(true);
      expect(
        (await reservationsOf(holder)).find((r) => r.id === next.value.reservationId),
      ).toMatchObject({
        status: 'released',
        release_cause: 'cancelled',
      });
    });

    it('refuses to release a committed reservation', async () => {
      const s = await seller([[high, high]]);
      const who = customer();
      const first = await reserve.execute(who, cart(s.units, 1));
      if (!first.ok) throw new Error('first');
      await sql.query(
        `UPDATE inventory.reservation_lines SET state = 'committed', order_line_id = $2 WHERE reservation_id = $1`,
        [first.value.reservationId, ids.next<'OrderLine'>()],
      );
      await sql.query(`UPDATE inventory.reservations SET status = 'committed' WHERE id = $1`, [
        first.value.reservationId,
      ]);

      expect(await releaseOwn.execute(who, { reservationId: first.value.reservationId })).toEqual({
        ok: false,
        error: { code: 'inventory.reservation.committed' },
      });
      // A committed line keeps counting as pending, whatever the clock says.
      clock.advance(Temporal.Duration.from({ minutes: minutes + 5 }));
      expect(await heldOn(s.units[0]!.items)).toEqual([1, 0]);
    });
  });

  it('refuses a stock level below what is held, and accepts it at that level (AC 9)', async () => {
    const s = await seller([[8, null]]);
    const sellerContext = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: s.sellerId,
      }),
    );
    const reserved = await reserve.execute(customer(), cart(s.units, 3));
    expect(reserved.ok).toBe(true);
    const input = (onHand: number, expectedVersion: number) => ({
      offerId: s.units[0]!.offerId,
      variantId: s.units[0]!.variantId,
      sourceId: s.sourceIds[0],
      onHand,
      expectedVersion,
    });

    const below = await setStockLevel.execute(sellerContext, input(2, 1));
    const exact = await setStockLevel.execute(sellerContext, input(3, 1));

    expect(below).toEqual({
      ok: false,
      error: { code: 'inventory.stock.below-held', details: { min: 3 } },
    });
    expect(exact).toMatchObject({ ok: true, value: { onHand: 3, changed: true } });
  });

  it('keeps one ACTIVE reservation per holder and Market by constraint, and refuses an invalid cause', async () => {
    const s = await seller([[high, high]]);
    const who = customer();
    const holder = who.actor.kind === 'authenticated' ? who.actor.accountId : '';
    await reserve.execute(who, cart(s.units));

    const duplicate = sql.query(
      `INSERT INTO inventory.reservations (id, market_id, tenant_id, holder_account_id, checkout_ref, status, expires_at, created_at, status_changed_at, version)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $7, 1)`,
      [
        ids.next<'Reservation'>(),
        code,
        market.tenantId,
        holder,
        ids.next<'Checkout'>(),
        new Date(T0.epochMilliseconds + 60_000),
        new Date(T0.epochMilliseconds),
      ],
    );
    const badCause = sql.query(
      `UPDATE inventory.reservations SET release_cause = 'customer' WHERE market_id = $1 AND holder_account_id = $2`,
      [code, holder],
    );

    await expect(duplicate).rejects.toMatchObject({ code: '23505' });
    await expect(badCause).rejects.toMatchObject({ code: '23514' });
  });
  describe('hold_seq (H1: a SERIALIZABLE stock unit learns that holds changed)', () => {
    const seqOf = async (itemId: string) =>
      (
        await rows(
          `SELECT hold_seq, version FROM inventory.stock_items WHERE market_id = $1 AND id = $2`,
          [code, itemId],
        )
      )[0]!;

    it('is raised by reserve, both releases and expiry, and never raises version (C5)', async () => {
      const s = await seller([[high, null]]);
      const item = s.units[0]!.items[0]!;
      const system = testCallContext(market, 'system');
      expect(await seqOf(item)).toEqual({ hold_seq: 0, version: 1 });

      const who = customer();
      const first = await reserve.execute(who, cart(s.units, 1));
      if (!first.ok) throw new Error('first');
      const afterReserve = (await seqOf(item)).hold_seq as number;
      expect(afterReserve).toBeGreaterThan(0);

      await releaseOwn.execute(who, { reservationId: first.value.reservationId });
      const afterOwn = (await seqOf(item)).hold_seq as number;
      expect(afterOwn).toBeGreaterThan(afterReserve);

      const second = await reserve.execute(who, cart(s.units, 1));
      if (!second.ok) throw new Error('second');
      const afterSecond = (await seqOf(item)).hold_seq as number;
      await release.execute(system, {
        reservationId: second.value.reservationId,
        cause: 'cancelled',
      });
      const afterSystem = (await seqOf(item)).hold_seq as number;
      expect(afterSystem).toBeGreaterThan(afterSecond);

      const third = await reserve.execute(who, cart(s.units, 1));
      if (!third.ok) throw new Error('third');
      const beforeExpiry = (await seqOf(item)).hold_seq as number;
      clock.advance(Temporal.Duration.from({ minutes }));
      await expire.execute(system, {});
      expect((await seqOf(item)).hold_seq as number).toBeGreaterThan(beforeExpiry);
      expect((await seqOf(item)).version).toBe(1);
    });

    it('makes set-stock-level retry when a reserve commits after its first statement, so it never goes below the hold', async () => {
      const s = await seller([[8, null]]);
      const sellerContext = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId: s.sellerId,
        }),
      );
      const real = new PrismaStockRepository(db.service);
      let lockCalls = 0;
      let reachedLock!: () => void;
      const reached = new Promise<void>((resolve) => (reachedLock = resolve));
      let resume!: () => void;
      const resumed = new Promise<void>((resolve) => (resume = resolve));
      const wrapped: StockRepository = {
        lockSellUnit: async (...args) => {
          lockCalls += 1;
          if (lockCalls === 1) {
            // The unit has read the seller's inventory: its snapshot is fixed.
            reachedLock();
            await resumed;
          }
          return real.lockSellUnit(...args);
        },
        isSellUnitRetired: (...args) => real.isSellUnitRetired(...args),
        activeItemIds: (...args) => real.activeItemIds(...args),
        lockItems: (...args) => real.lockItems(...args),
        itemIdsOfOfferVariants: (...args) => real.itemIdsOfOfferVariants(...args),
        tombstonesOf: (...args) => real.tombstonesOf(...args),
        recordTombstone: (...args) => real.recordTombstone(...args),
        retireItems: (...args) => real.retireItems(...args),
        heldQuantities: (...args) => real.heldQuantities(...args),
        insertItem: (...args) => real.insertItem(...args),
        setOnHand: (...args) => real.setOnHand(...args),
        appendMovement: (...args) => real.appendMovement(...args),
      };
      const racing = new SetStockLevel(createUseCaseGate(markets, admitAll), {
        unitOfWork: db.unitOfWork,
        inventories: new PrismaSellerInventoryRepository(db.service),
        stock: wrapped,
        signals: new PrismaAvailabilitySignalRepository(db.service),
        offers: {
          sellUnitsOf: (_c, offerIds) =>
            Promise.resolve(
              new Map(
                offerIds.flatMap((id) => {
                  const offer = catalogOffers.get(id);
                  return offer === undefined
                    ? []
                    : [
                        [
                          id,
                          {
                            sellerId: offer.sellerId,
                            deleted: false,
                            productId: ids.next<'Product'>(),
                            sellUnitVariantIds: new Set([offer.variantId]),
                          },
                        ] as const,
                      ];
                }),
              ),
            ),
        },
        policies: new ConfigInventoryPolicyProvider(markets),
        outbox: new PrismaOutboxWriterFactory(
          modelMap,
          db.service,
          (() => {
            const catalogue = new EventCatalogue();
            catalogue.register('inventory', INVENTORY_EVENTS);
            catalogue.seal();
            return catalogue;
          })(),
          ids,
          NO_PERMISSION_KEYS,
        ).forModule('inventory'),
        ids,
        clock,
      });

      const lowered = racing.execute(sellerContext, {
        offerId: s.units[0]!.offerId,
        variantId: s.units[0]!.variantId,
        sourceId: s.sourceIds[0],
        onHand: 2,
        expectedVersion: 1,
      });
      await reached;
      const reserved = await reserve.execute(customer(), cart(s.units, 3));
      expect(reserved.ok).toBe(true);
      resume();

      expect(await lowered).toEqual({
        ok: false,
        error: { code: 'inventory.stock.below-held', details: { min: 3 } },
      });
      expect(lockCalls).toBeGreaterThanOrEqual(2);
      const [item] = await rows(
        `SELECT on_hand FROM inventory.stock_items WHERE market_id = $1 AND id = $2`,
        [code, s.units[0]!.items[0]],
      );
      expect(item!.on_hand).toBe(8);
    });
  });

  describe('slice 5: commit, cancel, shipment, prune and the rate limit', () => {
    const system = () => testCallContext(market, 'system');
    const holderOf = (context: CallContext) =>
      context.actor.kind === 'authenticated' ? context.actor.accountId : '';

    /** Reserves `quantity` of every unit as a new customer; returns what a commit needs. */
    async function reservedCart(units: readonly Unit[], quantity = 1) {
      const who = customer();
      const checkoutRef = ids.next<'Checkout'>();
      const answer = await reserve.execute(who, cart(units, quantity, checkoutRef));
      if (!answer.ok) throw new Error(`reserve: ${answer.error.code}`);
      const lines = answer.value.lines.map((line) => ({
        reservationLineId: line.reservationLineId,
        orderLineId: ids.next<'OrderLine'>(),
      }));
      return {
        who,
        reservationId: answer.value.reservationId,
        request: { reservationId: answer.value.reservationId, checkoutRef, lines },
      };
    }
    const stateOf = (reservationId: string) =>
      rows(
        `SELECT r.status, r.release_cause, l.state, l.order_line_id, l.stock_item_id, l.quantity
           FROM inventory.reservations r JOIN inventory.reservation_lines l
             ON l.market_id = r.market_id AND l.reservation_id = r.id
          WHERE r.market_id = $1 AND r.id = $2 ORDER BY l.id`,
        [code, reservationId],
      );
    const itemRow = async (itemId: string) =>
      (
        await rows(
          `SELECT on_hand, version FROM inventory.stock_items WHERE market_id = $1 AND id = $2`,
          [code, itemId],
        )
      )[0] as { on_hand: number; version: number };

    it('commits a live reservation, which keeps counting after its expiry would have passed', async () => {
      const s = await seller([[high, high]]);
      const r = await reservedCart(s.units, 2);

      expect(await commit.execute(system(), r.request)).toEqual({
        ok: true,
        value: { reservationId: r.reservationId },
      });
      expect(await commit.execute(system(), r.request)).toEqual({
        ok: true,
        value: { reservationId: r.reservationId },
      });

      const [row] = await stateOf(r.reservationId);
      expect(row).toMatchObject({
        status: 'committed',
        release_cause: null,
        state: 'committed',
        order_line_id: r.request.lines[0]!.orderLineId,
        stock_item_id: s.units[0]!.items[0],
      });
      clock.advance(Temporal.Duration.from({ minutes: minutes + 5 }));
      expect(await heldOn(s.units[0]!.items)).toEqual([2, 0]);
      expect(await expire.execute(system(), {})).toMatchObject({ ok: true });
      expect((await stateOf(r.reservationId))[0]!.status).toBe('committed');
    });

    it('allocates an expired reservation again on the next source, and refuses when nothing fits', async () => {
      const s = await seller([
        [3, high],
        [high, 0],
      ]);
      const first = await reservedCart([s.units[0]!], 3);
      const second = await reservedCart([s.units[1]!], 2);
      clock.advance(Temporal.Duration.from({ minutes: minutes + 1 }));
      // Another buyer takes source 1 of the first unit; the seller sets the second to zero.
      expect((await reserve.execute(customer(), cart([s.units[0]!], 3))).ok).toBe(true);
      await sql.query(
        `UPDATE inventory.stock_items SET on_hand = 0 WHERE market_id = $1 AND id = $2`,
        [code, s.units[1]!.items[0]],
      );

      const moved = await commit.execute(system(), first.request);
      const refused = await commit.execute(system(), second.request);

      expect(moved.ok).toBe(true);
      expect((await stateOf(first.reservationId))[0]).toMatchObject({
        status: 'committed',
        stock_item_id: s.units[0]!.items[1],
      });
      expect(refused).toMatchObject({
        ok: false,
        error: { code: 'inventory.insufficient', details: { lines: [{ reason: 'out' }] } },
      });
      expect((await stateOf(second.reservationId))[0]).toMatchObject({
        status: 'active',
        state: 'active',
        order_line_id: null,
      });
    });

    it('commits a reservation released as superseded and refuses a cancelled one, nothing taken', async () => {
      const s = await seller([[high, high]]);
      const old = await reservedCart(s.units, 1);
      const other = await reserve.execute(old.who, cart(s.units, 1));
      expect(other.ok).toBe(true);
      expect((await stateOf(old.reservationId))[0]).toMatchObject({
        status: 'released',
        release_cause: 'superseded',
      });

      expect((await commit.execute(system(), old.request)).ok).toBe(true);
      expect((await stateOf(old.reservationId))[0]).toMatchObject({
        status: 'committed',
        release_cause: 'superseded',
        state: 'committed',
      });

      const gone = await reservedCart(s.units, 1);
      await release.execute(system(), { reservationId: gone.reservationId, cause: 'cancelled' });
      expect(await commit.execute(system(), gone.request)).toMatchObject({
        ok: false,
        error: { code: 'inventory.insufficient' },
      });
      expect((await stateOf(gone.reservationId))[0]!.status).toBe('released');
    });

    it('refuses a mismatching checkoutRef, a subset and a reused order line', async () => {
      const s = await seller([
        [high, high],
        [high, high],
      ]);
      const r = await reservedCart(s.units, 1);
      const done = await reservedCart([s.units[0]!], 1);
      await commit.execute(system(), done.request);

      const wrongRef = { ...r.request, checkoutRef: ids.next<'Checkout'>() };
      const subset = { ...r.request, lines: r.request.lines.slice(0, 1) };
      const reused = {
        ...r.request,
        lines: [
          { ...r.request.lines[0]!, orderLineId: done.request.lines[0]!.orderLineId },
          r.request.lines[1]!,
        ],
      };

      for (const bad of [wrongRef, subset, reused]) {
        expect(await commit.execute(system(), bad)).toMatchObject({
          error: { code: 'inventory.commit-mismatch' },
        });
      }
      expect((await stateOf(r.reservationId))[0]!.status).toBe('active');
    });

    it('commits an expired-but-unmarked reservation while the expiry job runs: it ends committed, with consistent lines', async () => {
      const s = await seller([[high, high]]);
      const r = await reservedCart(s.units, 1);
      clock.advance(Temporal.Duration.from({ minutes: minutes + 1 }));

      const [committed, expired] = await Promise.all([
        commit.execute(system(), r.request),
        expire.execute(system(), {}),
      ]);

      expect(committed.ok).toBe(true);
      expect(expired.ok).toBe(true);
      const finalRows = await stateOf(r.reservationId);
      expect(finalRows[0]!.status).toBe('committed');
      expect(finalRows[0]!.state).toBe('committed');
    });

    it('cancels a committed line (sellable again), and ships one (on-hand down, movement, version up)', async () => {
      const s = await seller([[high, high]]);
      const toCancel = await reservedCart(s.units, 3);
      const toShip = await reservedCart(s.units, 2);
      await commit.execute(system(), toCancel.request);
      await commit.execute(system(), toShip.request);
      expect(await heldOn(s.units[0]!.items)).toEqual([5, 0]);

      const cancelled = await cancelLine.execute(system(), {
        orderLineId: toCancel.request.lines[0]!.orderLineId,
      });
      expect(cancelled.ok).toBe(true);
      expect(await heldOn(s.units[0]!.items)).toEqual([2, 0]);

      const before = await itemRow(s.units[0]!.items[0]!);
      const orderLineId = toShip.request.lines[0]!.orderLineId;
      expect((await ship.execute(system(), { orderLineId })).ok).toBe(true);
      expect((await ship.execute(system(), { orderLineId })).ok).toBe(true);

      const after = await itemRow(s.units[0]!.items[0]!);
      expect(after.on_hand).toBe(before.on_hand - 2);
      expect(after.version).toBe(before.version + 1);
      expect(await heldOn(s.units[0]!.items)).toEqual([0, 0]);
      const movements = await rows(
        `SELECT delta, resulting_on_hand, reason, actor_kind, actor_module
           FROM inventory.stock_movements WHERE market_id = $1 AND stock_item_id = $2`,
        [code, s.units[0]!.items[0]],
      );
      expect(movements).toEqual([
        {
          delta: -2,
          resulting_on_hand: before.on_hand - 2,
          reason: 'shipment',
          actor_kind: 'module',
          actor_module: 'inventory',
        },
      ]);
      expect(await cancelLine.execute(system(), { orderLineId })).toMatchObject({
        error: { code: 'inventory.line.final' },
      });
      expect(
        await ship.execute(system(), { orderLineId: toCancel.request.lines[0]!.orderLineId }),
      ).toMatchObject({ error: { code: 'inventory.line.final' } });
    });

    it('lets exactly one of a racing cancel and shipment of the same line win', async () => {
      const s = await seller([[high, high]]);
      const r = await reservedCart(s.units, 2);
      await commit.execute(system(), r.request);
      const orderLineId = r.request.lines[0]!.orderLineId;

      const [a, b] = await Promise.all([
        cancelLine.execute(system(), { orderLineId }),
        ship.execute(system(), { orderLineId }),
      ]);

      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      const [line] = await stateOf(r.reservationId);
      expect(['cancelled', 'fulfilled']).toContain(line!.state);
      const item = await itemRow(s.units[0]!.items[0]!);
      expect(item.on_hand).toBe(line!.state === 'fulfilled' ? high - 2 : high);
    });

    it('ships a line whose stock item was retired meanwhile', async () => {
      const s = await seller([[high, null]]);
      const r = await reservedCart(s.units, 2);
      await commit.execute(system(), r.request);
      await sql.query(
        `UPDATE inventory.stock_items SET retired_at = $3 WHERE market_id = $1 AND id = $2`,
        [code, s.units[0]!.items[0], new Date(T0.epochMilliseconds)],
      );

      expect(
        (await ship.execute(system(), { orderLineId: r.request.lines[0]!.orderLineId })).ok,
      ).toBe(true);
      expect((await itemRow(s.units[0]!.items[0]!)).on_hand).toBe(high - 2);
    });

    it('prunes released and expired reservations after 30 days, lines by the cascade, never committed ones', async () => {
      const s = await seller([[high, high]]);
      const released = await reservedCart(s.units, 1);
      const committed = await reservedCart(s.units, 1);
      await commit.execute(system(), committed.request);
      await release.execute(system(), {
        reservationId: released.reservationId,
        cause: 'cancelled',
      });
      clock.advance(Temporal.Duration.from({ hours: 31 * 24 }));

      const run = await prune.execute(system(), {});

      expect(run.ok).toBe(true);
      expect(await stateOf(released.reservationId)).toEqual([]);
      expect(
        await rows(
          `SELECT 1 FROM inventory.reservation_lines WHERE market_id = $1 AND reservation_id = $2`,
          [code, released.reservationId],
        ),
      ).toEqual([]);
      expect((await stateOf(committed.reservationId))[0]!.status).toBe('committed');
    });

    it('throttles the 7th reserve of one account in 15 minutes, counts in PostgreSQL by hashed key, and purges after 48 hours', async () => {
      const s = await seller([[high, high]]);
      const who = customer();
      for (let call = 0; call < 6; call += 1) {
        expect((await reserving(who, cart(s.units, 1))).answer.ok).toBe(true);
      }

      const over = await reserve.execute(who, cart(s.units, 1));

      expect(over).toMatchObject({ ok: false, error: { code: 'request.throttled' } });
      const counters = await rows(
        `SELECT kind, count, octet_length(key_hash) AS bytes FROM inventory.rate_counters
          WHERE market_id = $1 AND kind LIKE 'reserve.account.%' ORDER BY window_started_at DESC, kind`,
        [code],
      );
      expect(counters.length).toBeGreaterThanOrEqual(2);
      expect(counters.every((row) => row.bytes === 32)).toBe(true);
      expect(JSON.stringify(counters)).not.toContain(holderOf(who));
      // No reservation was made by the refused call.
      expect(
        (await reservationsOf(holderOf(who))).filter((row) => row.status === 'active'),
      ).toHaveLength(1);

      clock.advance(Temporal.Duration.from({ hours: 49 }));
      await prune.execute(system(), {});
      expect(
        await rows(
          `SELECT 1 FROM inventory.rate_counters WHERE market_id = $1 AND window_started_at < $2`,
          [code, new Date(clock.now().epochMilliseconds - 48 * 3_600_000)],
        ),
      ).toEqual([]);
    });

    it('uses the held index for the held sum and the terminal index for the prune (EXPLAIN)', async () => {
      const plan = async (text: string, params: unknown[]) => {
        await sql.query('BEGIN');
        try {
          await sql.query('SET LOCAL enable_seqscan = off');
          await sql.query('SET LOCAL enable_bitmapscan = off');
          const result = await sql.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${text}`, params);
          return result.rows.map((row) => row['QUERY PLAN']).join('\n');
        } finally {
          await sql.query('ROLLBACK');
        }
      };
      const held = await plan(
        `SELECT stock_item_id, state, SUM(quantity) FROM inventory.reservation_lines
          WHERE market_id = $1 AND stock_item_id = ANY($2::uuid[]) AND state IN ('active', 'committed')
            AND (state = 'committed' OR expires_at > $3) GROUP BY stock_item_id, state`,
        [code, [ids.next<'StockItem'>()], new Date(T0.epochMilliseconds)],
      );
      const terminal = await plan(
        `SELECT id FROM inventory.reservations WHERE market_id = $1
            AND status IN ('released', 'expired') AND status_changed_at < $2
          ORDER BY status_changed_at LIMIT 500`,
        [code, new Date(T0.epochMilliseconds)],
      );

      expect(held).toContain('reservation_lines_market_id_stock_item_id_state_idx');
      expect(terminal).toContain('reservations_market_id_status_changed_at_terminal_idx');
    });
  });
});
