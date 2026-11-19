import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { ZonedAttributionSelector } from '../../src/modules/customers/application/ports/seller-invitations.repository';
import type {
  InviteLink,
  SellerAttribution,
} from '../../src/modules/customers/domain/seller-invitations';
import { PrismaCustomerReadModelRepository } from '../../src/modules/customers/infrastructure/prisma-customer-read-models.repository';
import {
  PrismaInviteLinkRepository,
  PrismaSellerAttributionRepository,
} from '../../src/modules/customers/infrastructure/prisma-seller-invitations.repository';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Customers management phase 4a as the application role, in both Market fixtures: sellers' invite
// links (one live link per seller, a token unique in the Market, a refresh revokes the old one) and
// the attributions (one per account, tied to the directory row and gone with it, a decision written
// only over the version read, the admin list's views, search and filters). Markets stay apart.

const T0 = Temporal.Instant.from('2026-11-17T04:00:00Z');
const CHECK = '23514';
const UNIQUE = '23505';
const FOREIGN_KEY = '23503';
const ids = new UuidV7IdGenerator(new FixedClock(T0));

const ALL: ZonedAttributionSelector = {
  view: 'all',
  emailPrefix: null,
  sellerId: null,
  status: null,
  rejectReason: null,
  flag: null,
  attributedFrom: null,
  attributedTo: null,
  dayZone: 'UTC',
};

let tokenCount = 0;
/** A fresh token in the Crockford alphabet (26 symbols). */
const nextToken = (): string => `K${(tokenCount += 1).toString().padStart(25, '0')}`;

const pgCode = (error: unknown): string | undefined => {
  const text = JSON.stringify(error, Object.getOwnPropertyNames(error ?? {})) + String(error);
  if (text.includes('P2002')) return UNIQUE;
  if (text.includes('P2003')) return FOREIGN_KEY;
  return [CHECK, UNIQUE, FOREIGN_KEY].find((code) => text.includes(code));
};

describe.each(TEST_MARKETS)(
  'sellers invite links and attributions in market %s (database)',
  (code) => {
    const market = marketOf(code);
    const other = marketOf(otherMarketOf(code));
    let db: Persistence;
    let directory: PrismaCustomerReadModelRepository;
    let links: PrismaInviteLinkRepository;
    let attributions: PrismaSellerAttributionRepository;
    let sql: Client;

    beforeAll(async () => {
      db = createPersistence();
      directory = new PrismaCustomerReadModelRepository(db.service);
      links = new PrismaInviteLinkRepository(db.service);
      attributions = new PrismaSellerAttributionRepository(db.service);
      sql = new Client({ connectionString: testDatabaseUrl() });
      await sql.connect();
    });
    afterAll(async () => {
      await db.close();
      await sql.end();
    });

    const inUnit = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
      const result = await db.unitOfWork.run(target, async () => ok(await work()));
      if (!result.ok) throw new Error('unit failed');
      return result.value;
    };
    const failure = async (target: MarketContext, work: () => Promise<unknown>) => {
      try {
        await inUnit(target, work);
      } catch (error) {
        return pgCode(error);
      }
      return 'no error';
    };
    const customer = async (target: MarketContext, email?: string) => {
      const accountId = ids.next<'Account'>();
      await inUnit(target, () =>
        directory.upsertDirectory(
          target,
          {
            accountId,
            email: email ?? `${accountId}@example.test`,
            displayName: 'Sam',
            status: 'active',
            emailVerified: true,
            signedUpAt: T0,
          },
          T0,
        ),
      );
      return accountId;
    };
    const link = (sellerId: Id<'Seller'>, token = nextToken()): InviteLink => ({
      id: ids.next<'SellerInviteLink'>(),
      sellerId,
      token,
      createdByAccountId: ids.next<'Account'>(),
      createdAt: T0,
      revokedAt: null,
    });
    const drawn = async (target: MarketContext, sellerId: Id<'Seller'>) => {
      const fresh = link(sellerId);
      expect(await inUnit(target, () => links.replace(target, fresh, T0))).toBe('ok');
      return fresh;
    };
    const attribution = (
      accountId: Id<'Account'>,
      from: InviteLink,
      over: Partial<SellerAttribution> = {},
    ): SellerAttribution => ({
      accountId,
      sellerId: from.sellerId,
      linkId: from.id,
      attributedAt: T0,
      status: 'active',
      rejectReason: null,
      flags: [],
      decidedByAccountId: null,
      decidedAt: null,
      version: 1,
      ...over,
    });

    describe('invite links', () => {
      it('keeps one live link per seller: a refresh revokes the old one', async () => {
        const shop = ids.next<'Seller'>();
        const first = await drawn(market, shop);
        const later = T0.add({ hours: 1 });
        const second = { ...link(shop), createdAt: later };
        expect(await inUnit(market, () => links.replace(market, second, later))).toBe('ok');
        expect(await inUnit(market, () => links.liveOf(market, shop))).toEqual(second);
        expect(await inUnit(market, () => links.findByToken(market, first.token))).toEqual({
          ...first,
          revokedAt: later,
        });
        expect(await inUnit(other, () => links.liveOf(other, shop))).toBeNull();
        expect(await inUnit(other, () => links.findByToken(other, second.token))).toBeNull();
      });

      it('refuses a token taken in the Market, a second live link, and a malformed token', async () => {
        const shop = ids.next<'Seller'>();
        const taken = await drawn(market, shop);
        expect(
          await inUnit(market, () =>
            links.replace(market, link(ids.next<'Seller'>(), taken.token), T0),
          ),
        ).toBe('conflict');
        // The same token in the other Market is another link.
        expect(await inUnit(other, () => links.replace(other, link(shop, taken.token), T0))).toBe(
          'ok',
        );
        const second = link(shop);
        await expect(
          sql.query(
            `INSERT INTO customers.seller_invite_links (id, market_id, tenant_id, seller_id, token, created_by_account_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              second.id,
              market.marketId,
              market.tenantId,
              shop,
              second.token,
              second.createdByAccountId,
              new Date(),
            ],
          ),
        ).rejects.toMatchObject({ code: UNIQUE });
        expect(
          await failure(market, () =>
            links.replace(market, link(ids.next<'Seller'>(), 'U'.repeat(26)), T0),
          ),
        ).toBe(CHECK);
      });
    });

    describe('attributions', () => {
      it('records one per account, tied to the directory row and gone with it', async () => {
        const shop = ids.next<'Seller'>();
        const from = await drawn(market, shop);
        const alice = await customer(market);
        expect(
          await inUnit(market, () => attributions.insert(market, attribution(alice, from))),
        ).toBe('ok');
        expect(
          await inUnit(market, () =>
            attributions.insert(
              market,
              attribution(alice, from, { attributedAt: T0.add({ hours: 1 }) }),
            ),
          ),
        ).toBe('exists');
        expect(await inUnit(market, () => attributions.findOf(market, alice))).toEqual(
          attribution(alice, from),
        );
        expect(await inUnit(other, () => attributions.findOf(other, alice))).toBeNull();
        // No directory row, no attribution.
        expect(
          await failure(market, () =>
            attributions.insert(market, attribution(ids.next<'Account'>(), from)),
          ),
        ).toBe(FOREIGN_KEY);
        await inUnit(market, () => directory.removeAllOf(market, alice));
        expect(await inUnit(market, () => attributions.findOf(market, alice))).toBeNull();
      });

      it('refuses an inconsistent row', async () => {
        const from = await drawn(market, ids.next<'Seller'>());
        const bad: Partial<SellerAttribution>[] = [
          { status: 'rejected', rejectReason: null },
          { status: 'active', rejectReason: 'admin' },
          { decidedAt: T0, decidedByAccountId: null },
          { version: 0 },
          { flags: ['link-burst', 'link-burst'] },
          {
            status: 'rejected',
            rejectReason: 'admin',
            decidedByAccountId: ids.next<'Account'>(),
            decidedAt: T0.subtract({ hours: 1 }),
          },
        ];
        const seen: unknown[] = [];
        for (const over of bad) {
          const accountId = await customer(market);
          seen.push(
            await failure(market, () =>
              attributions.insert(market, attribution(accountId, from, over)),
            ),
          );
        }
        expect(seen).toEqual(bad.map(() => CHECK));
        const flagged = await customer(market);
        expect(
          await failure(market, () =>
            attributions.insert(
              market,
              attribution(flagged, from, { flags: ['made-up' as 'link-burst'] }),
            ),
          ),
        ).toBe(CHECK);
      });

      it('serves the suspicious view from its partial index, as Prisma writes the filter', async () => {
        // The statement shape Prisma sends for the view (bind parameters, NOT flags = '{}'); node-pg
        // sends it unnamed, so the plan is made with the values, as the application's are.
        await sql.query('BEGIN');
        try {
          await sql.query('SET LOCAL enable_seqscan = off');
          const plan = await sql.query(
            `EXPLAIN SELECT "account_id" FROM "customers"."seller_attributions"
             WHERE ("market_id" = $1 AND ("status" = $2 OR (NOT "flags" = '{}')))
             ORDER BY "attributed_at" DESC, "account_id" DESC LIMIT $3 OFFSET $4`,
            [market.marketId, 'rejected', 25, 0],
          );
          const text = plan.rows.map((row: Record<string, string>) => row['QUERY PLAN']).join('\n');
          expect(text).toContain('seller_attributions_market_id_suspicious_idx');
        } finally {
          await sql.query('ROLLBACK');
        }
      });

      it('locks a live link only, for the claims through it', async () => {
        const shop = ids.next<'Seller'>();
        const first = await drawn(market, shop);
        expect(await inUnit(market, () => links.lockLive(market, first.id))).toBe(true);
        await drawn(market, shop);
        expect(await inUnit(market, () => links.lockLive(market, first.id))).toBe(false);
        expect(await inUnit(other, () => links.lockLive(other, first.id))).toBe(false);
        // The no-op write leaves the link as it was.
        expect(await inUnit(market, () => links.findByToken(market, first.token))).toMatchObject({
          revokedAt: T0,
        });
      });

      it('writes a decision only over the version read', async () => {
        const from = await drawn(market, ids.next<'Seller'>());
        const alice = await customer(market);
        await inUnit(market, () => attributions.insert(market, attribution(alice, from)));
        const admin = ids.next<'Account'>();
        const rejected = attribution(alice, from, {
          status: 'rejected',
          rejectReason: 'admin',
          decidedByAccountId: admin,
          decidedAt: T0,
          version: 2,
        });
        expect(await inUnit(market, () => attributions.update(market, rejected, 1))).toBe(true);
        expect(await inUnit(market, () => attributions.update(market, rejected, 1))).toBe(false);
        expect(
          await inUnit(other, () => attributions.update(other, { ...rejected, version: 3 }, 2)),
        ).toBe(false);
        expect(await inUnit(market, () => attributions.findOf(market, alice))).toEqual(rejected);
      });

      it('counts by link and seller, and reads the admin list', async () => {
        const shop = ids.next<'Seller'>();
        const rival = ids.next<'Seller'>();
        const shopLink = await drawn(market, shop);
        const rivalLink = await drawn(market, rival);
        const prefix = `p4a${code.toLowerCase()}${tokenCount}`;
        const alice = await customer(market, `${prefix}alice@example.test`);
        const bob = await customer(market, `${prefix}bob@example.test`);
        const staff = await customer(market, `${prefix}staff@example.test`);
        await inUnit(market, async () => {
          await attributions.insert(market, attribution(alice, shopLink));
          await attributions.insert(
            market,
            attribution(bob, rivalLink, {
              attributedAt: T0.add({ hours: 1 }),
              flags: ['link-burst'],
            }),
          );
          await attributions.insert(
            market,
            attribution(staff, shopLink, {
              attributedAt: T0.add({ hours: 25 }),
              status: 'rejected',
              rejectReason: 'seller-team',
            }),
          );
        });
        expect(
          await inUnit(market, () =>
            attributions.countOfSellerSince(market, shop, T0.add({ hours: 1 })),
          ),
        ).toBe(1);
        expect(await inUnit(market, () => attributions.countsOfSeller(market, shop))).toEqual({
          active: 1,
          rejected: 1,
        });
        expect(await inUnit(other, () => attributions.countsOfSeller(other, shop))).toEqual({
          active: 0,
          rejected: 0,
        });
        // The admin's monthly trend: active attributions per window, rejected ones left out.
        const windows = [
          { from: T0.subtract({ hours: 24 }), to: T0 },
          { from: T0, to: T0.add({ hours: 48 }) },
        ];
        expect(
          await inUnit(market, () =>
            attributions.activeCountsOfSellerBetween(market, shop, windows),
          ),
        ).toEqual([0, 1]);
        expect(
          await inUnit(market, () =>
            attributions.activeCountsOfSellerBetween(market, rival, [
              { from: T0, to: T0.add({ hours: 1 }) },
              { from: T0.add({ hours: 1 }), to: T0.add({ hours: 2 }) },
            ]),
          ),
        ).toEqual([0, 1]);
        expect(
          await inUnit(other, () => attributions.activeCountsOfSellerBetween(other, shop, windows)),
        ).toEqual([0, 0]);

        const mine = { ...ALL, emailPrefix: prefix };
        const accounts = (selector: ZonedAttributionSelector, direction: 'asc' | 'desc' = 'desc') =>
          inUnit(market, () =>
            attributions.page(market, selector, direction, { offset: 0, limit: 10 }),
          ).then((rows) => rows.map((row) => row.accountId));
        expect(await accounts(mine)).toEqual([staff, bob, alice]);
        expect(await accounts(mine, 'asc')).toEqual([alice, bob, staff]);
        expect(await accounts({ ...mine, view: 'suspicious' })).toEqual([staff, bob]);
        expect(await accounts({ ...mine, view: 'active' })).toEqual([bob, alice]);
        expect(await accounts({ ...mine, emailPrefix: `${prefix}b` })).toEqual([bob]);
        expect(await accounts({ ...mine, sellerId: shop })).toEqual([staff, alice]);
        expect(await accounts({ ...mine, flag: 'link-burst' })).toEqual([bob]);
        expect(await accounts({ ...mine, rejectReason: 'seller-team' })).toEqual([staff]);
        expect(await accounts({ ...mine, attributedFrom: '2026-11-18' })).toEqual([staff]);
        expect(await accounts({ ...mine, attributedTo: '2026-11-17' })).toEqual([bob, alice]);
        // The days are cut in the query's zone: 04:00 and 05:00 UTC on the 17th are the 16th in
        // Los Angeles, and staff's 05:00 UTC on the 18th is the 17th there.
        const pacific = { ...mine, dayZone: 'America/Los_Angeles' };
        expect(await accounts({ ...pacific, attributedTo: '2026-11-16' })).toEqual([bob, alice]);
        expect(await accounts({ ...pacific, attributedFrom: '2026-11-17' })).toEqual([staff]);
        expect(
          await accounts({ ...pacific, attributedFrom: '2026-11-17', attributedTo: '2026-11-17' }),
        ).toEqual([staff]);
        expect(await inUnit(market, () => attributions.count(market, mine))).toBe(3);
        expect(await inUnit(market, () => attributions.accountIds(market, mine, 2))).toEqual([
          staff,
          bob,
        ]);
        const counts = await inUnit(market, () => attributions.viewCounts(market));
        expect(counts.all).toBeGreaterThanOrEqual(3);
        expect(counts.suspicious).toBe(
          counts.rejected +
            (await inUnit(market, () =>
              attributions.count(market, {
                ...ALL,
                view: 'all',
                flag: 'link-burst',
                status: 'active',
              }),
            )),
        );
        const listed = await inUnit(market, () =>
          attributions.findListed(market, [bob, ids.next<'Account'>(), alice]),
        );
        expect(listed.map((row) => [row.accountId, row.email])).toEqual([
          [bob, `${prefix}bob@example.test`],
          [alice, `${prefix}alice@example.test`],
        ]);
        expect(await inUnit(other, () => attributions.findListed(other, [bob, alice]))).toEqual([]);
        expect(
          await inUnit(other, () =>
            attributions.page(other, mine, 'desc', { offset: 0, limit: 10 }),
          ),
        ).toEqual([]);
      });
    });
  },
);
