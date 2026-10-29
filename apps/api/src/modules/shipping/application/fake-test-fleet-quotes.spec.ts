import { encodePayload, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, PendingEvent } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import {
  FakePickups,
  ListRegistry,
  MemoryBookings,
  MemoryDeliveryQuotes,
  MemoryDeliverySettings,
  MemoryFleetLedger,
  MemorySelection,
} from '../../../../test/support/shipping-fakes';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_SERVICE_AREA_CONFIG_DIRS,
} from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { loadServiceAreas } from '../../../platform/market-config/service-area-config';
import { SHIPPING_EVENTS } from '../domain/events';
import { ConfigCarrierPolicy } from '../infrastructure/config-carrier-policy';
import { ConfigShippingPolicy } from '../infrastructure/config-shipping-policy';
import type { ShippingDependencies } from './shipping-dependencies';
import { ChargeDelivery } from './use-cases/charge-delivery.use-case';
import { QuoteDeliveries } from './use-cases/quote-deliveries.use-case';

// The delivery price a buyer is charged (delivery models, package 5) end to end in memory, on both
// Market fixtures (AU: greater-brisbane, AUD; ZZ: zz-central, JPY): the quote is the chosen
// fleet's price plus the Market margin, stored for 10 minutes and charged by its id (never by a
// price the client sends); a fleet other than the quoted one books at the platform's cost up to the
// Market cap; the fees fleets charge the platform go to their own ledger.

import { FakeTestCarrier } from '../infrastructure/fake-test-carrier';
import { capabilitiesOf } from '../infrastructure/fleet-config';
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const areas = loadServiceAreas(TEST_SERVICE_AREA_CONFIG_DIRS, TEST_MARKET_IDS);
const NO_KEYS = { isKnownPermissionKey: () => false };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const BUYER = id<'Account'>(0xb1);
const SELLER = id<'Seller'>(0x51);

// The checkout delivery price against the real `fake_test` fleet of the ZZ fixture (zz-central, in
// JPY): shipping's own use cases with the Market's policy and fleet configuration, in-memory
// stores. The fleet's price derives from the drop-off postcode, so the expected totals are known.

const SERVED = '1000001';
const fakePrice = (postcode: string): bigint => {
  let spread = 0;
  for (const char of postcode) spread += char.charCodeAt(0);
  return BigInt(1000 + (spread % 500));
};

describe('checkout delivery quotes from the fake_test fleet in market ZZ', () => {
  const market = testMarketContext('ZZ', 'default');
  const zone = markets.get(market.marketId).timezone;
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const buyer = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'customer',
      accountId: BUYER,
      sessionId: id<'Session'>(0x61),
      sellerId: null,
    }),
    'zz-quote-0001',
  );
  let clock: FixedClock;
  let fleet: FakeTestCarrier;
  let quotes: MemoryDeliveryQuotes;
  let settings: MemoryDeliverySettings;
  let deps: ShippingDependencies;

  beforeEach(async () => {
    clock = new FixedClock(
      Temporal.PlainDateTime.from('2026-10-24T10:00:00').toZonedDateTime(zone).toInstant(),
    );
    const carrierPolicy = new ConfigCarrierPolicy(markets, areas, {
      apiKeys: {},
      webhookSecrets: {},
    });
    fleet = new FakeTestCarrier((m) => {
      const entry = carrierPolicy.fleetEntry(m.marketId, 'fake_test');
      return entry === undefined
        ? null
        : capabilitiesOf('fake_test', entry, markets.get(m.marketId).defaultCurrency, {
            idempotentBooking: true,
            supportsWindow: true,
          });
    });
    quotes = new MemoryDeliveryQuotes();
    settings = new MemoryDeliverySettings();
    const pickups = new FakePickups();
    pickups.postcodes = ok(new Map([[SELLER, '1000002']]));
    pickups.zones = ok(new Map([[SELLER, zone]]));
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      policy: new ConfigShippingPolicy(markets, areas),
      sellers: undefined as never,
      audit: undefined as never,
      clock,
      ids: new SequenceIdGenerator(clock),
      outbox: {
        append: (_c: CallContext, events: readonly PendingEvent[]) => {
          for (const event of events) {
            const definition = SHIPPING_EVENTS.find((d) => d.type === event.type);
            if (definition === undefined) throw new Error(`outbox: unknown type ${event.type}`);
            const checked = encodePayload(definition.fields, event.payload, NO_KEYS);
            if (!checked.ok) throw new Error(`outbox: ${JSON.stringify(checked.error)}`);
          }
          return Promise.resolve();
        },
      },
      bookings: new MemoryBookings(),
      fleets: new ListRegistry([fleet]),
      selection: new MemorySelection(),
      deliverySettings: settings,
      carrierPolicy,
      quotes,
      ledger: new MemoryFleetLedger(),
      pickups,
      webhookSignature: undefined as never,
      uberWebhookSignature: undefined as never,
      securityEvents: undefined as never,
    };
    await settings.saveSettings(
      market,
      {
        enabled: { pickup: true, instant: true, same_day: true, scheduled: true },
        sameDayCutoffMinutes: 720,
        scheduledDaysAhead: 7,
        scheduledWindowMinutes: 120,
        margin: { kind: 'fixed', amountMinor: 100 },
        roundingStepMinor: 1,
      } as never,
      0,
    );
  });

  const dropoff = (postcode = SERVED) => ({ postcode, locality: 'Example Town', region: 'QQ' });
  const seller = { sellerId: SELLER, itemCount: 2, declaredValueMinor: 4000 };

  it('quotes each delivering method with the fleet price plus the margin, in yen', async () => {
    const result = await new QuoteDeliveries(gate, deps).execute(buyer, {
      sellers: [seller],
      dropoff: dropoff(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const entry = result.value.get(SELLER)!;
    const price = fakePrice(SERVED);
    for (const method of ['instant', 'same_day', 'scheduled'] as const) {
      expect(entry.quotes[method]).toMatchObject({
        kind: 'quoted',
        quote: {
          fleet: 'fake_test',
          quote: { amount: price, currency: 'JPY' },
          margin: { amount: 100n, currency: 'JPY' },
          total: { amount: price + 100n, currency: 'JPY' },
        },
      });
    }
    expect(entry.pickupPostcode).toBe('1000002');
    expect(fleet.quoted.length).toBeGreaterThan(0);
  });

  it('charges the stored quote by its id, and a different drop-off is not the quoted one', async () => {
    const asked = await new QuoteDeliveries(gate, deps).execute(buyer, {
      sellers: [seller],
      dropoff: dropoff(),
    });
    if (!asked.ok) throw new Error('quote failed');
    const instant = asked.value.get(SELLER)!.quotes.instant;
    if (instant?.kind !== 'quoted') throw new Error('no instant quote');

    const charged = await new ChargeDelivery(gate, deps).execute(buyer, {
      seller,
      method: 'instant',
      quoteId: instant.quote.quoteId,
      dropoff: dropoff(),
    });
    expect(charged).toMatchObject({
      ok: true,
      value: { fleet: 'fake_test', total: instant.quote.total, quoteId: instant.quote.quoteId },
    });

    const elsewhere = await new ChargeDelivery(gate, deps).execute(buyer, {
      seller,
      method: 'instant',
      quoteId: instant.quote.quoteId,
      dropoff: dropoff('1000002'),
    });
    expect(elsewhere.ok).toBe(false);
  });

  it('says no fleet for a drop-off outside the fleet area', async () => {
    const result = await new QuoteDeliveries(gate, deps).execute(buyer, {
      sellers: [seller],
      dropoff: dropoff('3000000'),
    });
    expect(result.ok && result.value.get(SELLER)!.quotes.instant).toMatchObject({
      kind: 'no-fleet',
    });
  });
});
