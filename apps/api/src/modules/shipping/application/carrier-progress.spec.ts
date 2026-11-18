import { err, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { realEffectiveKeys } from '../../../../test/support/permission-registry';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { MemoryBookings } from '../../../../test/support/shipping-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { MAX_CARRIER_PROGRESS_IDS, SHIPPING_CARRIER_DELIVERY_VIEW } from '../contracts';
import type { CarrierBooking, CarrierProgress } from '../domain/carrier-booking';
import { carrierProgressView, shownCarrierStatus } from '../domain/carrier-progress';
import type { FleetCode } from '../domain/fleet';
import {
  ShippingFacadeImplementation,
  type ShippingFacadeUseCases,
} from '../presentation/shipping.facade';
import type { ShippingDependencies } from './shipping-dependencies';
import { CarrierProgressOf } from './use-cases/carrier-progress-of.use-case';

// The carrier progress of seller orders for the admin Shipments list, through the facade, on
// both Market fixtures: the platform key under the admin's own context (sellers and customers
// never hold it), the deduplicated id cap, one read scoped to the caller's Market, exactly five
// fields per answer (never the carrier reference or the tracking link), and a carrier status
// that is not of the shown shape answered as null. The SQL and its plan are in
// test/db/shipping-carrier-progress.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-16T09:00:00Z');
const KEY = SHIPPING_CARRIER_DELIVERY_VIEW.key;
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};

describe('the carrier-delivery key and the access declaration', () => {
  it('is a plain platform key, and the only rule of carrierProgressOf', () => {
    expect(SHIPPING_CARRIER_DELIVERY_VIEW).toMatchObject({
      key: 'shipping.carrier-delivery.view',
      scope: 'platform',
      protected: false,
    });
    expect(CarrierProgressOf.access.rule).toEqual({ kind: 'permissions', allOf: [KEY] });
    expect(MAX_CARRIER_PROGRESS_IDS).toBe(100);
  });

  it('shows only a carrier status of the tight shape', () => {
    for (const shown of ['SCHEDULED', 'picked_up', 'en-route.2', 'A'.repeat(60)]) {
      expect(shownCarrierStatus(shown)).toBe(shown);
    }
    for (const hidden of [
      '=1+1',
      '<b>X</b>',
      '"x"',
      'a b',
      '+SUM(A1)',
      '-A1',
      '_x',
      '.5',
      '',
      'A'.repeat(61),
    ]) {
      expect(shownCarrierStatus(hidden)).toBeNull();
    }
  });
});

describe.each(['AU', 'ZZ'] as const)('carrier progress of seller orders in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const keysOf = realEffectiveKeys();

  /** Each actor's role, as identity would read it; the keys go through the real registry. */
  const grants = new Map<
    string,
    { scope: 'platform' | 'seller'; kind: 'system' | 'custom'; keys: string[] }
  >();
  // A real-shaped check: a customer holds no key, a seller holds only seller-scope keys, an
  // admin holds the keys of its role that the registry declares in the platform scope.
  const check: AuthorisationCheck = {
    check: (context, declaration) => {
      const actor = context.actor;
      if (actor.kind !== 'authenticated' || declaration.rule.kind !== 'permissions') {
        return Promise.resolve({ allowed: false, denial: { code: 'access.denied' } });
      }
      const grant = grants.get(actor.accountId);
      const held = keysOf({
        population: actor.population,
        accountId: actor.accountId,
        sellerId: actor.sellerId,
        grant:
          grant === undefined
            ? null
            : {
                roleId: id<'Role'>(0x77),
                kind: grant.kind,
                scope: grant.scope,
                sellerId: grant.scope === 'seller' ? actor.sellerId : null,
                storedKeys: grant.keys,
              },
      });
      const { allOf } = declaration.rule;
      return Promise.resolve(
        allOf.length > 0 && allOf.every((key) => held.has(key))
          ? { allowed: true }
          : { allowed: false, denial: { code: 'access.denied' } },
      );
    },
  };

  const actor = (
    population: 'admin' | 'seller' | 'customer',
    n: number,
    grant?: { scope: 'platform' | 'seller'; kind: 'system' | 'custom'; keys: string[] },
  ): CallContext => {
    const accountId = id<'Account'>(0xa000 + n);
    if (grant !== undefined) grants.set(accountId, grant);
    return testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId,
        sessionId: id<'Session'>(0x6000 + n),
        sellerId: population === 'seller' ? id<'Seller'>(0x51) : null,
      }),
    );
  };

  const admin = actor('admin', 1, { scope: 'platform', kind: 'custom', keys: [KEY] });
  const adminWithoutKey = actor('admin', 2, {
    scope: 'platform',
    kind: 'custom',
    keys: ['ordering.order.view'],
  });
  // A seller's system role holds every seller key; none is a platform key.
  const seller = actor('seller', 3, { scope: 'seller', kind: 'system', keys: [] });
  const customer = actor('customer', 4);
  const system = testCallContext(market, 'system', 'carrier-progress-0001');

  let bookings: MemoryBookings;
  let unitOfWork: FakeUnitOfWork;
  let facade: ShippingFacadeImplementation;

  beforeEach(() => {
    bookings = new MemoryBookings();
    unitOfWork = new FakeUnitOfWork();
    const deps = { unitOfWork, bookings } as unknown as ShippingDependencies;
    const progress = new CarrierProgressOf(createUseCaseGate(markets, check), deps);
    facade = new ShippingFacadeImplementation({ progress } as unknown as ShippingFacadeUseCases);
  });

  const book = (
    m: MarketContext,
    sellerOrderId: Id<'SellerOrder'>,
    fields: {
      fleet?: FleetCode;
      progress?: CarrierProgress;
      carrierStatus?: string;
      pod?: boolean;
      updatedAt?: Temporal.Instant;
    } = {},
  ) => {
    const booking: CarrierBooking = {
      id: id<'CarrierBooking'>(0xb000 + bookings.rows.size),
      sellerOrderId,
      orderId: id<'Order'>(0x0a),
      sellerId: id<'Seller'>(0x51),
      fleet: fields.fleet ?? 'mondapac_drive',
      carrierReference: `REF-SECRET-${sellerOrderId}`,
      progress: fields.progress ?? 'booked',
      carrierStatus: fields.carrierStatus ?? 'SCHEDULED',
      version: 1,
      trackingUrl: 'https://track.example/secret-dropoff',
      podRecordedAt: fields.pod === true ? T0.add({ minutes: 30 }) : null,
      polledAt: T0.add({ minutes: 45 }),
      createdAt: T0,
      updatedAt: fields.updatedAt ?? T0.add({ minutes: 10 }),
    };
    bookings.rows.set(`${m.marketId}|${sellerOrderId}`, booking);
  };

  const SO1 = id<'SellerOrder'>(0x501);
  const SO2 = id<'SellerOrder'>(0x502);
  const SO3 = id<'SellerOrder'>(0x503);
  const OTHER_ONLY = id<'SellerOrder'>(0x504);
  const NONE = id<'SellerOrder'>(0x505);

  it('answers an admin holding the key, in one read-only read, with exactly five fields', async () => {
    book(market, SO1, {
      fleet: 'uber_direct',
      progress: 'delivered',
      carrierStatus: 'DELIVERED',
      pod: true,
      updatedAt: T0.add({ minutes: 50 }),
    });
    book(market, SO2, { progress: 'picked-up', carrierStatus: 'en_route' });

    const answer = await facade.carrierProgressOf(admin, [SO1, SO2, NONE]);

    if (!answer.ok) throw new Error(answer.error.code);
    expect([...answer.value.keys()].sort()).toEqual([SO1, SO2]);
    expect(answer.value.get(SO1)).toEqual({
      fleet: 'uber_direct',
      progress: 'delivered',
      carrierStatus: 'DELIVERED',
      updatedAt: T0.add({ minutes: 50 }),
      proofOfDelivery: true,
    });
    expect(answer.value.get(SO2)).toMatchObject({ progress: 'picked-up', proofOfDelivery: false });
    // Exactly these keys: never the carrier reference, the tracking link or the pod instant.
    for (const value of answer.value.values()) {
      expect(Object.keys(value).sort()).toEqual([
        'carrierStatus',
        'fleet',
        'progress',
        'proofOfDelivery',
        'updatedAt',
      ]);
    }
    expect(JSON.stringify([...answer.value.values()])).not.toMatch(/SECRET|secret|track\./);
    expect(bookings.progressReads).toHaveLength(1);
    expect(unitOfWork.units).toEqual([{ market: code, options: { readOnly: true } }]);
  });

  it('refuses an admin without the key, a seller, a customer and the system actor', async () => {
    book(market, SO1);
    for (const context of [adminWithoutKey, seller, customer, system]) {
      expect(await facade.carrierProgressOf(context, [SO1])).toEqual(
        err({ code: 'access.denied' }),
      );
    }
    expect(bookings.progressReads).toEqual([]);
  });

  it('removes duplicates before the cap of 100 and refuses more distinct ids', async () => {
    const hundred = Array.from({ length: 100 }, (_, n) => id<'SellerOrder'>(0x1000 + n));
    book(market, hundred[0]!);

    const repeated = await facade.carrierProgressOf(admin, [...hundred, ...hundred.slice(0, 50)]);
    expect(repeated.ok && repeated.value.size).toBe(1);
    expect(bookings.progressReads[0]).toHaveLength(100);

    const tooMany = await facade.carrierProgressOf(admin, [...hundred, id<'SellerOrder'>(0x2000)]);
    expect(tooMany).toEqual(err({ code: 'validation.failed' }));
    expect(bookings.progressReads).toHaveLength(1);
  });

  it('refuses a value that is not an id, and answers nothing for no ids without a read', async () => {
    for (const bad of [['not-an-id'], [42], null, 'x']) {
      expect(
        await facade.carrierProgressOf(admin, bad as unknown as readonly Id<'SellerOrder'>[]),
      ).toEqual(err({ code: 'validation.failed' }));
    }
    const none = await facade.carrierProgressOf(admin, []);
    expect(none.ok && none.value.size).toBe(0);
    expect(bookings.progressReads).toEqual([]);
  });

  it("never answers another Market's booking", async () => {
    book(market, SO1, { carrierStatus: 'MINE' });
    book(other, SO1, { carrierStatus: 'THEIRS' });
    book(other, OTHER_ONLY);

    const answer = await facade.carrierProgressOf(admin, [SO1, OTHER_ONLY]);

    if (!answer.ok) throw new Error(answer.error.code);
    expect([...answer.value.keys()]).toEqual([SO1]);
    expect(answer.value.get(SO1)?.carrierStatus).toBe('MINE');
  });

  it('answers null for a stored carrier status shaped like a formula or markup', async () => {
    book(market, SO1, { carrierStatus: '=1+1' });
    book(market, SO2, { carrierStatus: '<b>X</b>' });
    book(market, SO3, { carrierStatus: 'OUT_FOR_DELIVERY' });

    const answer = await facade.carrierProgressOf(admin, [SO1, SO2, SO3]);

    if (!answer.ok) throw new Error(answer.error.code);
    expect(answer.value.get(SO1)).toMatchObject({ carrierStatus: null, progress: 'booked' });
    expect(answer.value.get(SO2)).toMatchObject({ carrierStatus: null });
    expect(answer.value.get(SO3)).toMatchObject({ carrierStatus: 'OUT_FOR_DELIVERY' });
  });

  it('answers shipping.unavailable when the read unit fails', async () => {
    unitOfWork.run = <T, E>(): Promise<Result<T, E>> =>
      Promise.resolve(err({ code: 'unit.failed' }) as unknown as Result<T, E>);
    expect(await facade.carrierProgressOf(admin, [SO1])).toEqual(
      err({ code: 'shipping.unavailable' }),
    );
  });

  it('derives proof of delivery from the instant only', () => {
    const record = {
      sellerOrderId: SO1,
      fleet: 'auspost' as const,
      progress: 'delivered' as const,
      carrierStatus: 'DELIVERED',
      updatedAt: T0,
    };
    expect(carrierProgressView({ ...record, podRecordedAt: T0 }).proofOfDelivery).toBe(true);
    expect(carrierProgressView({ ...record, podRecordedAt: null }).proofOfDelivery).toBe(false);
  });
});
