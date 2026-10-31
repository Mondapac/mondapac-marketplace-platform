import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { SellerAccessReinstated, SellerAccessSuspended } from '../../src/modules/identity';
import { PrismaEligibilityAnchorRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-eligibility-anchor.repository';
import { PrismaPayoutHoldRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-payout-hold.repository';
import { PrismaPayoutTermsRepository } from '../../src/modules/commission-payouts/infrastructure/prisma-payout-terms.repository';
import type { PayoutHoldRecord } from '../../src/modules/commission-payouts/application/ports/payout-hold.repository';
import { OUTBOX_RELAY, type OutboxRelay } from '../../src/platform/events/event-bus';
import { EventCatalogue } from '../../src/platform/events/event-catalogue';
import { EVENT_DISPATCHER, type EventDispatcher } from '../../src/platform/events/event-delivery';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import { eventContext } from './outbox-support';
import {
  createPersistence,
  marketOf,
  modelMap,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { payoutHoldsOwnerTestDatabaseUrl, payoutHoldsTestDatabaseUrl } from './test-database';

// Package 6b on PostgreSQL, in both Market fixtures: the seller payout terms override (version,
// bounds), the write-once eligibility anchor, the insert-and-release-only payout holds (guard
// trigger, CHECKs, grants), and identity's seller-access events reaching the commission-payouts
// handlers through the relay, the dispatcher and the module inbox. Runs on its own copy of the run
// database (global-setup.ts): the relay and the dispatcher claim every due row of a Market.

const T0 = Temporal.Instant.from('2026-10-14T10:00:00Z');
const CHECK = '23514';
const NO_PRIVILEGE = '42501';
const RESTRICT = '23001';
const UNIQUE = '23505';

describe.each(TEST_MARKETS)('payout terms, anchors and holds in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const ids = new UuidV7IdGenerator(new FixedClock(T0));
  let app: NestExpressApplication;
  let db: Persistence;
  let sql: Client;
  let owner: Client;
  let relay: OutboxRelay;
  let dispatcher: EventDispatcher;
  let logs: jest.SpyInstance[];
  let terms: PrismaPayoutTermsRepository;
  let anchors: PrismaEligibilityAnchorRepository;
  let holds: PrismaPayoutHoldRepository;

  const catalogue = new EventCatalogue();
  catalogue.register('identity', [SellerAccessSuspended, SellerAccessReinstated]);
  catalogue.seal();

  beforeAll(async () => {
    logs = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    sql = new Client({ connectionString: payoutHoldsTestDatabaseUrl() });
    owner = new Client({ connectionString: payoutHoldsOwnerTestDatabaseUrl() });
    await sql.connect();
    await owner.connect();
    db = createPersistence({ databaseUrl: payoutHoldsTestDatabaseUrl() });
    terms = new PrismaPayoutTermsRepository(db.service);
    anchors = new PrismaEligibilityAnchorRepository(db.service);
    holds = new PrismaPayoutHoldRepository(db.service);
    ({ app } = await createTestApp({ env: { DATABASE_URL: payoutHoldsTestDatabaseUrl() } }));
    relay = app.get<OutboxRelay>(OUTBOX_RELAY);
    dispatcher = app.get<EventDispatcher>(EVENT_DISPATCHER);
  });
  afterAll(async () => {
    await app.close();
    await db.close();
    await sql.end();
    await owner.end();
    logs.forEach((spy) => spy.mockRestore());
  });

  const value = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const codeOf = (promise: Promise<unknown>) =>
    promise.then(
      () => 'allowed',
      (error: { code?: string }) => error.code,
    );
  async function settle(): Promise<void> {
    for (;;) {
      const published = (await relay.runOnce()).published;
      const claimed = (await dispatcher.runOnce()).claimed;
      if (published === 0 && claimed === 0) return;
    }
  }

  describe('payout terms overrides', () => {
    const record = (sellerId: Id<'Seller'>, version: number, holdDaysCarrier: number) => ({
      sellerId,
      override: {
        weekdays: ['MON', 'FRI'] as const,
        localTime: '09:30',
        holdDaysCarrier,
        holdDaysSellerClick: null,
        minimumMinor: 7500n,
        approvalMode: 'MANUAL' as const,
      },
      version,
      updatedAt: T0,
      updatedBy: ids.next<'Account'>(),
    });

    it('inserts once, replaces and removes only at the expected version, and stays inside its Market', async () => {
      const sellerId = ids.next<'Seller'>();
      expect(await value(market, () => terms.find(market, sellerId))).toBeNull();
      const first = record(sellerId, 1, 9);
      expect(await value(market, () => terms.insert(market, first))).toBe(true);
      expect(await value(market, () => terms.insert(market, record(sellerId, 1, 10)))).toBe(false);
      const read = await value(market, () => terms.find(market, sellerId));
      expect(read).toMatchObject({
        version: 1,
        override: {
          weekdays: ['MON', 'FRI'],
          localTime: '09:30',
          holdDaysCarrier: 9,
          holdDaysSellerClick: null,
          minimumMinor: 7500n,
          approvalMode: 'MANUAL',
        },
      });
      expect(await value(other, () => terms.find(other, sellerId))).toBeNull();

      expect(await value(market, () => terms.replace(market, record(sellerId, 2, 12), 5))).toBe(
        false,
      );
      expect(await value(market, () => terms.replace(market, record(sellerId, 2, 12), 1))).toBe(
        true,
      );
      expect(await value(other, () => terms.remove(other, sellerId, 2))).toBe(false);
      expect(await value(market, () => terms.remove(market, sellerId, 1))).toBe(false);
      expect(await value(market, () => terms.remove(market, sellerId, 2))).toBe(true);
      expect(await value(market, () => terms.find(market, sellerId))).toBeNull();
    });

    it('refuses hold days outside 7 to 60, an empty override, a bad mode and a bad scope in the database', async () => {
      const insert = (columns: string, values: unknown[]) =>
        codeOf(
          sql.query(
            `INSERT INTO commission_payouts.payout_terms_overrides
               (market_id, seller_id, tenant_id, version, updated_at, updated_by, ${columns})
             VALUES ($1, $2, $3, 1, now(), $4, ${values.map((_, i) => `$${i + 5}`).join(', ')})`,
            [market.marketId, ids.next(), market.tenantId, ids.next(), ...values],
          ),
        );
      expect(await insert('hold_days_carrier', [6])).toBe(CHECK);
      expect(await insert('hold_days_carrier', [61])).toBe(CHECK);
      expect(await insert('hold_days_seller_click', [6])).toBe(CHECK);
      expect(await insert('hold_days_seller_click', [61])).toBe(CHECK);
      expect(await insert('hold_days_carrier', [7])).toBe('allowed');
      expect(await insert('hold_days_seller_click', [60])).toBe('allowed');
      expect(await insert('minimum_minor', [0])).toBe(CHECK);
      expect(await insert('approval_mode', ['SOMETIMES'])).toBe(CHECK);
      expect(await insert('schedule_weekdays', [128])).toBe(CHECK);
      expect(await insert('local_minute', [1440])).toBe(CHECK);
      // No field set at all.
      expect(
        await codeOf(
          sql.query(
            `INSERT INTO commission_payouts.payout_terms_overrides
               (market_id, seller_id, tenant_id, version, updated_at, updated_by)
             VALUES ($1, $2, $3, 1, now(), $4)`,
            [market.marketId, ids.next(), market.tenantId, ids.next()],
          ),
        ),
      ).toBe(CHECK);
      expect(
        await codeOf(
          sql.query(
            `INSERT INTO commission_payouts.payout_terms_overrides
               (market_id, seller_id, tenant_id, version, updated_at, updated_by, hold_days_carrier)
             VALUES ('au', $1, $2, 1, now(), $3, 9)`,
            [ids.next(), market.tenantId, ids.next()],
          ),
        ),
      ).toBe(CHECK);
    });
  });

  describe('eligibility anchors', () => {
    const anchorOf = (
      sellerId: Id<'Seller'>,
      sellerOrderId: Id<'SellerOrder'>,
      source: 'carrier' | 'seller-click',
      days: number,
    ) => {
      const deliveredAt = T0.subtract({ hours: 5 });
      return {
        sellerOrderId,
        orderId: ids.next<'Order'>(),
        sellerId,
        deliveredAt,
        source,
        holdDaysApplied: days,
        eligibleAt: deliveredAt.add({ hours: days * 24 }),
        recordedAt: T0,
      };
    };

    it('writes an anchor once per seller order, per Market', async () => {
      const sellerId = ids.next<'Seller'>();
      const sellerOrderId = ids.next<'SellerOrder'>();
      const anchor = anchorOf(sellerId, sellerOrderId, 'carrier', 7);
      expect(await value(market, () => anchors.insertIfAbsent(market, anchor))).toBe(true);
      expect(
        await value(market, () =>
          anchors.insertIfAbsent(market, anchorOf(sellerId, sellerOrderId, 'seller-click', 14)),
        ),
      ).toBe(false);
      const read = await value(market, () => anchors.find(market, sellerOrderId));
      expect(read).toMatchObject({
        source: 'carrier',
        holdDaysApplied: 7,
        deliveredAt: anchor.deliveredAt,
        eligibleAt: anchor.eligibleAt,
      });
      expect(await value(other, () => anchors.find(other, sellerOrderId))).toBeNull();
    });

    it('never changes or loses an anchor, for any role, and refuses an eligible_at that is not delivered_at plus the hold', async () => {
      const sellerId = ids.next<'Seller'>();
      const sellerOrderId = ids.next<'SellerOrder'>();
      await value(market, () =>
        anchors.insertIfAbsent(market, anchorOf(sellerId, sellerOrderId, 'carrier', 7)),
      );
      const update = `UPDATE commission_payouts.eligibility_anchors SET eligible_at = eligible_at + interval '1 day' WHERE seller_order_id = $1`;
      expect(await codeOf(sql.query(update, [sellerOrderId]))).toBe(NO_PRIVILEGE);
      expect(await codeOf(owner.query(update, [sellerOrderId]))).toBe(RESTRICT);
      expect(
        await codeOf(
          sql.query(
            `DELETE FROM commission_payouts.eligibility_anchors WHERE seller_order_id = $1`,
            [sellerOrderId],
          ),
        ),
      ).toBe(NO_PRIVILEGE);
      expect(
        await codeOf(
          owner.query(
            `DELETE FROM commission_payouts.eligibility_anchors WHERE seller_order_id = $1`,
            [sellerOrderId],
          ),
        ),
      ).toBe(RESTRICT);
      expect(await codeOf(owner.query(`TRUNCATE commission_payouts.eligibility_anchors`))).toBe(
        RESTRICT,
      );
      const bad = (extra: string, source = 'carrier', days = 7) =>
        codeOf(
          sql.query(
            `INSERT INTO commission_payouts.eligibility_anchors
               (market_id, seller_order_id, tenant_id, seller_id, order_id, delivered_at,
                anchor_source, hold_days_applied, eligible_at, recorded_at)
             VALUES ($1, $2, $3, $4, $5, now(), $6, $7, ${extra}, now())`,
            [market.marketId, ids.next(), market.tenantId, ids.next(), ids.next(), source, days],
          ),
        );
      expect(await bad(`now() + interval '7 days 1 second'`)).toBe(CHECK);
      expect(await bad(`now() + interval '7 days'`, 'someone', 7)).toBe(CHECK);
      expect(await bad(`now() + interval '3 days'`, 'carrier', 3)).toBe(CHECK);
    });
  });

  describe('payout holds', () => {
    const hold = (overrides: Partial<PayoutHoldRecord> = {}): PayoutHoldRecord => {
      const holdId = ids.next<'PayoutHold'>();
      return {
        id: holdId,
        sellerId: ids.next<'Seller'>(),
        sellerOrderId: null,
        reason: 'admin-review',
        origin: 'admin',
        sourceRef: holdId,
        placedBy: ids.next<'Account'>(),
        placedAt: T0,
        releasedAt: null,
        releasedBy: null,
        releaseReason: null,
        ...overrides,
      };
    };
    const rowOf = async (holdId: string) =>
      (
        await sql.query<Record<string, unknown>>(
          `SELECT * FROM commission_payouts.payout_holds WHERE id = $1`,
          [holdId],
        )
      ).rows[0];

    it('inserts a hold once per reason and source, lists active ones first and releases it once', async () => {
      const first = hold();
      expect(await value(market, () => holds.insertIfAbsent(market, first))).toBe(true);
      // An admin hold is keyed by its own id: the same source again is a different hold.
      expect(
        await value(market, () =>
          holds.insertIfAbsent(market, hold({ sourceRef: first.sourceRef })),
        ),
      ).toBe(true);
      const second = hold({ sellerId: first.sellerId, reason: 'bank-change' });
      await value(market, () => holds.insertIfAbsent(market, second));
      const listed = await value(market, () =>
        holds.listForSeller(market, first.sellerId, { activeOnly: true, limit: 10 }),
      );
      expect(listed.map((h) => h.id)).toEqual(expect.arrayContaining([first.id, second.id]));
      expect(await value(other, () => holds.find(other, first.id))).toBeNull();

      const by = ids.next<'Account'>();
      const release = {
        releasedAt: T0.add({ hours: 1 }),
        releasedBy: by,
        reason: 'resolved',
      } as const;
      expect(await value(other, () => holds.release(other, first.id, release))).toBe(false);
      expect(await value(market, () => holds.release(market, first.id, release))).toBe(true);
      expect(await value(market, () => holds.release(market, first.id, release))).toBe(false);
      expect(await value(market, () => holds.find(market, first.id))).toMatchObject({
        releasedBy: by,
        releaseReason: 'resolved',
      });
      const after = await value(market, () =>
        holds.listForSeller(market, first.sellerId, { activeOnly: false, limit: 10 }),
      );
      expect(after.map((h) => h.id)).toEqual([second.id, first.id]);
    });

    it('allows one release of the release columns and nothing else, for the application role and the owner', async () => {
      const target = hold();
      await value(market, () => holds.insertIfAbsent(market, target));
      for (const client of [sql, owner]) {
        expect(
          await codeOf(
            client.query(
              `UPDATE commission_payouts.payout_holds SET reason = 'bank-change' WHERE id = $1`,
              [target.id],
            ),
          ),
        ).toBe(client === sql ? NO_PRIVILEGE : RESTRICT);
      }
      // The owner: a release that also moves another column, and an update that releases nothing.
      expect(
        await codeOf(
          owner.query(
            `UPDATE commission_payouts.payout_holds
                SET released_at = now(), release_reason = 'resolved', released_by = $2, seller_id = $3
              WHERE id = $1`,
            [target.id, ids.next(), ids.next()],
          ),
        ),
      ).toBe(RESTRICT);
      expect(
        await codeOf(
          owner.query(`UPDATE commission_payouts.payout_holds SET released_by = $2 WHERE id = $1`, [
            target.id,
            ids.next(),
          ]),
        ),
      ).toBe(RESTRICT);
      const release = `UPDATE commission_payouts.payout_holds
                          SET released_at = now(), release_reason = 'placed-in-error', released_by = $2
                        WHERE id = $1`;
      expect(await codeOf(sql.query(release, [target.id, ids.next()]))).toBe('allowed');
      // Released once: no second release, no edit of the release, by either role.
      expect(await codeOf(sql.query(release, [target.id, ids.next()]))).toBe(RESTRICT);
      expect(
        await codeOf(
          owner.query(
            `UPDATE commission_payouts.payout_holds SET release_reason = 'resolved' WHERE id = $1`,
            [target.id],
          ),
        ),
      ).toBe(RESTRICT);
      expect((await rowOf(target.id))!.release_reason).toBe('placed-in-error');
    });

    it('never deletes a hold', async () => {
      const target = hold();
      await value(market, () => holds.insertIfAbsent(market, target));
      expect(
        await codeOf(
          sql.query(`DELETE FROM commission_payouts.payout_holds WHERE id = $1`, [target.id]),
        ),
      ).toBe(NO_PRIVILEGE);
      expect(
        await codeOf(
          owner.query(`DELETE FROM commission_payouts.payout_holds WHERE id = $1`, [target.id]),
        ),
      ).toBe(RESTRICT);
      expect(await codeOf(owner.query(`TRUNCATE commission_payouts.payout_holds`))).toBe(RESTRICT);
    });

    it('enforces the shape of a hold: reasons by origin, the suspension scope, and the release record', async () => {
      // Raw SQL as the application role: the database alone refuses, whatever the code does.
      const insert = (overrides: Partial<PayoutHoldRecord>) => {
        const row = hold(overrides);
        return codeOf(
          sql.query(
            `INSERT INTO commission_payouts.payout_holds
               (id, market_id, tenant_id, seller_id, seller_order_id, reason, origin, source_ref,
                placed_by, placed_at, released_at, release_reason)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              row.id,
              market.marketId,
              market.tenantId,
              row.sellerId,
              row.sellerOrderId,
              row.reason,
              row.origin,
              row.sourceRef,
              row.placedBy,
              new Date(row.placedAt.epochMilliseconds),
              row.releasedAt === null ? null : new Date(row.releasedAt.epochMilliseconds),
              row.releaseReason,
            ],
          ),
        );
      };
      // An admin places only admin-review and bank-change; a system hold names no admin.
      expect(await insert({ reason: 'dispute' })).toBe(CHECK);
      expect(await insert({ reason: 'refund-pending' })).toBe(CHECK);
      expect(await insert({ reason: 'seller-suspended' })).toBe(CHECK);
      expect(await insert({ origin: 'system', placedBy: null, reason: 'dispute' })).toBe('allowed');
      expect(await insert({ origin: 'system', placedBy: ids.next(), reason: 'dispute' })).toBe(
        CHECK,
      );
      expect(await insert({ origin: 'admin', placedBy: null })).toBe(CHECK);
      // A suspension is a system hold on the whole seller.
      expect(
        await insert({
          origin: 'system',
          placedBy: null,
          reason: 'seller-suspended',
          sellerOrderId: ids.next(),
        }),
      ).toBe(CHECK);
      expect(await insert({ origin: 'system', placedBy: null, reason: 'seller-suspended' })).toBe(
        'allowed',
      );
      // A release record is all-or-nothing and its reason is from the list.
      expect(await insert({ releasedAt: T0, releaseReason: null })).toBe(CHECK);
      expect(await insert({ releasedAt: T0, releaseReason: 'whatever' as never })).toBe(CHECK);
      expect(
        await insert({ releasedAt: T0.subtract({ hours: 1 }), releaseReason: 'resolved' }),
      ).toBe(CHECK);
    });

    it('never lets a suspension be released without an admin', async () => {
      const suspension = hold({
        origin: 'system',
        placedBy: null,
        reason: 'seller-suspended',
      });
      await value(market, () => holds.insertIfAbsent(market, suspension));
      expect(
        await codeOf(
          sql.query(
            `UPDATE commission_payouts.payout_holds
                SET released_at = now(), release_reason = 'seller-reinstated'
              WHERE id = $1`,
            [suspension.id],
          ),
        ),
      ).toBe(CHECK);
      expect(
        await codeOf(
          sql.query(
            `UPDATE commission_payouts.payout_holds
                SET released_at = now(), release_reason = 'seller-reinstated', released_by = $2
              WHERE id = $1`,
            [suspension.id, ids.next()],
          ),
        ),
      ).toBe('allowed');
    });

    it('keeps one system hold per reason, source and scope (NULLS NOT DISTINCT), and not for admin holds', async () => {
      const sourceRef = ids.next<'PayoutHold'>();
      const sellerId = ids.next<'Seller'>();
      const system = (overrides: Partial<PayoutHoldRecord> = {}) =>
        hold({
          origin: 'system',
          placedBy: null,
          reason: 'dispute',
          sourceRef,
          sellerId,
          ...overrides,
        });
      const place = (record: PayoutHoldRecord) =>
        value(market, () => holds.insertIfAbsent(market, record));
      expect(await place(system())).toBe(true);
      // The same event again (the repository skips it: ON CONFLICT DO NOTHING).
      expect(await place(system())).toBe(false);
      // The key holds on raw SQL too.
      const raw = (overrides: { seller?: string; order?: string | null; reason?: string }) =>
        codeOf(
          sql.query(
            `INSERT INTO commission_payouts.payout_holds
               (id, market_id, tenant_id, seller_id, seller_order_id, reason, origin, source_ref, placed_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'system', $7, now())`,
            [
              ids.next(),
              market.marketId,
              market.tenantId,
              overrides.seller ?? sellerId,
              overrides.order ?? null,
              overrides.reason ?? 'dispute',
              sourceRef,
            ],
          ),
        );
      expect(await raw({})).toBe(UNIQUE);
      // Another scope, reason or seller is another hold.
      expect(await raw({ order: ids.next() })).toBe('allowed');
      expect(await raw({ order: ids.next() })).toBe('allowed');
      expect(await raw({ reason: 'refund-pending' })).toBe('allowed');
      expect(await raw({ seller: ids.next() })).toBe('allowed');
      // Admin holds are not keyed by source.
      const admin = (id: Id<'PayoutHold'>) =>
        codeOf(
          sql.query(
            `INSERT INTO commission_payouts.payout_holds
               (id, market_id, tenant_id, seller_id, reason, origin, source_ref, placed_by, placed_at)
             VALUES ($1, $2, $3, $4, 'admin-review', 'admin', $5, $6, now())`,
            [id, market.marketId, market.tenantId, sellerId, sourceRef, ids.next()],
          ),
        );
      expect(await admin(ids.next())).toBe('allowed');
      expect(await admin(ids.next())).toBe('allowed');
    });

    it('releases without a releaser only a system refund-pending or dispute hold (L-1)', async () => {
      const release = (id: string, by: string | null) =>
        codeOf(
          sql.query(
            `UPDATE commission_payouts.payout_holds
                SET released_at = now(), release_reason = 'resolved', released_by = $2
              WHERE id = $1`,
            [id, by],
          ),
        );
      const cases: [Partial<PayoutHoldRecord>, string][] = [
        [{ origin: 'system', placedBy: null, reason: 'refund-pending' }, 'allowed'],
        [{ origin: 'system', placedBy: null, reason: 'dispute' }, 'allowed'],
        [{ origin: 'system', placedBy: null, reason: 'seller-suspended' }, CHECK],
        [{ origin: 'admin', reason: 'admin-review' }, CHECK],
        [{ origin: 'admin', reason: 'bank-change' }, CHECK],
      ];
      for (const [overrides, expected] of cases) {
        const target = hold(overrides);
        await value(market, () => holds.insertIfAbsent(market, target));
        expect([target.reason, target.origin, await release(target.id, null)]).toEqual([
          target.reason,
          target.origin,
          expected,
        ]);
        // With a releaser, every kind may be released.
        const again = hold(overrides);
        await value(market, () => holds.insertIfAbsent(market, again));
        expect(await release(again.id, ids.next())).toBe('allowed');
      }
    });

    it('lists every active hold however old, and only the newest released ones up to the limit (F1)', async () => {
      const sellerId = ids.next<'Seller'>();
      const oldActive = hold({ sellerId, placedAt: T0.subtract({ hours: 24 * 400 }) });
      await value(market, () => holds.insertIfAbsent(market, oldActive));
      const by = ids.next<'Account'>();
      for (let n = 0; n < 7; n += 1) {
        const released = hold({ sellerId, placedAt: T0.add({ minutes: n }) });
        await value(market, () => holds.insertIfAbsent(market, released));
        await value(market, () =>
          holds.release(market, released.id, {
            releasedAt: T0.add({ hours: 1 }),
            releasedBy: by,
            reason: 'resolved',
          }),
        );
      }
      const all = await value(market, () =>
        holds.listForSeller(market, sellerId, { activeOnly: false, limit: 5 }),
      );
      expect(all).toHaveLength(6);
      expect(all[0]!.id).toBe(oldActive.id);
      expect(all.slice(1).every((h) => h.releasedAt !== null)).toBe(true);
      // The newest released first.
      expect(all[1]!.placedAt.toString()).toBe(T0.add({ minutes: 6 }).toString());
      const active = await value(market, () =>
        holds.listForSeller(market, sellerId, { activeOnly: true, limit: 5 }),
      );
      expect(active.map((h) => h.id)).toEqual([oldActive.id]);
    });

    it('has the seller listing index and the active seller-order index of the payout run (F2, N1)', async () => {
      const names = (
        await sql.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes
            WHERE schemaname = 'commission_payouts' AND tablename = 'payout_holds'`,
        )
      ).rows.map((row) => row.indexname);
      expect(names).toEqual(
        expect.arrayContaining([
          'payout_holds_seller_placed_idx',
          'payout_holds_active_seller_idx',
          'payout_holds_system_source_key',
        ]),
      );
      // Added with the payout run (package 6d), the reader of an order's active holds (N1).
      expect(names).toContain('payout_holds_active_seller_order_idx');
      const def = (
        await sql.query<{ indexdef: string }>(
          `SELECT indexdef FROM pg_indexes WHERE indexname = 'payout_holds_seller_placed_idx'`,
        )
      ).rows[0]!.indexdef;
      expect(def).toContain('(market_id, seller_id, placed_at DESC, id DESC)');
    });
  });

  describe('identity events through the module inbox', () => {
    const writer = () =>
      new PrismaOutboxWriterFactory(
        modelMap,
        db.service,
        catalogue,
        ids,
        NO_PERMISSION_KEYS,
      ).forModule('identity');
    const decide = async (
      event: typeof SellerAccessSuspended | typeof SellerAccessReinstated,
      sellerId: Id<'Seller'>,
      decisionId: Id<'SellerAccessDecision'>,
      version: number,
    ) => {
      await db.unitOfWork.run(market, async () => {
        await writer().append(eventContext(market), [
          event.record({
            aggregateId: sellerId,
            aggregateVersion: version,
            occurredAt: T0,
            payload: { sellerId, decisionId },
          }),
        ]);
        return ok(undefined);
      });
      await settle();
    };
    const holdsOf = async (sellerId: string) =>
      (
        await sql.query<{
          reason: string;
          origin: string;
          released_at: Date | null;
          source_ref: string;
        }>(
          `SELECT reason, origin, released_at, source_ref FROM commission_payouts.payout_holds
            WHERE market_id = $1 AND seller_id = $2`,
          [code, sellerId],
        )
      ).rows;
    const inbox = async (handler: string) =>
      (
        await sql.query(
          `SELECT 1 FROM commission_payouts.inbox WHERE market_id = $1 AND handler = $2`,
          [code, handler],
        )
      ).rowCount!;

    it('places a seller-suspended hold once per decision and keeps it through the reinstatement', async () => {
      const sellerId = ids.next<'Seller'>();
      const decisionId = ids.next<'SellerAccessDecision'>();
      const placedBefore = await inbox('commission-payouts.place-suspended-hold');

      await decide(SellerAccessSuspended, sellerId, decisionId, 1);
      expect(await holdsOf(sellerId)).toMatchObject([
        { reason: 'seller-suspended', origin: 'system', released_at: null, source_ref: decisionId },
      ]);
      expect(await inbox('commission-payouts.place-suspended-hold')).toBeGreaterThan(placedBefore);

      // The same decision again, in a new event, changes nothing: one hold per decision.
      await decide(SellerAccessSuspended, sellerId, decisionId, 2);
      expect(await holdsOf(sellerId)).toHaveLength(1);

      // A reinstatement is only noted: the hold stays until an admin releases it.
      const reinstatedBefore = await inbox('commission-payouts.note-seller-reinstated');
      await decide(SellerAccessReinstated, sellerId, ids.next<'SellerAccessDecision'>(), 3);
      expect(await inbox('commission-payouts.note-seller-reinstated')).toBeGreaterThan(
        reinstatedBefore,
      );
      expect(await holdsOf(sellerId)).toMatchObject([
        { reason: 'seller-suspended', released_at: null },
      ]);

      // A second suspension is a second decision and a second hold.
      await decide(SellerAccessSuspended, sellerId, ids.next<'SellerAccessDecision'>(), 4);
      expect(await holdsOf(sellerId)).toHaveLength(2);
    });
  });
});
