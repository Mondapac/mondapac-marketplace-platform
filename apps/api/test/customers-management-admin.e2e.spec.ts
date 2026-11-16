import type { NestExpressApplication } from '@nestjs/platform-express';
import { money, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { ADDRESS_CIPHER } from '../src/modules/customers/application/ports/address-cipher';
import { ADDRESS_REPOSITORY } from '../src/modules/customers/application/ports/address.repository';
import {
  InMemoryAddresses,
  ReversibleAddressCipher,
} from '../src/modules/customers/application/testing/in-memory-address-book';
import { CUSTOMER_GROUP_REPOSITORY } from '../src/modules/customers/application/ports/customer-groups.repository';
import { CUSTOMER_LIST_READER } from '../src/modules/customers/application/ports/customer-list.reader';
import {
  CUSTOMER_NOTE_CIPHER,
  CUSTOMER_NOTE_REPOSITORY,
} from '../src/modules/customers/application/ports/customer-notes.repository';
import { CUSTOMER_TIMELINE_REPOSITORY } from '../src/modules/customers/application/ports/customer-timeline.repository';
import { ACCOUNT_DELETION_REQUEST_REPOSITORY } from '../src/modules/customers/application/ports/account-deletion-request.repository';
import { MemoryAccountDeletionRequests } from '../src/modules/customers/application/testing/in-memory-account-deletion';
import { InMemoryCustomerList } from '../src/modules/customers/application/testing/in-memory-customer-list';
import {
  FakeNoteCipher,
  InMemoryCustomerGroups,
  InMemoryCustomerNotes,
  InMemoryCustomerTimeline,
} from '../src/modules/customers/application/testing/in-memory-customer-management';
import type { CustomerListRow } from '../src/modules/customers/domain/customer-list';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { ORDER_REPOSITORY } from '../src/modules/ordering/application/ports/order.repository';
import { MemoryOrders } from './support/ordering-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The customers management routes over HTTP (phase 2a): the real guards, gate, controller and use
// cases; groups, notes, timeline and the list in memory; identity the real facade on the identity
// fakes. Proves CSRF, the keys (a viewer reads but cannot change), the closed bodies (the path's
// id cannot be overridden), each refusal's status, `no-store`, the export's step-up and the rename
// through identity, in both Markets.

const START = Temporal.Instant.from('2026-11-15T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const MANAGER = id<'Account'>(0xa001);
const VIEWER = id<'Account'>(0xa002);
const BUYER = id<'Account'>(0xa201);
const ROLE = id<'Role'>(0xe001);
const VIEW_ROLE = id<'Role'>(0xe002);
const KEYS = [
  'customers.customers.view',
  'customers.groups.manage',
  'customers.customer-notes.write',
  'customers.customers.edit',
  'customers.customers.export',
  'customers.customer-address.reveal',
];
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

describe.each(TEST_MARKETS)('customers management routes over HTTP in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let clock: FixedClock;
  let list: InMemoryCustomerList;
  let deletions: MemoryAccountDeletionRequests;
  let orders: MemoryOrders;
  let addresses: InMemoryAddresses;
  let addressCipher: ReversibleAddressCipher;
  const http = () => request(app!.getHttpServer());
  const market = testMarketContext(code, PLATFORM_TENANT_ID);

  const row = (accountId: Id<'Account'>): CustomerListRow => ({
    accountId,
    email: 'buyer@example.test',
    groups: [],
    displayName: 'Buyer',
    status: 'active',
    emailVerified: true,
    signedUpAt: START,
    firstOrderAt: null,
    lastOrderAt: null,
    orderCount: 0,
    spentMinor: 0n,
    currency: null,
    refundCount: 0,
    refundedMinor: 0n,
  });

  const account = (accountId: Id<'Account'>, population: 'admin' | 'customer', label: string) =>
    fakes.seedAccount({
      id: accountId,
      marketId: code as AccountState['marketId'],
      population,
      email: { typed: `${label}@Example.com`, normalized: `${label}@example.com` },
      displayName: label,
      status: 'active',
      emailVerifiedAt: START,
      existingAccountNoticeAt: null,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    });

  async function boot() {
    deletions = new MemoryAccountDeletionRequests();
    orders = new MemoryOrders();
    addresses = new InMemoryAddresses();
    addressCipher = new ReversibleAddressCipher();
    list = new InMemoryCustomerList();
    list.add(market, row(BUYER));
    ({ app } = await createTestApp({
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(CUSTOMER_LIST_READER)
          .useValue(list)
          .overrideProvider(CUSTOMER_GROUP_REPOSITORY)
          .useValue(new InMemoryCustomerGroups(list))
          .overrideProvider(CUSTOMER_NOTE_REPOSITORY)
          .useValue(new InMemoryCustomerNotes())
          .overrideProvider(CUSTOMER_NOTE_CIPHER)
          .useValue(new FakeNoteCipher())
          .overrideProvider(CUSTOMER_TIMELINE_REPOSITORY)
          .useValue(new InMemoryCustomerTimeline(list))
          .overrideProvider(ACCOUNT_DELETION_REQUEST_REPOSITORY)
          .useValue(deletions)
          .overrideProvider(ORDER_REPOSITORY)
          .useValue(orders)
          .overrideProvider(ADDRESS_REPOSITORY)
          .useValue(addresses)
          .overrideProvider(ADDRESS_CIPHER)
          .useValue(addressCipher),
    }));
    await app
      .get(SeedRoles)
      .execute(testCallContext(market, 'system', 'management-admin-seed'), {});
    const role = (roleId: Id<'Role'>, keys: string[]) =>
      fakes.seedRole({
        id: roleId,
        marketId: code as AccountState['marketId'],
        scope: 'platform',
        kind: 'custom',
        seedCode: null,
        seedVersion: null,
        sellerId: null,
        name: `Customers ${keys.length}`,
        permissionKeys: keys,
        version: 1,
        createdAt: START,
      });
    role(ROLE, KEYS);
    role(VIEW_ROLE, ['customers.customers.view']);
    account(MANAGER, 'admin', 'manager');
    account(VIEWER, 'admin', 'viewer');
    account(BUYER, 'customer', 'buyer');
    for (const [n, accountId, roleId] of [
      [1, MANAGER, ROLE],
      [2, VIEWER, VIEW_ROLE],
    ] as const) {
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(0xe900 + n),
        marketId: code as AccountState['marketId'],
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    }
  }

  function sessionOf(n: number, accountId: Id<'Account'>) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      market,
      openSession({
        id: id<'Session'>(0xf100 + n),
        marketId: code as AccountState['marketId'],
        accountId,
        population: 'admin',
        sellerId: null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      'x-market-id': code,
      ...panelHeaders(code, 'admin'),
      cookie: `__Host-session-admin-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
  });
  afterEach(async () => {
    await app?.close();
  });

  it('refuses a write without the CSRF token, and a viewer’s change', async () => {
    await boot();
    const { 'x-csrf-token': _csrf, ...noCsrf } = sessionOf(1, MANAGER);
    void _csrf;
    const refused = await http().post('/customers/admin/groups').set(noCsrf).send({ name: 'VIP' });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'request.csrf' });
    const viewer = sessionOf(2, VIEWER);
    const denied = await http().post('/customers/admin/groups').set(viewer).send({ name: 'VIP' });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'access.denied' });
    const listed = await http().get('/customers/admin/groups').set(viewer);
    expect(listed.status).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
  });

  it('makes a group, refuses its name twice, and keeps the path’s id', async () => {
    await boot();
    const manager = sessionOf(1, MANAGER);
    const made = await http().post('/customers/admin/groups').set(manager).send({ name: 'VIP' });
    expect(made.status).toBeLessThan(300);
    const groupId = (made.body as { groupId: string }).groupId;
    const twice = await http().post('/customers/admin/groups').set(manager).send({ name: 'vip' });
    expect(twice.status).toBe(409);
    expect(twice.body).toMatchObject({ code: 'customers.group-name-taken' });
    const override = await http()
      .post(`/customers/admin/groups/${groupId}/members/add`)
      .set(manager)
      .send({ groupId: id(0x99), ids: [BUYER] });
    expect(override.status).toBe(400);
    const added = await http()
      .post(`/customers/admin/groups/${groupId}/members/add`)
      .set(manager)
      .send({ ids: [BUYER] });
    expect(added.status).toBeLessThan(300);
    expect(added.body).toMatchObject({ changed: 1, requested: 1 });
    const many = Array.from({ length: 1001 }, (_, n) => id(0x10000 + n));
    const tooMany = await http()
      .post(`/customers/admin/groups/${groupId}/members/add`)
      .set(manager)
      .send({ ids: many });
    expect(tooMany.status).toBe(413);
    const missing = await http()
      .get(`/customers/admin/groups/${id(0x98)}`)
      .set(manager);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'customers.group-not-found' });
  });

  it('answers a tombstone for an erased customer and 404 for an unknown one (phase 2b)', async () => {
    await boot();
    const viewer = sessionOf(2, VIEWER);
    const gone = id<'Account'>(0xa901);
    const deletedAt = START.subtract({ hours: 48 });
    deletions.rows.set('request-gone', {
      id: id<'AccountDeletionRequest'>(0xd901),
      accountId: gone,
      status: 'completed',
      waitingPeriodDays: 14,
      requestedAt: START.subtract({ hours: 24 * 20 }),
      scheduledFor: START.subtract({ hours: 24 * 6 }),
      claimedAt: deletedAt,
      requestedBy: 'customer',
      adminOrigin: null,
      market: code,
      closedAt: deletedAt,
      cancelReason: null,
      cancelledByAdmin: null,
      redactedAt: null,
    });
    const tomb = await http().get(`/customers/admin/customers/${gone}`).set(viewer);
    expect(tomb.status).toBe(200);
    expect(tomb.headers['cache-control']).toBe('no-store');
    expect(tomb.body).toEqual({
      accountId: gone,
      status: 'deleted',
      deletedAt: deletedAt.toString(),
    });
    const unknown = await http()
      .get(`/customers/admin/customers/${id(0xa902)}`)
      .set(viewer);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: 'customers.customer-not-found' });
  });

  it('finds the customer by an order number under ordering’s own key (phase 2b)', async () => {
    await boot();
    const orderId = id<'Order'>(0xb001);
    orders.rows.set(orderId, {
      id: orderId,
      marketId: code as AccountState['marketId'],
      accountId: BUYER,
      status: 'confirmed',
      cancelReason: null,
      paymentState: 'captured',
      total: money(1000n, code === 'AU' ? 'AUD' : 'JPY'),
      reservationId: 'r-1',
      stripeIdempotencyKey: `checkout-${orderId}`,
      stripeSessionId: null,
      stripePaymentIntentId: null,
      paymentExpiresAt: START,
      createdAt: START,
      confirmedAt: START,
      cancelledAt: null,
      version: 2,
      taxStrategyId: null,
      shipToSealed: null,
      sellerOrders: [],
      lines: [],
    });
    const listed = (headers: Record<string, string>, orderNumber: string) =>
      http().post('/customers/admin/list').set(headers).send({ orderNumber });
    // The manager holds the customers keys only: ordering's key is missing, so it is refused.
    const manager = sessionOf(1, MANAGER);
    expect((await listed(manager, orderId)).status).toBe(403);
    fakes.seedRole({
      id: id<'Role'>(0xe003),
      marketId: code as AccountState['marketId'],
      scope: 'platform',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: null,
      name: 'Customers and orders',
      permissionKeys: ['customers.customers.view', 'ordering.order.view'],
      version: 1,
      createdAt: START,
    });
    const ORDERS_ADMIN = id<'Account'>(0xa003);
    account(ORDERS_ADMIN, 'admin', 'orders');
    fakes.seedAssignment({
      id: id<'RoleAssignment'>(0xe903),
      marketId: code as AccountState['marketId'],
      accountId: ORDERS_ADMIN,
      roleId: id<'Role'>(0xe003),
      assignedByAccountId: null,
      assignedAt: START,
      version: 1,
    });
    const reader = sessionOf(3, ORDERS_ADMIN);
    const found = await listed(reader, orderId);
    expect(found.status).toBe(200);
    expect(
      (found.body as { items: { accountId: string }[] }).items.map((i) => i.accountId),
    ).toEqual([BUYER]);
    const none = await listed(reader, id(0xb002));
    expect(none.status).toBe(200);
    expect((none.body as { items: unknown[] }).items).toEqual([]);
  });

  it('shows suburb and country to a viewer, and the full address only under the reveal key (phase 2b)', async () => {
    await boot();
    const addressId = id<'CustomerAddress'>(0xad01);
    const sealed = await addressCipher.seal(market, BUYER, {
      recipientFirstName: 'Aisha',
      recipientLastName: 'Rahman',
      phone: '+61412345678',
      line1: '1 Hidden Street',
      line2: null,
      suburb: 'Sunnybank',
      region: null,
      postcode: '4109',
      deliveryNotes: null,
    });
    if (!sealed.ok) throw new Error('seal failed');
    await addresses.insert(market, {
      id: addressId,
      accountId: BUYER,
      sealed: sealed.value,
      countryCode: code,
      isDefault: true,
      createdAt: START,
      updatedAt: START,
    });
    const base = `/customers/admin/customers/${BUYER}/addresses`;
    const viewer = sessionOf(31, VIEWER);
    const listed = await http().get(base).set(viewer);
    expect(listed.status).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(listed.body).toEqual({
      items: [
        {
          addressId,
          suburb: 'Sunnybank',
          countryCode: code,
          isDefault: true,
          createdAt: START.toString(),
        },
      ],
    });
    expect((await http().post(`${base}/${addressId}/reveal`).set(viewer).send({})).status).toBe(
      403,
    );
    const manager = sessionOf(32, MANAGER);
    const shown = await http().post(`${base}/${addressId}/reveal`).set(manager).send({});
    expect(shown.status).toBe(200);
    expect(shown.headers['cache-control']).toBe('no-store');
    expect(shown.body).toMatchObject({ addressId, line1: '1 Hidden Street', countryCode: code });
    const missing = await http()
      .post(`${base}/${id<'CustomerAddress'>(0xad02)}/reveal`)
      .set(manager)
      .send({});
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: 'customers.address-not-found' });
    const stray = await http()
      .post(`${base}/${addressId}/reveal`)
      .set(manager)
      .send({ accountId: BUYER });
    expect(stray.status).toBe(400);
  });

  it('writes and reads a note without caching, and reads the activity', async () => {
    await boot();
    const manager = sessionOf(1, MANAGER);
    const note = await http()
      .post(`/customers/admin/customers/${BUYER}/notes`)
      .set(manager)
      .send({ body: 'Called about a late order' });
    expect(note.status).toBeLessThan(300);
    const notes = await http().get(`/customers/admin/customers/${BUYER}/notes`).set(manager);
    expect(notes.status).toBe(200);
    expect(notes.headers['cache-control']).toBe('no-store');
    expect(notes.body).toMatchObject({ total: 1 });
    const activity = await http()
      .post(`/customers/admin/customers/${BUYER}/activity`)
      .set(manager)
      .send({ filters: { category: 'admin' } });
    expect(activity.status).toBe(200);
    expect((activity.body as { items: { kind: string }[] }).items.map((i) => i.kind)).toEqual([
      'note-added',
    ]);
    const unknown = await http()
      .post(`/customers/admin/customers/${id(0xa999)}/notes`)
      .set(manager)
      .send({ body: 'x' });
    expect(unknown.status).toBe(404);
  });

  it('asks a fresh two-step proof for the activity export', async () => {
    await boot();
    const manager = sessionOf(1, MANAGER);
    const res = await http()
      .post(`/customers/admin/customers/${BUYER}/activity/export`)
      .set(manager)
      .send({ format: 'csv' });
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toMatch(/^second-factor\./);
  });

  it('renames the customer through identity', async () => {
    await boot();
    const manager = sessionOf(1, MANAGER);
    const res = await http()
      .put(`/customers/admin/customers/${BUYER}/display-name`)
      .set(manager)
      .send({ displayName: 'Amina R.' });
    expect(res.status).toBe(200);
    expect(fakes.accounts.get(BUYER)).toMatchObject({ displayName: 'Amina R.' });
    const viewer = sessionOf(2, VIEWER);
    const denied = await http()
      .put(`/customers/admin/customers/${BUYER}/display-name`)
      .set(viewer)
      .send({ displayName: 'X' });
    expect(denied.status).toBe(403);
  });
});
