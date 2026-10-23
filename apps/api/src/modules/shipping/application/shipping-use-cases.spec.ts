import { err, money, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
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
import { FlatFeeSet } from '../domain/audit';
import { MAX_FLAT_FEE_MINOR, parseFlatFee } from '../domain/flat-fee';
import { ConfigShippingPolicy } from '../infrastructure/config-shipping-policy';
import type { FlatFeeRecord, FlatFeeRepository } from './ports/flat-fee.repository';
import type { SellerDirectory } from './ports/seller-directory';
import type { ShippingDependencies } from './shipping-dependencies';
import { DeliveryArea } from './use-cases/delivery-area.use-case';
import { FlatFees } from './use-cases/flat-fees.use-case';
import { SetFlatFee } from './use-cases/set-flat-fee.use-case';
import { ViewFlatFee } from './use-cases/view-flat-fee.use-case';
import { ViewOwnFlatFee } from './use-cases/view-own-flat-fee.use-case';

// The flat delivery fee in memory on both Market fixtures (AU in AUD, ZZ in JPY): an admin sets
// it for an existing seller with an audit row, the seller reads only its own, and ordering's
// system read answers the sellers that have one.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const areas = loadServiceAreas(TEST_SERVICE_AREA_CONFIG_DIRS, TEST_MARKET_IDS);
const T0 = Temporal.Instant.from('2026-10-14T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const SELLER_A = id<'Seller'>(0x51);
const SELLER_B = id<'Seller'>(0x52);
const GHOST = id<'Seller'>(0x5f);
const ADMIN = id<'Account'>(0xad);

/** Collects audit rows; the entry must be one the shipping catalogue defines. */
class RecordingAudit implements AuditWriter {
  readonly entries: AuditEntry[] = [];
  record(_context: CallContext, entry: AuditEntry): Promise<void> {
    if (entry.action !== FlatFeeSet.action)
      throw new Error(`audit: unknown action ${entry.action}`);
    if (entry.targetType !== FlatFeeSet.targetType) throw new Error('audit: target type');
    this.entries.push(entry);
    return Promise.resolve();
  }
}

class MemoryFees implements FlatFeeRepository {
  readonly rows = new Map<string, FlatFeeRecord & { updatedBy: Id<'Account'> }>();
  find(_m: MarketContext, sellerId: Id<'Seller'>) {
    return Promise.resolve(this.rows.get(sellerId) ?? null);
  }
  findMany(_m: MarketContext, sellerIds: readonly Id<'Seller'>[]) {
    return Promise.resolve(sellerIds.flatMap((sellerId) => this.rows.get(sellerId) ?? []));
  }
  save(_m: MarketContext, record: FlatFeeRecord & { updatedBy: Id<'Account'> }) {
    this.rows.set(record.sellerId, record);
    return Promise.resolve();
  }
}

describe('parseFlatFee', () => {
  it('takes a whole number of minor units from zero to the cap, as a number or digits', () => {
    expect(parseFlatFee(0, 'AUD')).toEqual(ok(money(0n, 'AUD')));
    expect(parseFlatFee('995', 'AUD')).toEqual(ok(money(995n, 'AUD')));
    expect(parseFlatFee(Number(MAX_FLAT_FEE_MINOR), 'JPY')).toEqual(ok(money(100_000n, 'JPY')));
  });

  it.each([
    -1,
    1.5,
    NaN,
    Infinity,
    100_001,
    '',
    '01',
    '9.95',
    '1e3',
    ' 5',
    null,
    undefined,
    {},
    [1],
  ])('refuses %p', (value) => {
    expect(parseFlatFee(value, 'AUD')).toEqual(err({ code: 'validation.failed', path: 'amount' }));
  });
});

describe.each([['AU'], ['ZZ']] as const)('shipping flat fee in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const currency = markets.get(market.marketId).defaultCurrency;
  const clock = new FixedClock(T0);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const actor = (population: 'admin' | 'seller' | 'customer', sellerId: Id<'Seller'> | null) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: population === 'admin' ? ADMIN : id<'Account'>(0xa1),
        sessionId: id<'Session'>(0x61),
        sellerId,
      }),
      `ship-${population}-abcd`,
    );
  const admin = actor('admin', null);
  const system = testCallContext(market, 'system', 'ship-system-abcd');

  let fees: MemoryFees;
  let audit: RecordingAudit;
  let known: Set<string>;
  let sellersDown: boolean;
  let deps: ShippingDependencies;

  beforeEach(() => {
    fees = new MemoryFees();
    audit = new RecordingAudit();
    known = new Set([SELLER_A, SELLER_B]);
    sellersDown = false;
    const sellers: SellerDirectory = {
      exists: (_c: CallContext, sellerId: Id<'Seller'>) =>
        Promise.resolve(sellersDown ? ('unavailable' as const) : known.has(sellerId)),
    };
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      fees,
      policy: new ConfigShippingPolicy(markets, areas),
      sellers,
      audit,
      clock,
    };
  });

  const set = (sellerId: unknown, amount: unknown, context: CallContext = admin) =>
    new SetFlatFee(gate, deps).execute(context, { sellerId, amount });

  it('sets a fee in the Market currency, stores who and when, and audits old and new', async () => {
    expect(await set(SELLER_A, 995)).toEqual(
      ok({ sellerId: SELLER_A, fee: money(995n, currency) }),
    );
    expect(fees.rows.get(SELLER_A)).toMatchObject({
      fee: money(995n, currency),
      updatedAt: T0,
      updatedBy: ADMIN,
    });

    await set(SELLER_A, '0');
    expect(fees.rows.get(SELLER_A)!.fee).toEqual(money(0n, currency));
    expect(audit.entries.map((e) => [e.action, e.targetId, e.before, e.after])).toEqual([
      ['shipping.flat-fee.set', SELLER_A, { feeMinor: null }, { feeMinor: 995 }],
      ['shipping.flat-fee.set', SELLER_A, { feeMinor: 995 }, { feeMinor: 0 }],
    ]);
  });

  it('refuses a bad id or amount with the field, an unknown seller and a failed lookup', async () => {
    expect(await set('nope', 'x')).toEqual(
      err({
        code: 'validation.failed',
        fields: [
          { path: 'sellerId', code: 'format' },
          { path: 'amount', code: 'range' },
        ],
      }),
    );
    expect(await set(SELLER_A, 100_001)).toMatchObject({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'amount', code: 'range' }] },
    });
    expect(await set(GHOST, 500)).toEqual(err({ code: 'shipping.seller-not-found' }));
    sellersDown = true;
    expect(await set(SELLER_A, 500)).toEqual(err({ code: 'shipping.unavailable' }));
    expect(fees.rows.size).toBe(0);
    expect(audit.entries).toEqual([]);
  });

  it('lets only an admin set a fee: a seller, a customer, an anonymous caller and the system cannot', async () => {
    const anonymous = testCallContext(market, 'anonymous', 'ship-anon-abcd');
    for (const context of [actor('seller', SELLER_A), actor('customer', null), anonymous, system]) {
      expect((await set(SELLER_A, 1, context)).ok).toBe(false);
    }
    expect(fees.rows.size).toBe(0);
  });

  it('shows an admin any fee, and answers fee-not-set before one exists', async () => {
    const view = new ViewFlatFee(gate, deps);
    expect(await view.execute(admin, { sellerId: SELLER_A })).toEqual(
      err({ code: 'shipping.fee-not-set', currency }),
    );
    await set(SELLER_A, 500);
    expect(await view.execute(admin, { sellerId: SELLER_A })).toEqual(
      ok({ sellerId: SELLER_A, fee: money(500n, currency) }),
    );
    expect(await view.execute(admin, { sellerId: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'validation.failed' },
    });
  });

  it('shows a seller only its own fee, never another shop’s', async () => {
    await set(SELLER_A, 500);
    await set(SELLER_B, 0);
    const view = new ViewOwnFlatFee(gate, deps);

    expect(await view.execute(actor('seller', SELLER_A), {})).toEqual(
      ok({ sellerId: SELLER_A, fee: money(500n, currency) }),
    );
    expect(await view.execute(actor('seller', SELLER_B), {})).toEqual(
      ok({ sellerId: SELLER_B, fee: money(0n, currency) }),
    );
    known.add(GHOST);
    expect(await view.execute(actor('seller', GHOST), {})).toEqual(
      err({ code: 'shipping.fee-not-set', currency }),
    );
    expect((await view.execute(actor('customer', null), {})).ok).toBe(false);
  });

  it('answers ordering the fees of the sellers that have one, an explicit zero included', async () => {
    await set(SELLER_A, 500);
    await set(SELLER_B, 0);
    const read = (sellerIds: unknown, context: CallContext = actor('customer', null)) =>
      new FlatFees(gate, deps).execute(context, { sellerIds });

    const answered = await read([SELLER_A, SELLER_B, GHOST, SELLER_A]);
    expect(answered.ok && [...answered.value]).toEqual([
      [SELLER_A, money(500n, currency)],
      [SELLER_B, money(0n, currency)],
    ]);
    const none = await read([]);
    expect(none.ok && none.value.size).toBe(0);
    expect(await read('nope')).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    expect(await read(['x'])).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    expect(
      await read(Array.from({ length: 101 }, (_, i) => id<'Seller'>(0x100 + i))),
    ).toMatchObject({
      ok: false,
      error: { code: 'validation.failed' },
    });
    // The fee is shown on a guest's cart: an anonymous caller reads it too.
    const guest = await read([SELLER_A], testCallContext(market, 'anonymous', 'ship-anon-abcd'));
    expect(guest.ok && [...guest.value]).toEqual([[SELLER_A, money(500n, currency)]]);
  });

  it('answers whether the Market delivers to a postcode, for anyone, fail closed', async () => {
    const anonymous = testCallContext(market, 'anonymous', 'ship-anon-abcd');
    const ask = (postcode: unknown) =>
      new DeliveryArea(gate, deps).execute(anonymous, { postcode });
    // AU's only area is listed but not open for delivery until the owner opens it; ZZ has two
    // open areas with seven-digit and letter postcodes.
    const inside = code === 'AU' ? '4031' : ' zz1 9aa ';
    expect(await ask(inside)).toEqual(ok({ delivers: code === 'ZZ' }));
    expect(await ask(code === 'AU' ? '2000' : '3000000')).toEqual(ok({ delivers: false }));
    for (const bad of ['', '   ', 'x'.repeat(17), 'ä', 4031, null, undefined]) {
      expect(await ask(bad)).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    }
  });
});
