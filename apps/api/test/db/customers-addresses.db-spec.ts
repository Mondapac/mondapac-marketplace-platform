import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { AddressRecord } from '../../src/modules/customers/application/ports/address.repository';
import {
  MemoryAccountDeletionSettings,
  RecordingAudit,
  RecordingOutbox,
  RecordingStepUp,
} from '../../src/modules/customers/application/testing/in-memory-account-deletion';
import { ReversibleAddressCipher } from '../../src/modules/customers/application/testing/in-memory-address-book';
import { CreateAddress } from '../../src/modules/customers/application/use-cases/create-address.use-case';
import { ListAddresses } from '../../src/modules/customers/application/use-cases/list-addresses.use-case';
import { SetDefaultAddress } from '../../src/modules/customers/application/use-cases/set-default-address.use-case';
import { ConfigAddressPolicy } from '../../src/modules/customers/infrastructure/config-address-policy';
import { PrismaAddressRepository } from '../../src/modules/customers/infrastructure/prisma-address.repository';
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
import { testDatabaseUrl } from './test-database';

// The address book store as the application role, in both Market fixtures: add, change, remove,
// one default per customer (the partial unique index), the CHECKs, and never a read across
// Markets or customers. The real use cases on the real unit of work keep one default under
// concurrent writes (serializable, retried).

const T0 = Temporal.Instant.from('2026-10-17T10:00:00Z');
const CHECK = '23514';
// Prisma reports a violated unique index as P2002.
const UNIQUE = 'P2002';
const SEALED = `v1.${'A'.repeat(48)}`;
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

describe.each(TEST_MARKETS)('customer address store in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const clock = new FixedClock(T0);
  const ids = new UuidV7IdGenerator(clock);
  let db: Persistence;
  let addresses: PrismaAddressRepository;
  let sql: Client;

  beforeAll(async () => {
    db = createPersistence();
    addresses = new PrismaAddressRepository(db.service);
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });

  const value = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };
  const code_ = (promise: Promise<unknown>) =>
    promise.then(
      () => 'allowed',
      (error: { code?: string }) => error.code,
    );
  const record = (accountId: Id<'Account'>, isDefault: boolean, minutes = 0): AddressRecord => ({
    id: ids.next<'CustomerAddress'>(),
    accountId,
    sealed: SEALED,
    countryCode: markets.get(market.marketId).customers!.address.countryCode,
    isDefault,
    createdAt: T0.add({ minutes }),
    updatedAt: T0.add({ minutes }),
  });

  it('adds, changes and removes an address, and never reads across Markets or customers', async () => {
    const alice = ids.next<'Account'>();
    const bob = ids.next<'Account'>();
    const first = record(alice, true);
    const second = record(alice, false, 1);
    await value(market, () => addresses.insert(market, first));
    await value(market, () => addresses.insert(market, second));

    expect((await value(market, () => addresses.list(market, alice))).map((r) => r.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(await value(market, () => addresses.find(market, alice, first.id))).toMatchObject({
      id: first.id,
      isDefault: true,
      sealed: SEALED,
    });
    expect(await value(market, () => addresses.find(market, bob, first.id))).toBeNull();
    expect(await value(other, () => addresses.find(other, alice, first.id))).toBeNull();
    expect(await value(other, () => addresses.list(other, alice))).toEqual([]);

    const resealed = `v1.${'B'.repeat(48)}`;
    expect(
      await value(market, () =>
        addresses.update(market, {
          id: first.id,
          accountId: bob,
          sealed: resealed,
          updatedAt: T0.add({ hours: 1 }),
        }),
      ),
    ).toBe(false);
    expect(
      await value(market, () =>
        addresses.update(market, {
          id: first.id,
          accountId: alice,
          sealed: resealed,
          updatedAt: T0.add({ hours: 1 }),
        }),
      ),
    ).toBe(true);
    expect((await value(market, () => addresses.find(market, alice, first.id)))?.sealed).toBe(
      resealed,
    );

    expect(await value(market, () => addresses.remove(market, bob, first.id))).toBe(false);
    expect(await value(other, () => addresses.remove(other, alice, first.id))).toBe(false);
    expect(await value(market, () => addresses.remove(market, alice, first.id))).toBe(true);
    expect(await value(market, () => addresses.remove(market, alice, second.id))).toBe(true);
  });

  it('keeps at most one default address per customer', async () => {
    const alice = ids.next<'Account'>();
    const bob = ids.next<'Account'>();
    const a = record(alice, true);
    const b = record(alice, false, 1);
    await value(market, () => addresses.insert(market, a));
    await value(market, () => addresses.insert(market, b));
    // Bob has his own default beside Alice's.
    await value(market, () => addresses.insert(market, record(bob, true)));

    expect(await code_(value(market, () => addresses.insert(market, record(alice, true))))).toBe(
      UNIQUE,
    );
    expect(await code_(value(market, () => addresses.markDefault(market, alice, b.id, T0)))).toBe(
      UNIQUE,
    );
    await value(market, async () => {
      await addresses.clearDefault(market, alice, T0);
      return addresses.markDefault(market, alice, b.id, T0);
    });
    const listed = await value(market, () => addresses.list(market, alice));
    expect(listed.filter((r) => r.isDefault).map((r) => r.id)).toEqual([b.id]);
  });

  it('refuses a damaged row, a bad country and scope at the database', async () => {
    const insertRow = (sealed: string, country: string, marketId: string = market.marketId) =>
      code_(
        sql.query(
          `INSERT INTO customers.addresses (id, market_id, tenant_id, account_id, content_ciphertext, country_code, is_default, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, false, now(), now())`,
          [ids.next(), marketId, market.tenantId, ids.next(), sealed, country],
        ),
      );
    expect(await insertRow('plain text address', 'AU')).toBe(CHECK);
    expect(await insertRow('v1.short', 'AU')).toBe(CHECK);
    expect(await insertRow(SEALED, 'au')).toBe(CHECK);
    expect(await insertRow(SEALED, 'AU', 'bad mkt')).toBe(CHECK);
    expect(await insertRow(SEALED, 'AU')).toBe('allowed');
  });

  it('keeps one default when a customer adds and picks addresses at the same time', async () => {
    const accountId = ids.next<'Account'>();
    const context = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId,
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
      'cus-db-race-abcd',
    );
    const deps = {
      unitOfWork: db.unitOfWork,
      addresses,
      cipher: new ReversibleAddressCipher(),
      policy: new ConfigAddressPolicy(markets),
      ids,
      clock,
      accountDeletionSettings: new MemoryAccountDeletionSettings(),
      audit: new RecordingAudit(),
      outbox: new RecordingOutbox(),
      stepUp: new RecordingStepUp(),
    };
    const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
    const create = new CreateAddress(gate, deps);
    const settings = markets.get(market.marketId).customers!.address;
    const body = (line1: string, isDefault: boolean) => ({
      recipientFirstName: 'Aisha',
      recipientLastName: 'Rahman',
      phone: '0412345678',
      line1,
      suburb: 'Sunnybank',
      region: settings.regions[0],
      postcode: code === 'AU' ? '4109' : '1000001',
      isDefault,
    });

    const created = await Promise.all(
      [0, 1, 2, 3].map((n) => create.execute(context, body(`Street ${n}`, n % 2 === 1))),
    );
    expect(created.every((result) => result.ok)).toBe(true);
    const ids_ = created.map((result) => (result.ok ? result.value.id : null));
    await Promise.all(
      ids_.map((addressId) => new SetDefaultAddress(gate, deps).execute(context, { addressId })),
    );

    const book = await new ListAddresses(gate, deps).execute(context, {});
    expect(book.ok && book.value.addresses).toHaveLength(4);
    expect(book.ok && book.value.addresses.filter((a) => a.isDefault)).toHaveLength(1);
  });
});
