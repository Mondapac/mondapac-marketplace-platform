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
import { normalizeSearchQuery, retentionEdges } from '../domain/behaviour-event';
import { EngagementFacadeImplementation } from '../presentation/engagement.facade';
import type { EngagementDependencies } from './engagement-dependencies';
import {
  FakeEngagementGuestTokens,
  InMemoryBehaviourEvents,
  InMemoryPersonalizationSettings,
} from './testing/in-memory-engagement';
import { ForgetAccount } from './use-cases/forget-account.use-case';
import { PurgeExpiredEvents } from './use-cases/purge-expired-events.use-case';
import { RecentViewsOfGuest } from './use-cases/recent-views-guest.use-case';
import { RecentViewsOfCustomer } from './use-cases/recent-views.use-case';
import { RecordEvent } from './use-cases/record-event.use-case';
import { RecordGuestEvent } from './use-cases/record-guest-event.use-case';
import { SetPersonalization } from './use-cases/set-personalization.use-case';
import { ViewPersonalization } from './use-cases/view-personalization.use-case';

// Behaviour capture in memory on both Market fixtures: ids only, under the account or the guest
// cookie's hash; Global Privacy Control and the customer's switch record nothing; switching off
// deletes; retention is 12 months for an account and 30 days for a guest; every other actor is
// refused; nothing crosses Markets.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-18T09:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ALICE = id<'Account'>(0xa1);
const BOB = id<'Account'>(0xb2);
const PRODUCT = id<'Product'>(0x101);
const OFFER = id<'Offer'>(0x201);
const VARIANT = id<'Variant'>(0x301);
const CATEGORY = id<'Category'>(0x401);

describe.each([['AU'], ['ZZ']] as const)('behaviour capture in market %s', (code) => {
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
        sellerId: population === 'seller' ? id<'Seller'>(0x51) : null,
      }),
      `eng-${population}-abcd`,
    );
  const alice = as('customer', ALICE);
  const bob = as('customer', BOB);
  const system = testCallContext(market, 'system');
  const anonymous = testCallContext(market, 'anonymous');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const viewed = { kind: 'product-viewed', productId: PRODUCT, offerId: OFFER };
  const quiet = { globalPrivacyControl: false };
  const consented = { ...quiet, consent: true };

  let clock: FixedClock;
  let events: InMemoryBehaviourEvents;
  let settings: InMemoryPersonalizationSettings;
  let tokens: FakeEngagementGuestTokens;
  let uc: {
    record: RecordEvent;
    recordGuest: RecordGuestEvent;
    view: ViewPersonalization;
    set: SetPersonalization;
    purge: PurgeExpiredEvents;
    forget: ForgetAccount;
    recent: RecentViewsOfCustomer;
    recentGuest: RecentViewsOfGuest;
  };

  beforeEach(() => {
    clock = new FixedClock(T0);
    events = new InMemoryBehaviourEvents();
    settings = new InMemoryPersonalizationSettings();
    tokens = new FakeEngagementGuestTokens();
    const deps: EngagementDependencies = {
      unitOfWork: new FakeUnitOfWork(),
      events,
      settings,
      guestTokens: tokens,
      ids: new SequenceIdGenerator(clock),
      clock,
    };
    uc = {
      record: new RecordEvent(gate, deps),
      recordGuest: new RecordGuestEvent(gate, deps),
      view: new ViewPersonalization(gate, deps),
      set: new SetPersonalization(gate, deps),
      purge: new PurgeExpiredEvents(gate, deps),
      forget: new ForgetAccount(gate, deps),
      recent: new RecentViewsOfCustomer(gate, deps),
      recentGuest: new RecentViewsOfGuest(gate, deps),
    };
  });

  describe('a signed-in customer', () => {
    it('records each kind under the account, by ids, with the time of the clock', async () => {
      for (const event of [
        viewed,
        { kind: 'category-viewed', categoryId: CATEGORY },
        { kind: 'search-performed', query: '  Halal   lamb\tmince ' },
        { kind: 'added-to-cart', offerId: OFFER, variantId: VARIANT },
      ]) {
        expect(await uc.record.execute(alice, { event, ...quiet })).toEqual({
          ok: true,
          value: { recorded: true },
        });
      }
      expect(events.rows.map((row) => row.facts)).toEqual([
        { kind: 'product-viewed', productId: PRODUCT, offerId: OFFER },
        { kind: 'category-viewed', categoryId: CATEGORY },
        { kind: 'search-performed', query: 'Halal lamb mince' },
        { kind: 'added-to-cart', offerId: OFFER, variantId: VARIANT },
      ]);
      expect(
        events.rows.every(
          (row) =>
            row.marketId === code &&
            row.subject.kind === 'account' &&
            row.subject.accountId === ALICE &&
            row.occurredAt.equals(T0),
        ),
      ).toBe(true);
    });

    it('records nothing under Global Privacy Control', async () => {
      expect(await uc.record.execute(alice, { event: viewed, globalPrivacyControl: true })).toEqual(
        { ok: true, value: { recorded: false } },
      );
      expect(events.rows).toEqual([]);
    });

    it('stops recording and deletes what was recorded when switched off; on again records', async () => {
      await uc.record.execute(alice, { event: viewed, ...quiet });
      await uc.record.execute(bob, { event: viewed, ...quiet });
      expect(await uc.view.execute(alice, {})).toEqual({
        ok: true,
        value: { enabled: true, changedAt: null },
      });

      expect(await uc.set.execute(alice, { enabled: false })).toEqual({
        ok: true,
        value: { enabled: false, changedAt: T0 },
      });
      expect(events.rows.map((row) => row.subject)).toEqual([{ kind: 'account', accountId: BOB }]);
      expect(await uc.record.execute(alice, { event: viewed, ...quiet })).toEqual({
        ok: true,
        value: { recorded: false },
      });

      clock.advance(Temporal.Duration.from({ minutes: 5 }));
      // The value it already has changes nothing, not even the time.
      expect(await uc.set.execute(alice, { enabled: false })).toEqual({
        ok: true,
        value: { enabled: false, changedAt: T0 },
      });
      expect(await uc.set.execute(alice, { enabled: true })).toMatchObject({
        ok: true,
        value: { enabled: true },
      });
      expect(await uc.record.execute(alice, { event: viewed, ...quiet })).toEqual({
        ok: true,
        value: { recorded: true },
      });
    });

    it('refuses a switch without a boolean `enabled`', async () => {
      expect(await uc.set.execute(alice, {})).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'enabled', code: 'required' }] },
      });
      expect(await uc.set.execute(alice, { enabled: 'no' })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'enabled', code: 'type' }] },
      });
    });

    it('refuses a seller, an admin, a guest and the system actor', async () => {
      for (const context of [as('seller', ALICE), as('admin', ALICE), anonymous, system]) {
        expect(await uc.record.execute(context, { event: viewed, ...quiet })).toMatchObject({
          ok: false,
        });
        expect(await uc.view.execute(context, {})).toMatchObject({ ok: false });
        expect(await uc.set.execute(context, { enabled: false })).toMatchObject({ ok: false });
      }
      expect(events.rows).toEqual([]);
    });
  });

  describe('a guest', () => {
    it('gets a new token on the first event and keeps it on the next', async () => {
      const first = await uc.recordGuest.execute(anonymous, {
        event: viewed,
        token: null,
        ...consented,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value.recorded).toBe(true);
      const cookie = first.value.cookie;
      if (cookie?.action !== 'set') throw new Error('no cookie set');
      const token = cookie.token;

      const second = await uc.recordGuest.execute(anonymous, {
        event: { kind: 'search-performed', query: 'dates' },
        token,
        ...consented,
      });
      expect(second).toEqual({ ok: true, value: { recorded: true, cookie: null } });
      expect(events.rows.map((row) => row.subject)).toEqual([
        { kind: 'guest', guestHash: tokens.hashOf(token) },
        { kind: 'guest', guestHash: tokens.hashOf(token) },
      ]);
    });

    it('replaces a malformed token; under GPC records nothing and expires a cookie sent', async () => {
      const replaced = await uc.recordGuest.execute(anonymous, {
        event: viewed,
        token: 'not-a-token',
        ...consented,
      });
      expect(replaced).toMatchObject({ ok: true, value: { cookie: { action: 'set' } } });

      expect(
        await uc.recordGuest.execute(anonymous, {
          event: viewed,
          token: null,
          globalPrivacyControl: true,
          consent: true,
        }),
      ).toEqual({ ok: true, value: { recorded: false, cookie: null } });
      expect(
        await uc.recordGuest.execute(anonymous, {
          event: viewed,
          token: 'g'.repeat(43),
          globalPrivacyControl: true,
          consent: true,
        }),
      ).toEqual({ ok: true, value: { recorded: false, cookie: { action: 'clear' } } });
      expect(events.rows).toHaveLength(1);
    });

    it("without the buyer's consent records nothing, sets no cookie and expires one sent", async () => {
      const none = { ...quiet, consent: false };
      expect(
        await uc.recordGuest.execute(anonymous, { event: viewed, token: null, ...none }),
      ).toEqual({ ok: true, value: { recorded: false, cookie: null } });
      expect(
        await uc.recordGuest.execute(anonymous, { event: viewed, token: 'g'.repeat(43), ...none }),
      ).toEqual({ ok: true, value: { recorded: false, cookie: { action: 'clear' } } });
      expect(
        await uc.recordGuest.execute(anonymous, { event: {}, token: null, ...none }),
      ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      expect(events.rows).toEqual([]);
    });

    it('refuses the system actor', async () => {
      expect(
        await uc.recordGuest.execute(system, { event: viewed, token: null, ...consented }),
      ).toMatchObject({ ok: false });
    });
  });

  describe('event bodies', () => {
    it.each([
      [{}, [{ path: 'kind', code: 'required' }]],
      [{ kind: 'page-viewed' }, [{ path: 'kind', code: 'one-of' }]],
      [{ kind: 'product-viewed' }, [{ path: 'productId', code: 'required' }]],
      [{ kind: 'product-viewed', productId: 'abc' }, [{ path: 'productId', code: 'format' }]],
      [
        { kind: 'category-viewed', categoryId: CATEGORY, query: 'x' },
        [{ path: 'query', code: 'not-allowed' }],
      ],
      [{ kind: 'search-performed', query: ' \u0000 ' }, [{ path: 'query', code: 'required' }]],
      [{ kind: 'search-performed', query: 7 }, [{ path: 'query', code: 'type' }]],
      [{ kind: 'search-performed', query: 'a'.repeat(201) }, [{ path: 'query', code: 'too-long' }]],
      [{ kind: 'added-to-cart', offerId: OFFER }, [{ path: 'variantId', code: 'required' }]],
    ])('refuses %j', async (event, fields) => {
      const expected = { ok: false, error: { code: 'validation.failed', fields } };
      expect(await uc.record.execute(alice, { event, ...quiet })).toEqual(expected);
      expect(await uc.recordGuest.execute(anonymous, { event, token: null, ...consented })).toEqual(
        expected,
      );
      expect(events.rows).toEqual([]);
    });

    it('normalizes the search text and accepts 200 characters', () => {
      expect(normalizeSearchQuery('é  x\r\ny ')).toBe('é x y');
      expect(normalizeSearchQuery('a'.repeat(200))).toHaveLength(200);
    });
  });

  describe('retention and deletion', () => {
    it('purges account events after 12 months and guest events after 30 days, in this Market only', async () => {
      await uc.record.execute(alice, { event: viewed, ...quiet });
      await uc.recordGuest.execute(anonymous, { event: viewed, token: null, ...consented });
      await events.append(other, {
        id: id<'BehaviourEvent'>(0x999),
        subject: { kind: 'guest', guestHash: 'x' },
        facts: { kind: 'category-viewed', categoryId: CATEGORY },
        occurredAt: T0,
      });

      clock.advance(Temporal.Duration.from({ hours: 30 * 24 }));
      expect(await uc.purge.execute(system, {})).toEqual({
        ok: true,
        value: { accountEvents: 0, guestEvents: 0 },
      });
      clock.advance(Temporal.Duration.from({ seconds: 1 }));
      expect(await uc.purge.execute(system, {})).toEqual({
        ok: true,
        value: { accountEvents: 0, guestEvents: 1 },
      });

      clock.set(Temporal.Instant.from('2027-10-18T09:00:00.001Z'));
      expect(await uc.purge.execute(system, {})).toEqual({
        ok: true,
        value: { accountEvents: 1, guestEvents: 0 },
      });
      expect(events.rows.map((row) => row.marketId)).toEqual([other.marketId]);
    });

    it('counts months on the UTC calendar', () => {
      expect(retentionEdges(Temporal.Instant.from('2027-03-31T00:00:00Z'))).toEqual({
        account: Temporal.Instant.from('2026-03-31T00:00:00Z'),
        guest: Temporal.Instant.from('2027-03-01T00:00:00Z'),
      });
    });

    it('forgets an account through the facade (system actor only)', async () => {
      await uc.record.execute(alice, { event: viewed, ...quiet });
      await uc.record.execute(bob, { event: viewed, ...quiet });
      await uc.set.execute(alice, { enabled: false });
      await uc.set.execute(alice, { enabled: true });
      const facade = new EngagementFacadeImplementation({
        forgetAccount: uc.forget,
        recentViewsOfCustomer: uc.recent,
        recentViewsOfGuest: uc.recentGuest,
      });

      expect(await facade.forgetAccount(alice, ALICE)).toMatchObject({ ok: false });
      expect(await facade.forgetAccount(system, ALICE)).toEqual({ ok: true, value: { events: 0 } });
      expect(settings.rows.size).toBe(0);
      expect(events.rows.map((row) => row.subject)).toEqual([{ kind: 'account', accountId: BOB }]);
      expect(await facade.forgetAccount(system, BOB)).toEqual({ ok: true, value: { events: 1 } });
    });

    it('keeps a customer of another Market apart', async () => {
      const elsewhere = as('customer', ALICE, other);
      await uc.set.execute(elsewhere, { enabled: false });
      expect(await uc.record.execute(alice, { event: viewed, ...quiet })).toEqual({
        ok: true,
        value: { recorded: true },
      });
    });
  });
  describe('recent views (personalization 1d-1)', () => {
    const product = (n: number) => id<'Product'>(0x1100 + n);
    const category = (n: number) => id<'Category'>(0x1200 + n);
    const viewProduct = (n: number) => ({ kind: 'product-viewed', productId: product(n) });
    const viewCategory = (n: number) => ({ kind: 'category-viewed', categoryId: category(n) });
    const read = { globalPrivacyControl: false, consent: false, guestToken: null };
    const EMPTY = { ok: true, value: { productIds: [], categoryIds: [] } };
    const facade = () =>
      new EngagementFacadeImplementation({
        forgetAccount: uc.forget,
        recentViewsOfCustomer: uc.recent,
        recentViewsOfGuest: uc.recentGuest,
      });
    const record = async (who: CallContextLike, ...bodies: Record<string, unknown>[]) => {
      for (const event of bodies) {
        clock.set(clock.now().add({ seconds: 1 }));
        await uc.record.execute(who, { event, ...quiet });
      }
    };
    type CallContextLike = typeof alice;

    it("answers a customer's distinct ids, newest view first, ids only", async () => {
      await record(
        alice,
        viewProduct(1),
        viewProduct(2),
        viewCategory(1),
        viewProduct(1),
        viewCategory(2),
        { kind: 'search-performed', query: 'lamb' },
        { kind: 'added-to-cart', offerId: OFFER, variantId: VARIANT },
      );

      expect(await facade().recentViews(alice, read)).toEqual({
        ok: true,
        value: {
          productIds: [product(1), product(2)],
          categoryIds: [category(2), category(1)],
        },
      });
    });

    it('answers at most 50 of each', async () => {
      for (let n = 0; n < 55; n += 1) await record(alice, viewProduct(n), viewCategory(n));

      const result = await facade().recentViews(alice, read);

      expect(result.ok && result.value.productIds).toHaveLength(50);
      expect(result.ok && result.value.categoryIds).toHaveLength(50);
      expect(result.ok && result.value.productIds[0]).toBe(product(54));
    });

    it('is empty with Global Privacy Control, and reads nothing', async () => {
      await record(alice, viewProduct(1));

      expect(await facade().recentViews(alice, { ...read, globalPrivacyControl: true })).toEqual(
        EMPTY,
      );
    });

    it('is empty with the customer switch off, and again with it on after a new view', async () => {
      await record(alice, viewProduct(1));
      await uc.set.execute(alice, { enabled: false });
      expect(await facade().recentViews(alice, read)).toEqual(EMPTY);

      await uc.set.execute(alice, { enabled: true });
      expect(await facade().recentViews(alice, read)).toEqual(EMPTY);
      await record(alice, viewProduct(2));
      expect(await facade().recentViews(alice, read)).toEqual({
        ok: true,
        value: { productIds: [product(2)], categoryIds: [] },
      });
    });

    it('never mixes customers, and takes the subject from the context, not the request', async () => {
      await record(alice, viewProduct(1));
      await record(bob, viewProduct(2));

      expect(await facade().recentViews(bob, { ...read, guestToken: 'g'.padEnd(43, '0') })).toEqual(
        { ok: true, value: { productIds: [product(2)], categoryIds: [] } },
      );
    });

    it('answers a guest only with consent, a well-formed token and no Global Privacy Control', async () => {
      const first = await uc.recordGuest.execute(anonymous, {
        event: viewProduct(1),
        token: null,
        ...consented,
      });
      const token =
        first.ok && first.value.cookie?.action === 'set' ? first.value.cookie.token : '';
      const guest = { globalPrivacyControl: false, consent: true, guestToken: token };

      expect(await facade().recentViews(anonymous, guest)).toEqual({
        ok: true,
        value: { productIds: [product(1)], categoryIds: [] },
      });
      expect(await facade().recentViews(anonymous, { ...guest, consent: false })).toEqual(EMPTY);
      expect(
        await facade().recentViews(anonymous, { ...guest, globalPrivacyControl: true }),
      ).toEqual(EMPTY);
      expect(await facade().recentViews(anonymous, { ...guest, guestToken: null })).toEqual(EMPTY);
      expect(
        await facade().recentViews(anonymous, { ...guest, guestToken: 'not a token' }),
      ).toEqual(EMPTY);
      // Reading records nothing and issues no token.
      expect(events.rows).toHaveLength(1);
    });

    it('keeps a guest apart from other guests', async () => {
      const one = await uc.recordGuest.execute(anonymous, {
        event: viewProduct(1),
        token: null,
        ...consented,
      });
      const two = await uc.recordGuest.execute(anonymous, {
        event: viewProduct(2),
        token: null,
        ...consented,
      });
      const tokenOf = (r: typeof one) =>
        r.ok && r.value.cookie?.action === 'set' ? r.value.cookie.token : '';

      expect(
        await facade().recentViews(anonymous, {
          globalPrivacyControl: false,
          consent: true,
          guestToken: tokenOf(two),
        }),
      ).toEqual({ ok: true, value: { productIds: [product(2)], categoryIds: [] } });
      expect(tokenOf(one)).not.toBe(tokenOf(two));
    });

    it('never reads another Market, for a customer or a guest', async () => {
      const elsewhere = as('customer', ALICE, other);
      const outside = testCallContext(other, 'anonymous');
      await record(elsewhere, viewProduct(7));
      const guestRow = await uc.recordGuest.execute(outside, {
        event: viewProduct(8),
        token: null,
        ...consented,
      });
      const token =
        guestRow.ok && guestRow.value.cookie?.action === 'set' ? guestRow.value.cookie.token : '';

      expect(await facade().recentViews(alice, read)).toEqual(EMPTY);
      expect(
        await facade().recentViews(anonymous, {
          globalPrivacyControl: false,
          consent: true,
          guestToken: token,
        }),
      ).toEqual(EMPTY);
    });

    it('refuses a seller and the system actor (fail closed)', async () => {
      expect(await facade().recentViews(as('seller', ALICE), read)).toMatchObject({ ok: false });
      expect(await facade().recentViews(system, read)).toMatchObject({ ok: false });
    });
  });
});
