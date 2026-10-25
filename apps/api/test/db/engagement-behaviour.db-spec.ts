import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { ForgetAccount } from '../../src/modules/engagement/application/use-cases/forget-account.use-case';
import { PurgeExpiredEvents } from '../../src/modules/engagement/application/use-cases/purge-expired-events.use-case';
import { RecentViewsOfCustomer } from '../../src/modules/engagement/application/use-cases/recent-views.use-case';
import { RecentViewsOfGuest } from '../../src/modules/engagement/application/use-cases/recent-views-guest.use-case';
import { RecordEvent } from '../../src/modules/engagement/application/use-cases/record-event.use-case';
import { RecordGuestEvent } from '../../src/modules/engagement/application/use-cases/record-guest-event.use-case';
import { SetPersonalization } from '../../src/modules/engagement/application/use-cases/set-personalization.use-case';
import { CryptoEngagementGuestTokens } from '../../src/modules/engagement/infrastructure/crypto-guest-tokens';
import { PrismaBehaviourEventRepository } from '../../src/modules/engagement/infrastructure/prisma-behaviour-event.repository';
import { PrismaPersonalizationSettingRepository } from '../../src/modules/engagement/infrastructure/prisma-personalization-setting.repository';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The behaviour store as the application role, in both Market fixtures: the real use cases on
// the real unit of work write each kind to its columns, keep a guest under its token's hash,
// delete on switch off, on account deletion and past retention (account 12 months, guest 30
// days), never across Markets; the CHECKs refuse a row without exactly one subject, an unknown
// kind or a kind with another kind's columns.

const T0 = Temporal.Instant.from('2026-10-18T09:00:00Z');
const CHECK = '23514';
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const quiet = { globalPrivacyControl: false };
const consented = { ...quiet, consent: true };

describe.each(TEST_MARKETS)('behaviour store in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const clock = new FixedClock(T0);
  const ids = new UuidV7IdGenerator(clock);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const guestTokens = new CryptoEngagementGuestTokens();
  let db: Persistence;
  let events: PrismaBehaviourEventRepository;
  let settings: PrismaPersonalizationSettingRepository;
  let sql: Client;

  beforeAll(async () => {
    db = createPersistence();
    events = new PrismaBehaviourEventRepository(db.service);
    settings = new PrismaPersonalizationSettingRepository(db.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });
  beforeEach(() => clock.set(T0));

  const deps = () => ({ unitOfWork: db.unitOfWork, events, settings, guestTokens, ids, clock });
  const customer = (target: MarketContext, accountId: Id<'Account'>) =>
    testCallContext(
      target,
      testAuthenticatedActor(target, {
        population: 'customer',
        accountId,
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
      'eng-db-abcd',
    );
  const rowsOf = async (where: string, value: string) =>
    (
      await sql.query<Record<string, unknown>>(
        `SELECT market_id, kind, product_id, offer_id, variant_id, category_id, search_query
           FROM engagement.behaviour_events WHERE ${where} = $1 ORDER BY occurred_at, id`,
        [value],
      )
    ).rows;

  it('writes each kind to its own columns under the account, in this Market only', async () => {
    const alice = ids.next<'Account'>();
    const [product, offer, variant, category] = [ids.next(), ids.next(), ids.next(), ids.next()];
    const record = new RecordEvent(gate, deps());
    for (const event of [
      { kind: 'product-viewed', productId: product, offerId: offer },
      { kind: 'category-viewed', categoryId: category },
      { kind: 'search-performed', query: ' Medjool  dates ' },
      { kind: 'added-to-cart', offerId: offer, variantId: variant },
    ]) {
      clock.advance(Temporal.Duration.from({ seconds: 1 }));
      expect(await record.execute(customer(market, alice), { event, ...quiet })).toEqual({
        ok: true,
        value: { recorded: true },
      });
    }
    const base = { market_id: code, product_id: null, offer_id: null, variant_id: null };
    expect(await rowsOf('account_id', alice)).toEqual([
      {
        ...base,
        kind: 'product-viewed',
        product_id: product,
        offer_id: offer,
        category_id: null,
        search_query: null,
      },
      { ...base, kind: 'category-viewed', category_id: category, search_query: null },
      { ...base, kind: 'search-performed', category_id: null, search_query: 'Medjool dates' },
      {
        ...base,
        kind: 'added-to-cart',
        offer_id: offer,
        variant_id: variant,
        category_id: null,
        search_query: null,
      },
    ]);

    // Switching off in the other Market neither deletes nor stops anything here.
    await new SetPersonalization(gate, deps()).execute(customer(other, alice), { enabled: false });
    expect(await rowsOf('account_id', alice)).toHaveLength(4);
  });

  it('keeps a guest under the SHA-256 of the cookie token, never the token', async () => {
    const recordGuest = new RecordGuestEvent(gate, deps());
    const anonymous = testCallContext(market, 'anonymous');
    const first = await recordGuest.execute(anonymous, {
      event: { kind: 'category-viewed', categoryId: ids.next() },
      token: null,
      ...consented,
    });
    if (!first.ok || first.value.cookie?.action !== 'set') throw new Error('no cookie');
    const token = first.value.cookie.token;
    await recordGuest.execute(anonymous, {
      event: { kind: 'search-performed', query: 'lamb' },
      token,
      ...consented,
    });
    const hash = guestTokens.hashOf(token)!;
    expect(await rowsOf('guest_hash', hash)).toHaveLength(2);
    const leaked = await sql.query(
      'SELECT count(*)::int AS n FROM engagement.behaviour_events WHERE guest_hash = $1',
      [token.slice(0, 43)],
    );
    expect(leaked.rows[0]).toEqual({ n: 0 });
  });

  it('deletes on switch off and on account deletion, and keeps one switch row under concurrent saves', async () => {
    const bob = ids.next<'Account'>();
    const record = new RecordEvent(gate, deps());
    const set = new SetPersonalization(gate, deps());
    const event = { kind: 'product-viewed', productId: ids.next() };
    await record.execute(customer(market, bob), { event, ...quiet });

    const results = await Promise.all(
      [false, false, false].map((enabled) => set.execute(customer(market, bob), { enabled })),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    const switches = await sql.query(
      'SELECT count(*)::int AS n FROM engagement.personalization_settings WHERE account_id = $1',
      [bob],
    );
    expect(switches.rows[0]).toEqual({ n: 1 });
    expect(await rowsOf('account_id', bob)).toEqual([]);
    expect(await record.execute(customer(market, bob), { event, ...quiet })).toEqual({
      ok: true,
      value: { recorded: false },
    });

    await set.execute(customer(market, bob), { enabled: true });
    await record.execute(customer(market, bob), { event, ...quiet });
    const forget = new ForgetAccount(gate, deps());
    expect(await forget.execute(testCallContext(market, 'system'), { accountId: bob })).toEqual({
      ok: true,
      value: { events: 1 },
    });
    const left = await sql.query(
      `SELECT (SELECT count(*) FROM engagement.behaviour_events WHERE account_id = $1)::int AS events,
              (SELECT count(*) FROM engagement.personalization_settings WHERE account_id = $1)::int AS switches`,
      [bob],
    );
    expect(left.rows[0]).toEqual({ events: 0, switches: 0 });
  });

  it('leaves no event behind when a switch-off races with events being recorded', async () => {
    const dana = ids.next<'Account'>();
    const record = new RecordEvent(gate, deps());
    const set = new SetPersonalization(gate, deps());
    const event = { kind: 'product-viewed', productId: ids.next() };
    const results = await Promise.all([
      ...[1, 2, 3, 4].map(() => record.execute(customer(market, dana), { event, ...quiet })),
      set.execute(customer(market, dana), { enabled: false }),
      ...[5, 6, 7, 8].map(() => record.execute(customer(market, dana), { event, ...quiet })),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(await rowsOf('account_id', dana)).toEqual([]);
  });

  it('keeps every call ok and no event after an off, over 20 rounds of the race', async () => {
    // The account lock (engagement.lock-account) instead of SERIALIZABLE: no 40001 to lose, so
    // every call of every round succeeds, and an off still leaves nothing behind.
    const erin = ids.next<'Account'>();
    const record = new RecordEvent(gate, deps());
    const set = new SetPersonalization(gate, deps());
    const event = { kind: 'product-viewed', productId: ids.next() };
    const records = (count: number) =>
      Array.from({ length: count }, () =>
        record.execute(customer(market, erin), { event, ...quiet }),
      );
    for (let round = 0; round < 20; round += 1) {
      const off = await Promise.all([
        ...records(4),
        set.execute(customer(market, erin), { enabled: false }),
        ...records(4),
      ]);
      expect(off.every((result) => result.ok)).toBe(true);
      expect(await rowsOf('account_id', erin)).toEqual([]);
      const on = await Promise.all([
        set.execute(customer(market, erin), { enabled: true }),
        ...records(4),
      ]);
      expect(on.every((result) => result.ok)).toBe(true);
    }
  });

  it('purges account events after 12 months and guest events after 30 days, per Market', async () => {
    const carol = ids.next<'Account'>();
    const record = new RecordEvent(gate, deps());
    const recordGuest = new RecordGuestEvent(gate, deps());
    const event = { kind: 'product-viewed', productId: ids.next() };
    const old = Temporal.Instant.from('2020-01-01T00:00:00Z');
    clock.set(old);
    await record.execute(customer(market, carol), { event, ...quiet });
    await record.execute(customer(other, carol), { event, ...quiet });
    const guest = await recordGuest.execute(testCallContext(market, 'anonymous'), {
      event,
      token: null,
      ...consented,
    });
    if (!guest.ok || guest.value.cookie?.action !== 'set') throw new Error('no cookie');
    const hash = guestTokens.hashOf(guest.value.cookie.token)!;

    // 30 days later: the guest's event goes, the account's stays.
    clock.set(old.add({ hours: 30 * 24, seconds: 1 }));
    const purge = new PurgeExpiredEvents(gate, deps());
    const system = testCallContext(market, 'system');
    const first = await purge.execute(system, {});
    expect(first.ok && first.value.guestEvents).toBeGreaterThanOrEqual(1);
    expect(await rowsOf('guest_hash', hash)).toEqual([]);
    expect(await rowsOf('account_id', carol)).toHaveLength(2);

    // A year and a moment later: the account's event in this Market goes; the other Market's stays.
    clock.set(Temporal.Instant.from('2021-01-01T00:00:00.001Z'));
    await purge.execute(system, {});
    expect((await rowsOf('account_id', carol)).map((row) => row.market_id)).toEqual([
      other.marketId,
    ]);
  });

  it('refuses a row without exactly one subject, an unknown kind or mixed columns', async () => {
    const insertRow = (
      subject: { account: string | null; guest: string | null },
      kind: string,
      columns: { product?: string; category?: string; query?: string },
    ) =>
      sql
        .query(
          `INSERT INTO engagement.behaviour_events
             (id, market_id, tenant_id, account_id, guest_hash, kind, product_id, category_id, search_query, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
          [
            ids.next(),
            market.marketId,
            market.tenantId,
            subject.account,
            subject.guest,
            kind,
            columns.product ?? null,
            columns.category ?? null,
            columns.query ?? null,
          ],
        )
        .then(
          () => 'allowed',
          (error: { code?: string }) => error.code,
        );
    const account = { account: ids.next(), guest: null };
    const hash = 'a'.repeat(64);
    expect(
      await insertRow({ account: null, guest: null }, 'search-performed', { query: 'x' }),
    ).toBe(CHECK);
    expect(
      await insertRow({ account: ids.next(), guest: hash }, 'search-performed', { query: 'x' }),
    ).toBe(CHECK);
    expect(
      await insertRow({ account: null, guest: 'A'.repeat(64) }, 'search-performed', { query: 'x' }),
    ).toBe(CHECK);
    expect(await insertRow(account, 'page-viewed', { query: 'x' })).toBe(CHECK);
    expect(await insertRow(account, 'search-performed', { query: 'x', product: ids.next() })).toBe(
      CHECK,
    );
    expect(await insertRow(account, 'search-performed', { query: ' x' })).toBe(CHECK);
    expect(await insertRow(account, 'category-viewed', {})).toBe(CHECK);
    expect(
      await insertRow({ account: null, guest: hash }, 'search-performed', { query: 'x' }),
    ).toBe('allowed');
  });
  describe('recent views (personalization 1d-1)', () => {
    const read = { globalPrivacyControl: false, consent: false, guestToken: null };
    const view = (kind: 'product-viewed' | 'category-viewed', id: Id) =>
      kind === 'product-viewed' ? { kind, productId: id } : { kind, categoryId: id };

    it('answers distinct ids, newest view first, in this Market and for this account only', async () => {
      const [alice, bob] = [ids.next<'Account'>(), ids.next<'Account'>()];
      const [one, two, three] = [ids.next(), ids.next(), ids.next()];
      const record = new RecordEvent(gate, deps());
      const at = async (
        who: Id<'Account'>,
        target: MarketContext,
        event: Record<string, unknown>,
      ) => {
        clock.advance(Temporal.Duration.from({ seconds: 1 }));
        await record.execute(customer(target, who), { event, ...quiet });
      };
      await at(alice, market, view('product-viewed', one));
      await at(alice, market, view('product-viewed', two));
      await at(alice, market, view('category-viewed', one));
      await at(alice, market, view('product-viewed', one));
      await at(alice, market, view('product-viewed', three));
      await at(alice, market, { kind: 'search-performed', query: 'lamb' });
      await at(bob, market, view('product-viewed', ids.next()));
      await at(alice, other, view('product-viewed', ids.next()));

      const recent = new RecentViewsOfCustomer(gate, deps());
      expect(await recent.execute(customer(market, alice), read)).toEqual({
        ok: true,
        value: { productIds: [three, one, two], categoryIds: [one] },
      });
      // The same account in the other Market sees only that Market's rows.
      const there = await recent.execute(customer(other, alice), read);
      expect(there.ok && there.value.productIds).toHaveLength(1);
      expect(there.ok && there.value.productIds).not.toContain(three);
    });

    it('answers at most 50 of each, the newest ones', async () => {
      const account = ids.next<'Account'>();
      const record = new RecordEvent(gate, deps());
      const products: Id<'Product'>[] = [];
      for (let n = 0; n < 53; n += 1) {
        clock.advance(Temporal.Duration.from({ seconds: 1 }));
        products.push(ids.next<'Product'>());
        await record.execute(customer(market, account), {
          event: { kind: 'product-viewed', productId: products[n] },
          ...quiet,
        });
      }

      const result = await new RecentViewsOfCustomer(gate, deps()).execute(
        customer(market, account),
        read,
      );

      expect(result.ok && result.value.productIds).toEqual(products.slice(3).reverse());
    });

    it('answers nothing, and reads nothing, with the switch off or Global Privacy Control', async () => {
      const account = ids.next<'Account'>();
      await new RecordEvent(gate, deps()).execute(customer(market, account), {
        event: { kind: 'product-viewed', productId: ids.next() },
        ...quiet,
      });
      const recent = new RecentViewsOfCustomer(gate, deps());
      const empty = { ok: true, value: { productIds: [], categoryIds: [] } };

      expect(
        await recent.execute(customer(market, account), { ...read, globalPrivacyControl: true }),
      ).toEqual(empty);
      await new SetPersonalization(gate, deps()).execute(customer(market, account), {
        enabled: false,
      });
      expect(await recent.execute(customer(market, account), read)).toEqual(empty);
    });

    it('answers a guest by the hash of the cookie token, only with consent, and sets no cookie', async () => {
      const anonymous = testCallContext(market, 'anonymous');
      const product = ids.next<'Product'>();
      const first = await new RecordGuestEvent(gate, deps()).execute(anonymous, {
        event: { kind: 'product-viewed', productId: product },
        token: null,
        ...consented,
      });
      if (!first.ok || first.value.cookie?.action !== 'set') throw new Error('no cookie');
      const guest = {
        globalPrivacyControl: false,
        consent: true,
        guestToken: first.value.cookie.token,
      };
      const recent = new RecentViewsOfGuest(gate, deps());

      expect(await recent.execute(anonymous, guest)).toEqual({
        ok: true,
        value: { productIds: [product], categoryIds: [] },
      });
      expect(await recent.execute(anonymous, { ...guest, consent: false })).toEqual({
        ok: true,
        value: { productIds: [], categoryIds: [] },
      });
      // Another Market's request with the same token finds nothing.
      expect(await recent.execute(testCallContext(other, 'anonymous'), guest)).toEqual({
        ok: true,
        value: { productIds: [], categoryIds: [] },
      });
      const rows = await sql.query(
        'SELECT count(*)::int AS n FROM engagement.behaviour_events WHERE product_id = $1',
        [product],
      );
      expect(rows.rows[0]).toEqual({ n: 1 });
    });

    it('reads a subject through the (market, subject, time) index', async () => {
      // Enough rows of other subjects for the planner to prefer the subject's index, as the
      // owner (statistics need ANALYZE); the rows are removed afterwards.
      const owner = new Client({ connectionString: ownerTestDatabaseUrl() });
      await owner.connect();
      const tag = ids.next<'Account'>();
      try {
        await owner.query(
          `INSERT INTO engagement.behaviour_events
             (id, market_id, tenant_id, account_id, guest_hash, kind, product_id, occurred_at)
           SELECT gen_random_uuid(), $1, 'plan-test',
                  CASE WHEN n % 2 = 0 THEN gen_random_uuid() END,
                  CASE WHEN n % 2 = 1 THEN md5(n::text) || md5((n + 1)::text) END,
                  'product-viewed', gen_random_uuid(), now() - (n || ' seconds')::interval
             FROM generate_series(1, 4000) AS n`,
          [code],
        );
        await owner.query('ANALYZE engagement.behaviour_events');
        const plan = async (subject: 'account_id' | 'guest_hash', value: string) => {
          const result = await owner.query<{ 'QUERY PLAN': string }>(
            `EXPLAIN SELECT product_id, max(occurred_at) FROM engagement.behaviour_events
              WHERE market_id = $1 AND ${subject} = $2 AND kind = 'product-viewed'
              GROUP BY product_id ORDER BY max(occurred_at) DESC, product_id LIMIT 50`,
            [code, value],
          );
          return result.rows.map((row) => row['QUERY PLAN']).join('\n');
        };

        expect(await plan('account_id', tag)).toContain(
          'behaviour_events_market_id_account_id_occurred_at_idx',
        );
        expect(await plan('guest_hash', 'a'.repeat(64))).toContain(
          'behaviour_events_market_id_guest_hash_occurred_at_idx',
        );
      } finally {
        await owner.query(
          "DELETE FROM engagement.behaviour_events WHERE market_id = $1 AND tenant_id = 'plan-test'",
          [code],
        );
        await owner.end();
      }
    });
  });
});
