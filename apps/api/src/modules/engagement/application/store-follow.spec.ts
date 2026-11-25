import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { MAX_FOLLOWS_PER_ACCOUNT } from '../domain/store-follow';
import { EngagementFacadeImplementation } from '../presentation/engagement.facade';
import type { EngagementDependencies } from './engagement-dependencies';
import {
  FakeEngagementGuestTokens,
  FakePublishedStores,
  InMemoryBehaviourEvents,
  InMemoryPersonalizationSettings,
  InMemoryStoreFollows,
  RecordingEngagementOutbox,
} from './testing/in-memory-engagement';
import { FollowStore } from './use-cases/follow-store.use-case';
import { FollowedAmong } from './use-cases/followed-among.use-case';
import { FollowsOfAccount } from './use-cases/follows-of-account.use-case';
import { ForgetAccount } from './use-cases/forget-account.use-case';
import { ListMyStores } from './use-cases/list-my-stores.use-case';
import { OwnFollowedAmong } from './use-cases/own-followed-among.use-case';
import { RecentViewsOfGuest } from './use-cases/recent-views-guest.use-case';
import { RecentViewsOfCustomer } from './use-cases/recent-views.use-case';
import { UnfollowStore } from './use-cases/unfollow-store.use-case';
import { ViewStoreFollow } from './use-cases/view-store-follow.use-case';

// Store follows (customers management phase 3) in memory on both Market fixtures: a customer
// follows a published store once, unfollows it, lists their stores newest first; each change sends
// one event with ids only; the read for promotions answers the system actor and the customer about
// themself only; erasure removes the follows without events; nothing crosses Markets.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-16T09:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ALICE = id<'Account'>(0xa1);
const BOB = id<'Account'>(0xb2);
const SHOP = id<'Seller'>(0x51);
const OTHER_SHOP = id<'Seller'>(0x52);
const HIDDEN_SHOP = id<'Seller'>(0x53);

describe.each([['AU'], ['ZZ']] as const)('store follows in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const as = (
    population: 'customer' | 'seller' | 'admin',
    accountId: Id<'Account'>,
    target = market,
  ) =>
    testCallContext(
      target,
      testAuthenticatedActor(target, {
        population,
        accountId,
        sessionId: id<'Session'>(0x61),
        sellerId: population === 'seller' ? SHOP : null,
      }),
      `follow-${population}-abcd`,
    );
  const alice = as('customer', ALICE);
  const bob = as('customer', BOB);
  const system = testCallContext(market, 'system');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });

  let clock: FixedClock;
  let follows: InMemoryStoreFollows;
  let stores: FakePublishedStores;
  let outbox: RecordingEngagementOutbox;
  let uc: {
    follow: FollowStore;
    unfollow: UnfollowStore;
    view: ViewStoreFollow;
    mine: ListMyStores;
    forget: ForgetAccount;
    facade: EngagementFacadeImplementation;
  };

  beforeEach(() => {
    clock = new FixedClock(T0);
    follows = new InMemoryStoreFollows();
    stores = new FakePublishedStores();
    stores.slugs.set(SHOP, 'green-valley');
    stores.slugs.set(OTHER_SHOP, 'olive-house');
    outbox = new RecordingEngagementOutbox();
    const deps: EngagementDependencies = {
      unitOfWork: new FakeUnitOfWork(),
      events: new InMemoryBehaviourEvents(),
      settings: new InMemoryPersonalizationSettings(),
      guestTokens: new FakeEngagementGuestTokens(),
      follows,
      stores,
      outbox,
      ids: new SequenceIdGenerator(clock),
      clock,
    };
    const forget = new ForgetAccount(gate, deps);
    const follow = new FollowStore(gate, deps);
    uc = {
      follow,
      unfollow: new UnfollowStore(gate, deps),
      view: new ViewStoreFollow(gate, deps),
      mine: new ListMyStores(gate, deps),
      forget,
      facade: new EngagementFacadeImplementation({
        forgetAccount: forget,
        recentViewsOfCustomer: new RecentViewsOfCustomer(gate, deps),
        recentViewsOfGuest: new RecentViewsOfGuest(gate, deps),
        followedAmong: new FollowedAmong(gate, deps),
        ownFollowedAmong: new OwnFollowedAmong(gate, deps),
        followsOfAccount: new FollowsOfAccount(gate, deps),
        followStore: follow,
        shoppingFunnel: null as never,
      }),
    };
  });

  it('follows a published store once, with one event of ids only', async () => {
    const first = await uc.follow.execute(alice, { sellerId: SHOP });
    expect(first).toEqual({
      ok: true,
      value: { sellerId: SHOP, following: true, followedAt: T0 },
    });
    clock.advance(Temporal.Duration.from({ minutes: 5 }));
    // A second follow changes nothing: the instant stays, and no second event is sent.
    expect(await uc.follow.execute(alice, { sellerId: SHOP })).toEqual(first);
    expect(outbox.events).toHaveLength(1);
    expect(outbox.events[0]).toMatchObject({
      type: 'engagement.store-followed.v1',
      aggregateVersion: 1,
      payload: { accountId: ALICE, sellerId: SHOP },
    });
    expect(Object.keys(outbox.events[0]!.payload as object).sort()).toEqual([
      'accountId',
      'sellerId',
    ]);
    expect(await uc.view.execute(alice, { sellerId: SHOP })).toEqual(first);
    expect(await uc.view.execute(bob, { sellerId: SHOP })).toEqual({
      ok: true,
      value: { sellerId: SHOP, following: false, followedAt: null },
    });
  });

  it('refuses a store that is not published, a bad id, and fails closed when stores are down', async () => {
    expect(await uc.follow.execute(alice, { sellerId: HIDDEN_SHOP })).toEqual({
      ok: false,
      error: { code: 'engagement.store-not-found' },
    });
    expect(await uc.follow.execute(alice, { sellerId: 'not-an-id' })).toMatchObject({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'sellerId', code: 'format' }] },
    });
    stores.down = true;
    expect(await uc.follow.execute(alice, { sellerId: SHOP })).toEqual({
      ok: false,
      error: { code: 'engagement.unavailable' },
    });
    expect(follows.rows).toEqual([]);
    expect(outbox.events).toEqual([]);
  });

  it(`stops at ${MAX_FOLLOWS_PER_ACCOUNT} stores`, async () => {
    for (let n = 0; n < MAX_FOLLOWS_PER_ACCOUNT; n += 1) {
      follows.rows.push({
        marketId: code,
        id: id<'StoreFollow'>(0x10000 + n),
        accountId: ALICE,
        sellerId: id<'Seller'>(0x20000 + n),
        followedAt: T0,
      });
    }
    expect(await uc.follow.execute(alice, { sellerId: SHOP })).toEqual({
      ok: false,
      error: { code: 'engagement.follow-limit' },
    });
    expect(await uc.follow.execute(bob, { sellerId: SHOP })).toMatchObject({ ok: true });
  });

  it('unfollows with one event; unfollowing again changes nothing', async () => {
    await uc.follow.execute(alice, { sellerId: SHOP });
    expect(await uc.unfollow.execute(alice, { sellerId: SHOP })).toEqual({
      ok: true,
      value: { sellerId: SHOP, following: false, followedAt: null },
    });
    expect(await uc.unfollow.execute(alice, { sellerId: SHOP })).toMatchObject({ ok: true });
    expect(outbox.events.map((event) => [event.type, event.aggregateVersion])).toEqual([
      ['engagement.store-followed.v1', 1],
      ['engagement.store-unfollowed.v1', 2],
    ]);
    expect(follows.rows).toEqual([]);
  });

  it('lists the stores newest first in pages, with a null slug for a store no longer public', async () => {
    await uc.follow.execute(alice, { sellerId: SHOP });
    clock.advance(Temporal.Duration.from({ hours: 1 }));
    await uc.follow.execute(alice, { sellerId: OTHER_SHOP });
    stores.slugs.delete(SHOP);

    const first = await uc.mine.execute(alice, { limit: 1 });
    if (!first.ok) throw new Error('first page refused');
    expect(first.value.total).toBe(2);
    expect(first.value.items).toEqual([
      {
        sellerId: OTHER_SHOP,
        slug: 'olive-house',
        name: 'Store olive-house',
        logo: null,
        followedAt: T0.add({ hours: 1 }),
      },
    ]);
    expect(first.value.nextCursor).not.toBeNull();
    const second = await uc.mine.execute(alice, { limit: 1, cursor: first.value.nextCursor });
    expect(second).toEqual({
      ok: true,
      value: {
        items: [{ sellerId: SHOP, slug: null, name: null, logo: null, followedAt: T0 }],
        total: 2,
        nextCursor: null,
      },
    });
    expect(await uc.mine.execute(alice, { limit: 101 })).toMatchObject({
      ok: false,
      error: { code: 'validation.failed' },
    });
    expect(await uc.mine.execute(alice, { cursor: 'abc' })).toMatchObject({
      ok: false,
      error: { code: 'validation.failed' },
    });
  });

  it('shows the name and logo of a public store, and never those of a store that is not public now', async () => {
    const logo = { id: '0198a2c4-7d1e-7b3a-9c55-2f6e8a1b4d91', width: 512, height: 512 };
    stores.names.set(SHOP, 'Green Valley Halal');
    stores.logos.set(SHOP, logo);
    stores.names.set(OTHER_SHOP, 'Olive House');
    stores.logos.set(OTHER_SHOP, { ...logo, id: '0198a2c4-7d1e-7b3a-9c55-2f6e8a1b4d92' });
    await uc.follow.execute(alice, { sellerId: SHOP });
    clock.advance(Temporal.Duration.from({ hours: 1 }));
    await uc.follow.execute(alice, { sellerId: OTHER_SHOP });

    const both = await uc.mine.execute(alice, {});
    expect(both).toMatchObject({
      ok: true,
      value: {
        items: [
          { sellerId: OTHER_SHOP, name: 'Olive House', slug: 'olive-house' },
          { sellerId: SHOP, name: 'Green Valley Halal', slug: 'green-valley', logo },
        ],
      },
    });

    // The store stops being public (suspended): the name and logo disappear from the answer.
    stores.slugs.delete(SHOP);
    const after = await uc.mine.execute(alice, {});
    if (!after.ok) throw new Error('refused');
    const gone = after.value.items.find((item) => item.sellerId === SHOP);
    expect(gone).toEqual({ sellerId: SHOP, slug: null, name: null, logo: null, followedAt: T0 });
    expect(
      JSON.stringify(after, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}` : v)),
    ).not.toContain('Green Valley Halal');
  });

  it('fails closed when the store names cannot be read: no partial page', async () => {
    await uc.follow.execute(alice, { sellerId: SHOP });
    stores.down = true;

    expect(await uc.mine.execute(alice, {})).toEqual({
      ok: false,
      error: { code: 'engagement.unavailable' },
    });
  });

  it('refuses every caller that is not a customer', async () => {
    for (const caller of [as('seller', ALICE), as('admin', ALICE)]) {
      expect(await uc.follow.execute(caller, { sellerId: SHOP })).toMatchObject({ ok: false });
      expect(await uc.mine.execute(caller, {})).toMatchObject({ ok: false });
    }
    expect(
      await uc.follow.execute(testCallContext(market, 'anonymous'), { sellerId: SHOP }),
    ).toMatchObject({ ok: false });
    expect(await uc.follow.execute(system, { sellerId: SHOP })).toMatchObject({ ok: false });
    expect(follows.rows).toEqual([]);
  });

  it('answers which stores an account follows to the system actor and to that customer only', async () => {
    await uc.follow.execute(alice, { sellerId: SHOP });
    expect(await uc.facade.followedAmong(system, ALICE, [SHOP, OTHER_SHOP])).toEqual({
      ok: true,
      value: [SHOP],
    });
    expect(await uc.facade.followedAmong(alice, ALICE, [SHOP, OTHER_SHOP])).toEqual({
      ok: true,
      value: [SHOP],
    });
    expect(await uc.facade.followedAmong(bob, ALICE, [SHOP])).toMatchObject({ ok: false });
    expect(await uc.facade.followedAmong(as('admin', BOB), ALICE, [SHOP])).toMatchObject({
      ok: false,
    });
    // No account at all is refused before the ownership comparison (null !== null is false).
    const none = null as unknown as Id<'Account'>;
    expect(await uc.facade.followedAmong(as('admin', BOB), none, [SHOP])).toMatchObject({
      ok: false,
    });
    expect(await uc.facade.followedAmong(system, none, [SHOP])).toMatchObject({ ok: false });
    const many = Array.from({ length: 101 }, (_, n) => id<'Seller'>(0x30000 + n));
    expect(await uc.facade.followedAmong(system, ALICE, many)).toMatchObject({ ok: false });
    expect(await uc.facade.followsOfAccount(system, ALICE)).toEqual({
      ok: true,
      value: [{ sellerId: SHOP, followedAt: T0 }],
    });
    expect(await uc.facade.followsOfAccount(alice, ALICE)).toMatchObject({ ok: false });
  });

  it('follows a store through the facade for the signed-in customer only', async () => {
    // The automatic follow after joining a store through its invite link (customers phase 4a).
    expect(await uc.facade.followStore(alice, SHOP)).toEqual({
      ok: true,
      value: { following: true },
    });
    expect(outbox.events).toHaveLength(1);
    expect(await uc.facade.followStore(alice, SHOP)).toEqual({
      ok: true,
      value: { following: true },
    });
    expect(outbox.events).toHaveLength(1);
    expect(await uc.facade.followStore(system, SHOP)).toMatchObject({ ok: false });
    expect(await uc.facade.followStore(as('admin', BOB), SHOP)).toMatchObject({ ok: false });
  });

  it('keeps each Market apart', async () => {
    await uc.follow.execute(alice, { sellerId: SHOP });
    const elsewhere = testCallContext(other, 'system');
    expect(await uc.facade.followsOfAccount(elsewhere, ALICE)).toEqual({ ok: true, value: [] });
    expect(await uc.view.execute(as('customer', ALICE, other), { sellerId: SHOP })).toEqual({
      ok: true,
      value: { sellerId: SHOP, following: false, followedAt: null },
    });
  });

  it('removes the follows when the account is erased, without an event', async () => {
    await uc.follow.execute(alice, { sellerId: SHOP });
    await uc.follow.execute(bob, { sellerId: SHOP });
    const sent = outbox.events.length;
    expect(await uc.forget.execute(system, { accountId: ALICE })).toMatchObject({ ok: true });
    expect(follows.rows.map((row) => row.accountId)).toEqual([BOB]);
    expect(outbox.events).toHaveLength(sent);
  });
});
