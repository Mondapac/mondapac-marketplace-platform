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
import { ConfigAddressPolicy } from '../infrastructure/config-address-policy';
import type { CustomersDependencies } from './customers-dependencies';
import { InMemoryAddresses, ReversibleAddressCipher } from './testing/in-memory-address-book';
import { CreateAddress } from './use-cases/create-address.use-case';
import { DeleteAddress } from './use-cases/delete-address.use-case';
import { ListAddresses } from './use-cases/list-addresses.use-case';
import { SetDefaultAddress } from './use-cases/set-default-address.use-case';
import { UpdateAddress } from './use-cases/update-address.use-case';

// The address book in memory on both Market fixtures (AU: states, 4-digit postcodes, limit 20;
// ZZ: regions ZA/ZB, 7-digit postcodes, limit 5): a customer adds, changes, removes and picks a
// default among their own addresses only; the book always has one default when not empty; the
// Market limit holds; any other actor is refused.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-17T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ALICE = id<'Account'>(0xa1);
const BOB = id<'Account'>(0xb2);

describe.each([['AU'], ['ZZ']] as const)('customer address book in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const settings = markets.get(market.marketId).customers!;
  const address = (line1: string, extra: Record<string, unknown> = {}) => ({
    recipientFirstName: 'Aisha',
    recipientLastName: 'Rahman',
    phone: '+61 412 345 678',
    line1,
    suburb: 'Sunnybank',
    region: settings.address.regions[0],
    postcode: code === 'AU' ? '4109' : '1000001',
    ...extra,
  });
  const as = (population: 'customer' | 'seller' | 'admin', accountId: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId,
        sessionId: id<'Session'>(0x61),
        sellerId: population === 'seller' ? id<'Seller'>(0x51) : null,
      }),
      `cus-${population}-abcd`,
    );
  const alice = as('customer', ALICE);
  const bob = as('customer', BOB);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });

  let clock: FixedClock;
  let store: InMemoryAddresses;
  let cipher: ReversibleAddressCipher;
  let units: FakeUnitOfWork;
  let deps: CustomersDependencies;
  let uc: {
    list: ListAddresses;
    create: CreateAddress;
    update: UpdateAddress;
    remove: DeleteAddress;
    setDefault: SetDefaultAddress;
  };

  beforeEach(() => {
    clock = new FixedClock(T0);
    store = new InMemoryAddresses();
    cipher = new ReversibleAddressCipher();
    units = new FakeUnitOfWork();
    deps = {
      unitOfWork: units,
      addresses: store,
      cipher,
      policy: new ConfigAddressPolicy(markets),
      ids: new SequenceIdGenerator(clock),
      clock,
    };
    uc = {
      list: new ListAddresses(gate, deps),
      create: new CreateAddress(gate, deps),
      update: new UpdateAddress(gate, deps),
      remove: new DeleteAddress(gate, deps),
      setDefault: new SetDefaultAddress(gate, deps),
    };
  });

  const add = async (context = alice, line1 = 'One Street', extra = {}) => {
    clock.advance(Temporal.Duration.from({ minutes: 1 }));
    const created = await uc.create.execute(context, address(line1, extra));
    if (!created.ok) throw new Error(`create: ${created.error.code}`);
    return created.value;
  };
  const book = async (context = alice) => {
    const listed = await uc.list.execute(context, {});
    if (!listed.ok) throw new Error(listed.error.code);
    return listed.value;
  };

  it('adds the first address as the default, with the Market country, sealed at rest', async () => {
    const first = await add();
    expect(first).toMatchObject({
      line1: 'One Street',
      phone: '+61412345678',
      countryCode: settings.address.countryCode,
      isDefault: true,
    });
    const stored = store.rows.get(first.id)!;
    expect(stored.sealed).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(stored.sealed).not.toContain('One Street');
    expect(units.units.at(-1)?.options).toEqual({ isolation: 'serializable' });

    const second = await add(alice, 'Two Street');
    expect(second.isDefault).toBe(false);
    const listed = await book();
    expect(listed.limit).toBe(settings.addressBookLimit);
    expect(listed.addresses.map((a) => [a.line1, a.isDefault])).toEqual([
      ['One Street', true],
      ['Two Street', false],
    ]);
  });

  it('moves the default when a new or changed address asks for it, and never clears it', async () => {
    const first = await add();
    const second = await add(alice, 'Two Street', { isDefault: true });
    expect(second.isDefault).toBe(true);
    expect((await book()).addresses.filter((a) => a.isDefault).map((a) => a.id)).toEqual([
      second.id,
    ]);

    const changed = await uc.update.execute(alice, {
      addressId: first.id,
      body: address('One Street, Unit 4', { isDefault: true }),
    });
    expect(changed).toMatchObject({
      ok: true,
      value: { isDefault: true, line1: 'One Street, Unit 4' },
    });

    const kept = await uc.update.execute(alice, {
      addressId: first.id,
      body: address('One Street', { isDefault: false }),
    });
    expect(kept).toMatchObject({ ok: true, value: { isDefault: true } });
    expect((await book()).addresses.filter((a) => a.isDefault)).toHaveLength(1);

    const picked = await uc.setDefault.execute(alice, { addressId: second.id });
    expect(picked.ok && picked.value.addresses[0]!.id).toBe(second.id);
    expect(picked.ok && picked.value.addresses.filter((a) => a.isDefault)).toHaveLength(1);
  });

  it('makes the newest remaining address the default when the default is removed', async () => {
    const first = await add();
    await add(alice, 'Two Street');
    const third = await add(alice, 'Three Street');

    expect(await uc.remove.execute(alice, { addressId: first.id })).toEqual({
      ok: true,
      value: { deleted: true },
    });
    const listed = await book();
    expect(listed.addresses.map((a) => [a.id, a.isDefault])[0]).toEqual([third.id, true]);
    expect(listed.addresses).toHaveLength(2);
  });

  it("keeps each customer's book to themselves", async () => {
    const mine = await add();
    const theirs = await add(bob, 'Bob Street');
    expect((await book(bob)).addresses.map((a) => a.id)).toEqual([theirs.id]);
    // Bob's first address is his own default, beside Alice's.
    expect(theirs.isDefault).toBe(true);

    const notFound = { ok: false, error: { code: 'customers.address-not-found' } };
    expect(await uc.update.execute(bob, { addressId: mine.id, body: address('Hijack') })).toEqual(
      notFound,
    );
    expect(await uc.remove.execute(bob, { addressId: mine.id })).toEqual(notFound);
    expect(await uc.setDefault.execute(bob, { addressId: mine.id })).toEqual(notFound);
    expect((await book()).addresses.map((a) => a.line1)).toEqual(['One Street']);
  });

  it('refuses an address beyond the Market limit', async () => {
    for (let n = 0; n < settings.addressBookLimit; n += 1) await add(alice, `Street ${n}`);
    const over = await uc.create.execute(alice, address('One too many'));
    expect(over).toEqual({
      ok: false,
      error: { code: 'customers.address-limit-reached', limit: settings.addressBookLimit },
    });
  });

  it('refuses a bad body or id with field codes only', async () => {
    const bad = await uc.create.execute(alice, { ...address(''), isDefault: 'yes' });
    expect(bad).toEqual({
      ok: false,
      error: {
        code: 'validation.failed',
        fields: [
          { path: 'isDefault', code: 'type' },
          { path: 'line1', code: 'required' },
        ],
      },
    });
    expect(await uc.remove.execute(alice, { addressId: 'not-a-uuid' })).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'addressId', code: 'format' }] },
    });
    expect(store.rows.size).toBe(0);
  });

  it.each([['seller'], ['admin']] as const)('refuses a %s account', async (population) => {
    const other = as(population, id<'Account'>(0xc3));
    expect(await uc.list.execute(other, {})).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(await uc.create.execute(other, address('Panel Street'))).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
  });

  it('leaves out an address whose account key was destroyed', async () => {
    await add();
    cipher.destroyed.add(ALICE);
    expect((await book()).addresses).toEqual([]);
    expect(await uc.create.execute(alice, address('After erasure'))).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
  });

  it('is unavailable in a Market without address book settings', async () => {
    const closed = new ListAddresses(gate, { ...deps, policy: { settings: () => null } });
    expect(await closed.execute(alice, {})).toEqual({
      ok: false,
      error: { code: 'customers.unavailable' },
    });
  });
});
