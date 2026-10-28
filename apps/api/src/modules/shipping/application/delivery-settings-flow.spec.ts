import { money, parseId, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { FakePickups, MemoryDeliverySettings } from '../../../../test/support/shipping-fakes';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_SERVICE_AREA_CONFIG_DIRS,
} from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { loadServiceAreas } from '../../../platform/market-config/service-area-config';
import {
  SHIPPING_DELIVERY_SETTINGS_MANAGE,
  SHIPPING_DELIVERY_SETTINGS_VIEW,
} from '../contracts/permissions';
import { SHIPPING_AUDIT_ACTIONS } from '../domain/audit';
import { ConfigShippingPolicy } from '../infrastructure/config-shipping-policy';
import type { SellerDirectory } from './ports/seller-directory';
import type { ShippingDependencies } from './shipping-dependencies';
import { DeliveryAvailability } from './use-cases/delivery-availability.use-case';
import { DeliveryChoice } from './use-cases/delivery-choice.use-case';
import { PriceDelivery } from './use-cases/price-delivery.use-case';
import { SetDeliverySettings } from './use-cases/set-delivery-settings.use-case';
import { SetSellerDeliveryMethods } from './use-cases/set-seller-delivery-methods.use-case';
import { ViewDeliverySettings } from './use-cases/view-delivery-settings.use-case';
import { ViewSellerDeliveryMethods } from './use-cases/view-seller-delivery-methods.use-case';

// The delivery settings in memory on both Market fixtures (AU: Brisbane, AUD; ZZ: Tokyo, JPY):
// defaults, saving with a version, the audit of every change, the methods a seller supports, what
// a seller offers now with a reason for each refusal (zone of the seller, Market zone as the
// fallback) and the buyer's price. The permissions are the access declarations of the use cases.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const areas = loadServiceAreas(TEST_SERVICE_AREA_CONFIG_DIRS, TEST_MARKET_IDS);
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xad);
const SELLER_A = id<'Seller'>(0x51);
const SELLER_B = id<'Seller'>(0x52);
const SELLER_C = id<'Seller'>(0x53);

class RecordingAudit implements AuditWriter {
  readonly entries: AuditEntry[] = [];
  record(_context: CallContext, entry: AuditEntry): Promise<void> {
    if (!SHIPPING_AUDIT_ACTIONS.some((definition) => definition.action === entry.action)) {
      throw new Error(`audit: unknown action ${entry.action}`);
    }
    this.entries.push(entry);
    return Promise.resolve();
  }
}

describe('the access declarations', () => {
  it('need the view key to read and the protected manage key to change', () => {
    for (const useCase of [ViewDeliverySettings, ViewSellerDeliveryMethods]) {
      expect(useCase.access.rule).toEqual({
        kind: 'permissions',
        allOf: [SHIPPING_DELIVERY_SETTINGS_VIEW.key],
      });
    }
    for (const useCase of [SetDeliverySettings, SetSellerDeliveryMethods]) {
      expect(useCase.access.rule).toEqual({
        kind: 'permissions',
        allOf: [SHIPPING_DELIVERY_SETTINGS_MANAGE.key],
      });
    }
    expect(SHIPPING_DELIVERY_SETTINGS_MANAGE.protected).toBe(true);
    expect(SHIPPING_DELIVERY_SETTINGS_VIEW.protected).toBe(false);
    expect(SHIPPING_DELIVERY_SETTINGS_MANAGE.key).toBe('shipping.delivery-settings.manage');
    expect(SHIPPING_DELIVERY_SETTINGS_VIEW.key).toBe('shipping.delivery-settings.view');
  });

  it('read what a seller offers for everyone, and price a delivery under the buyer', () => {
    expect(DeliveryAvailability.access.rule).toEqual({ kind: 'anonymous' });
    expect(DeliveryChoice.access.rule).toEqual({ kind: 'anonymous' });
    expect(PriceDelivery.access.rule).toEqual({ kind: 'own-resources' });
  });
});

const SETTINGS = {
  enabled: { pickup: true, instant: true, same_day: true, scheduled: true },
  sameDayCutoff: '12:00',
  scheduledDaysAhead: 7,
  scheduledWindowMinutes: 120,
  margin: { kind: 'none' },
  roundingStepMinor: 1,
  expectedVersion: 0,
};

describe.each([['AU'], ['ZZ']] as const)('delivery settings in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const marketZone = code === 'AU' ? 'Australia/Brisbane' : 'Asia/Tokyo';
  const currency = markets.get(market.marketId).defaultCurrency;
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const actor = (population: 'admin' | 'seller' | 'customer') =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: population === 'admin' ? ADMIN : id<'Account'>(0xa1),
        sessionId: id<'Session'>(0x61),
        sellerId: population === 'seller' ? SELLER_A : null,
      }),
      `delivery-${population}-abcd`,
    );
  const admin = actor('admin');
  const customer = actor('customer');
  const noon = (iso: string, zone: string) =>
    Temporal.PlainDateTime.from(iso).toZonedDateTime(zone).toInstant();

  let store: MemoryDeliverySettings;
  let audit: RecordingAudit;
  let clock: FixedClock;
  let pickups: FakePickups;
  let known: Set<string>;
  let deps: ShippingDependencies;

  beforeEach(() => {
    store = new MemoryDeliverySettings();
    audit = new RecordingAudit();
    // 10:00 local on 10 June 2026 in the Market zone.
    clock = new FixedClock(noon('2026-06-10T10:00:00', marketZone));
    pickups = new FakePickups();
    known = new Set([SELLER_A, SELLER_B, SELLER_C]);
    const sellers: SellerDirectory = {
      exists: (_c, sellerId) => Promise.resolve(known.has(sellerId)),
    };
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      fees: undefined as never,
      policy: new ConfigShippingPolicy(markets, areas),
      sellers,
      stores: undefined as never,
      audit,
      clock,
      ids: undefined as never,
      outbox: undefined as never,
      bookings: undefined as never,
      fleets: undefined as never,
      selection: undefined as never,
      deliverySettings: store,
      carrierPolicy: undefined as never,
      pickups,
      webhookSignature: undefined as never,
      uberWebhookSignature: undefined as never,
      securityEvents: undefined as never,
    };
  });

  const view = (context: CallContext = admin) =>
    new ViewDeliverySettings(gate, deps).execute(context, {});
  const save = (input: unknown, context: CallContext = admin) =>
    new SetDeliverySettings(gate, deps).execute(context, input);
  const viewSeller = (sellerId: unknown, context: CallContext = admin) =>
    new ViewSellerDeliveryMethods(gate, deps).execute(context, { sellerId });
  const setSeller = (sellerId: unknown, supported: unknown, context: CallContext = admin) =>
    new SetSellerDeliveryMethods(gate, deps).execute(context, { sellerId, supported });
  const offers = (sellerIds: unknown, context: CallContext = customer) =>
    new DeliveryAvailability(gate, deps).execute(context, { sellerIds });
  const choice = (input: Record<string, unknown>, context: CallContext = customer) =>
    new DeliveryChoice(gate, deps).execute(context, input as never);
  const reasonsOf = async (sellerId: Id<'Seller'>) => {
    const result = await offers([sellerId]);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return Object.fromEntries(
      result.value.get(sellerId)!.methods.map((entry) => [entry.method, entry.reason ?? 'ok']),
    );
  };

  describe('the Market settings', () => {
    it('reads the defaults before the first save, with the Market currency and zone', async () => {
      const result = await view();
      expect(result.ok && result.value).toMatchObject({
        currency,
        marketZone,
        settings: {
          enabled: { pickup: true, instant: true, same_day: true, scheduled: true },
          sameDayCutoffMinutes: 720,
          scheduledDaysAhead: 7,
          scheduledWindowMinutes: 120,
          margin: { kind: 'none' },
          roundingStepMinor: 1,
          version: 0,
        },
      });
    });

    it('saves the whole set, raises the version and audits the before and the after', async () => {
      const saved = await save({
        ...SETTINGS,
        enabled: { pickup: true, instant: false, same_day: true, scheduled: true },
        sameDayCutoff: '10:30',
        scheduledDaysAhead: 3,
        scheduledWindowMinutes: 90,
        margin: { kind: 'percent', basisPoints: 1000 },
        roundingStepMinor: 5,
      });
      expect(saved.ok && saved.value.settings).toMatchObject({
        sameDayCutoffMinutes: 630,
        scheduledDaysAhead: 3,
        scheduledWindowMinutes: 90,
        margin: { kind: 'percent', basisPoints: 1000 },
        roundingStepMinor: 5,
        version: 1,
      });
      expect((await view()).ok).toBe(true);
      expect(audit.entries).toHaveLength(1);
      expect(audit.entries[0]).toMatchObject({
        action: 'shipping.delivery-settings.changed',
        targetId: 'market',
        before: {
          enabled: ['pickup', 'instant', 'same-day', 'scheduled'],
          sameDayCutoffMinutes: 720,
          marginKind: 'none',
          marginValue: 0,
          version: 0,
        },
        after: {
          enabled: ['pickup', 'same-day', 'scheduled'],
          sameDayCutoffMinutes: 630,
          scheduledDaysAhead: 3,
          scheduledWindowMinutes: 90,
          marginKind: 'percent',
          marginValue: 1000,
          roundingStepMinor: 5,
          version: 1,
        },
      });
      const second = await save({
        ...SETTINGS,
        expectedVersion: 1,
        margin: { kind: 'fixed', amountMinor: 150 },
      });
      expect(second.ok && second.value.settings.version).toBe(2);
      expect(audit.entries[1]).toMatchObject({
        before: { marginKind: 'percent', marginValue: 1000, version: 1 },
        after: { marginKind: 'fixed', marginValue: 150, version: 2 },
      });
    });

    it('refuses a stale version and writes nothing', async () => {
      await save(SETTINGS);
      const stale = await save({ ...SETTINGS, scheduledDaysAhead: 2 });
      expect(stale).toEqual({ ok: false, error: { code: 'shipping.delivery-settings-conflict' } });
      expect(audit.entries).toHaveLength(1);
      expect((await view()).ok && (await view())).toMatchObject({
        value: { settings: { scheduledDaysAhead: 7, version: 1 } },
      });
    });

    it('refuses invalid input naming each path, and writes nothing', async () => {
      const bad = await save({
        ...SETTINGS,
        sameDayCutoff: '25:00',
        scheduledDaysAhead: 99,
        margin: { kind: 'percent', basisPoints: 50000 },
        roundingStepMinor: 7,
        expectedVersion: -1,
      });
      expect(bad.ok).toBe(false);
      expect(
        !bad.ok &&
          bad.error.code === 'validation.failed' &&
          bad.error.fields.map((f) => f.path).sort(),
      ).toEqual([
        'expectedVersion',
        'margin.basisPoints',
        'roundingStepMinor',
        'sameDayCutoff',
        'scheduledDaysAhead',
      ]);
      expect(audit.entries).toEqual([]);
      expect(store.rows.size).toBe(0);
    });

    it('answers access.denied to a customer or a seller, whatever the gate says', async () => {
      for (const context of [customer, actor('seller')]) {
        expect(await view(context)).toEqual({ ok: false, error: { code: 'access.denied' } });
        expect(await save(SETTINGS, context)).toEqual({
          ok: false,
          error: { code: 'access.denied' },
        });
        expect(await viewSeller(SELLER_A, context)).toEqual({
          ok: false,
          error: { code: 'access.denied' },
        });
        expect(await setSeller(SELLER_A, [], context)).toEqual({
          ok: false,
          error: { code: 'access.denied' },
        });
      }
      expect(audit.entries).toEqual([]);
    });

    it('keeps one Market out of the other', async () => {
      await save({ ...SETTINGS, scheduledDaysAhead: 4 });
      const otherCode = code === 'AU' ? 'ZZ' : 'AU';
      const otherMarket = testMarketContext(otherCode, 'default');
      expect((await store.settings(otherMarket)).version).toBe(0);
      expect((await store.settings(market)).scheduledDaysAhead).toBe(4);
    });
  });

  describe('the methods of a seller', () => {
    it('supports every method until an admin takes one away', async () => {
      const read = await viewSeller(SELLER_A);
      expect(read.ok && read.value.supported).toEqual([
        'pickup',
        'instant',
        'same_day',
        'scheduled',
      ]);
    });

    it('takes methods away, audits the change and reads it back', async () => {
      const set = await setSeller(SELLER_A, ['pickup', 'scheduled']);
      expect(set.ok && set.value.supported).toEqual(['pickup', 'scheduled']);
      expect(audit.entries[0]).toMatchObject({
        action: 'shipping.seller-delivery-methods.set',
        targetId: SELLER_A,
        before: { unsupported: [] },
        after: { unsupported: ['instant', 'same-day'] },
      });
      const read = await viewSeller(SELLER_A);
      expect(read.ok && read.value.supported).toEqual(['pickup', 'scheduled']);
      // The other seller is untouched.
      const other = await viewSeller(SELLER_B);
      expect(other.ok && other.value.supported).toHaveLength(4);
      // Giving everything back audits the way back.
      await setSeller(SELLER_A, ['pickup', 'instant', 'same_day', 'scheduled']);
      expect(audit.entries[1]).toMatchObject({
        before: { unsupported: ['instant', 'same-day'] },
        after: { unsupported: [] },
      });
    });

    it('shows what the Market has on beside what the seller supports', async () => {
      await save({ ...SETTINGS, enabled: { ...SETTINGS.enabled, instant: false } });
      const read = await viewSeller(SELLER_A);
      expect(read.ok && read.value.platformEnabled).toEqual({
        pickup: true,
        instant: false,
        same_day: true,
        scheduled: true,
      });
    });

    it('refuses an unknown seller, a bad id and a bad method list', async () => {
      expect(await setSeller(id<'Seller'>(0x99), ['pickup'])).toEqual({
        ok: false,
        error: { code: 'shipping.seller-not-found' },
      });
      expect(await viewSeller(id<'Seller'>(0x99))).toEqual({
        ok: false,
        error: { code: 'shipping.seller-not-found' },
      });
      const badId = await setSeller('nope', ['pickup']);
      expect(!badId.ok && badId.error.code).toBe('validation.failed');
      const badList = await setSeller(SELLER_A, ['pickup', 'drone']);
      expect(!badList.ok && badList.error).toEqual({
        code: 'validation.failed',
        fields: [{ path: 'supported', code: 'value' }],
      });
      expect(audit.entries).toEqual([]);
    });
  });

  describe('what a seller offers now', () => {
    beforeEach(() => {
      pickups.postcodes = { ok: true, value: new Map([[SELLER_A, '4000']]) };
    });

    it('offers every method with a pickup address, before the cut-off', async () => {
      expect(await reasonsOf(SELLER_A)).toEqual({
        pickup: 'ok',
        instant: 'ok',
        same_day: 'ok',
        scheduled: 'ok',
      });
    });

    it('names the reason of each refusal: platform, seller, pickup address, cut-off', async () => {
      await save({ ...SETTINGS, enabled: { ...SETTINGS.enabled, scheduled: false } });
      await setSeller(SELLER_B, ['pickup', 'scheduled', 'same_day']);
      clock.set(noon('2026-06-10T13:00:00', marketZone));
      expect(await reasonsOf(SELLER_B)).toEqual({
        pickup: 'no-pickup-address',
        instant: 'seller-unsupported',
        same_day: 'past-cut-off',
        scheduled: 'platform-off',
      });
      expect(await reasonsOf(SELLER_A)).toEqual({
        pickup: 'ok',
        instant: 'ok',
        same_day: 'past-cut-off',
        scheduled: 'platform-off',
      });
    });

    it('reads the cut-off in the seller zone, the Market zone as the fallback', async () => {
      // 10:00 in the Market zone. A seller 6 hours east would be at 16:00 (past noon); one far
      // behind is still in the morning. Perth: 08:00 for Brisbane, 09:00 for Tokyo.
      pickups.zones = {
        ok: true,
        value: new Map([
          [SELLER_A, 'Pacific/Auckland'],
          [SELLER_B, 'Australia/Perth'],
          [SELLER_C, 'Not/AZone'],
        ]),
      };
      clock.set(noon('2026-06-10T11:30:00', marketZone));
      // Auckland (+12 in June): 11:30 Brisbane is 13:30 there; 11:30 Tokyo is 14:30.
      expect((await reasonsOf(SELLER_A)).same_day).toBe('past-cut-off');
      expect((await reasonsOf(SELLER_B)).same_day).toBe('ok');
      // An unusable zone falls back to the Market zone (11:30: before noon).
      expect((await reasonsOf(SELLER_C)).same_day).toBe('ok');
      const read = await offers([SELLER_A, SELLER_B, SELLER_C]);
      expect(read.ok && [...read.value.values()].map((entry) => entry.zone)).toEqual([
        'Pacific/Auckland',
        'Australia/Perth',
        marketZone,
      ]);
    });

    it('carries the numbers a basket shows', async () => {
      await save({
        ...SETTINGS,
        sameDayCutoff: '15:45',
        scheduledDaysAhead: 5,
        scheduledWindowMinutes: 60,
      });
      const read = await offers([SELLER_A]);
      expect(read.ok && read.value.get(SELLER_A)).toMatchObject({
        sellerId: SELLER_A,
        sameDayCutoff: '15:45',
        scheduledDaysAhead: 5,
        scheduledWindowMinutes: 60,
      });
    });

    it('answers for several sellers at once and for none', async () => {
      const read = await offers([SELLER_A, SELLER_B, SELLER_A]);
      expect(read.ok && [...read.value.keys()]).toEqual([SELLER_A, SELLER_B]);
      const none = await offers([]);
      expect(none.ok && none.value.size).toBe(0);
      const bad = await offers(['nope']);
      expect(!bad.ok && bad.error.code).toBe('validation.failed');
    });

    it('fails closed when a read fails, never "everything is open"', async () => {
      pickups.postcodes = { ok: false, error: { code: 'pickup.unavailable' } };
      expect(await offers([SELLER_A])).toEqual({
        ok: false,
        error: { code: 'shipping.unavailable' },
      });
      expect(await choice({ sellerId: SELLER_A, method: 'instant', window: null })).toEqual({
        ok: false,
        error: { code: 'shipping.unavailable' },
      });
    });
  });

  describe('a buyer choice', () => {
    beforeEach(() => {
      pickups.postcodes = { ok: true, value: new Map([[SELLER_A, '4000']]) };
    });
    const window = (iso: string, minutes = 120) => {
      const start = noon(iso, marketZone);
      return { start: start.toString(), end: start.add({ minutes }).toString() };
    };

    it('allows an open method and gives the reason for a closed one', async () => {
      expect(await choice({ sellerId: SELLER_A, method: 'instant', window: null })).toEqual({
        ok: true,
        value: { allowed: true, reason: null },
      });
      await setSeller(SELLER_A, ['pickup', 'scheduled', 'same_day']);
      expect(await choice({ sellerId: SELLER_A, method: 'instant', window: null })).toEqual({
        ok: true,
        value: { allowed: false, reason: 'seller-unsupported' },
      });
      expect(await choice({ sellerId: SELLER_B, method: 'pickup', window: null })).toEqual({
        ok: true,
        value: { allowed: false, reason: 'no-pickup-address' },
      });
    });

    it('checks a scheduled window against the days ahead and the length', async () => {
      const ok = window('2026-06-12T14:00:00');
      expect(await choice({ sellerId: SELLER_A, method: 'scheduled', window: ok })).toEqual({
        ok: true,
        value: { allowed: true, reason: null },
      });
      for (const [bad, reason] of [
        [window('2026-06-12T14:00:00', 60), 'window-length'],
        [window('2026-06-30T14:00:00'), 'window-too-far'],
        [window('2026-06-09T14:00:00'), 'window-in-past'],
        [null, 'window-missing'],
      ] as const) {
        expect(await choice({ sellerId: SELLER_A, method: 'scheduled', window: bad })).toEqual({
          ok: true,
          value: { allowed: false, reason },
        });
      }
      await save({ ...SETTINGS, scheduledDaysAhead: 30, scheduledWindowMinutes: 60 });
      expect(
        await choice({
          sellerId: SELLER_A,
          method: 'scheduled',
          window: window('2026-06-30T14:00:00', 60),
        }),
      ).toEqual({ ok: true, value: { allowed: true, reason: null } });
    });

    it('refuses malformed input', async () => {
      for (const input of [
        { sellerId: 'x', method: 'instant', window: null },
        { sellerId: SELLER_A, method: 'drone', window: null },
        { sellerId: SELLER_A, method: 'scheduled', window: { start: 'x', end: 'y' } },
        { sellerId: SELLER_A, method: 'scheduled', window: 'soon' },
      ]) {
        const result = await choice(input);
        expect(!result.ok && result.error.code).toBe('validation.failed');
      }
    });
  });

  describe('the buyer price', () => {
    const price = (quote: unknown) => new PriceDelivery(gate, deps).execute(customer, { quote });

    it('charges the quote as it is before any margin is set', async () => {
      const result = await price({ amount: 1234n, currency });
      expect(result).toEqual({
        ok: true,
        value: {
          quote: money(1234n, currency),
          margin: money(0n, currency),
          total: money(1234n, currency),
        },
      });
    });

    it('adds the margin and rounds up to the step', async () => {
      await save({
        ...SETTINGS,
        margin: { kind: 'percent', basisPoints: 1000 },
        roundingStepMinor: 5,
      });
      const result = await price({ amount: 1234n, currency });
      expect(result.ok && result.value.total).toEqual(money(1360n, currency));
      expect(result.ok && result.value.margin).toEqual(money(126n, currency));
    });

    it('refuses a quote in another currency or a negative one', async () => {
      const other = currency === 'AUD' ? 'JPY' : 'AUD';
      for (const quote of [
        { amount: 100n, currency: other },
        { amount: -1n, currency },
        'x',
        null,
      ]) {
        const result = await price(quote);
        expect(!result.ok && result.error.code).toBe('validation.failed');
      }
    });
  });
});
