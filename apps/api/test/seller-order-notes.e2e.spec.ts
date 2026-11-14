import type { NestExpressApplication } from '@nestjs/platform-express';
import { money, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { ORDER_REPOSITORY } from '../src/modules/ordering/application/ports/order.repository';
import {
  REFUND_REPOSITORY,
  type RefundRepository,
} from '../src/modules/ordering/application/ports/refund.repository';
import {
  SELLER_NOTE_CIPHER,
  SELLER_ORDER_NOTE_REPOSITORY,
} from '../src/modules/ordering/application/ports/seller-order-notes';
import type { OrderState, SellerOrder } from '../src/modules/ordering/domain/order';
import type { Refund } from '../src/modules/ordering/domain/refund';
import { AUDIT_WRITER } from '../src/platform/audit/audit-writer';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { UNIT_OF_WORK } from '../src/platform/unit-of-work/unit-of-work';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import {
  FakeAdminNoteCipher,
  MemoryOrders,
  MemorySellerNotes,
  NO_REFUNDS,
  OrderingAuditWriter,
} from './support/ordering-fakes';
import { FakeUnitOfWork } from './support/pricing-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// Seller notes on a seller order and the order activity timeline over HTTP: the real guards,
// controllers, gate and use cases; the order, refund and note stores are in memory. Proves the
// session, the panel population, CSRF, the closed body, the keys (the Seller Owner writes, a member
// with the view key only reads), ownership (another shop's seller order is a 404), that an admin
// cannot reach the seller notes, the answer shapes, `no-store` and the audit row without text.

const START = Temporal.Instant.from('2026-11-12T01:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const OWNER = id<'Account'>(0xa101);
const READER = id<'Account'>(0xa102);
const ADMIN = id<'Account'>(0xa001);
const CUSTOMER = id<'Account'>(0xc101);
const SELLER = id<'Seller'>(0xb020);
const OTHER_SELLER = id<'Seller'>(0xb021);
const ORDER = id<'Order'>(0xd001);
const MINE = id<'SellerOrder'>(0xd00a);
const THEIRS = id<'SellerOrder'>(0xd00b);
const READ_ONLY_ROLE = id<'Role'>(0xc0f3);
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

describe.each(TEST_MARKETS)('seller notes and order activity over HTTP in market %s', (code) => {
  const currency = code === 'AU' ? 'AUD' : 'JPY';
  const marketId = code as AccountState['marketId'];
  const marketOf = () => testMarketContext(code, PLATFORM_TENANT_ID);
  let app: NestExpressApplication;
  let notes: MemorySellerNotes;
  let audit: OrderingAuditWriter;
  const clock = new FixedClock(START);
  const http = () => request(app.getHttpServer());

  const sellerOrder = (
    sellerOrderId: Id<'SellerOrder'>,
    sellerId: Id<'Seller'>,
    patch: Partial<SellerOrder> = {},
  ): SellerOrder => ({
    id: sellerOrderId,
    sellerId,
    subtotal: 3000n,
    shipping: 500n,
    shippingTaxRateBps: null,
    shippingTax: null,
    shippingTaxInclusive: null,
    total: 3500n,
    fulfilment: 'shipped',
    carrier: null,
    trackingRef: null,
    shippedAt: START.add({ minutes: 30 }),
    deliveredAt: null,
    inventoryRecordedAt: null,
    ledgerState: 'pending',
    deliveryMethod: 'instant',
    deliveryWindow: null,
    readyAt: START.add({ minutes: 10 }),
    readyPrepMinutes: null,
    deliveryAttention: null,
    deliveryQuote: null,
    ...patch,
  });
  const order: OrderState = {
    id: ORDER,
    marketId,
    accountId: CUSTOMER,
    status: 'confirmed',
    cancelReason: null,
    paymentState: 'captured',
    total: money(7000n, currency),
    reservationId: 'r',
    stripeIdempotencyKey: 'k',
    stripeSessionId: null,
    stripePaymentIntentId: null,
    paymentExpiresAt: START.add({ minutes: 30 }),
    createdAt: START,
    confirmedAt: START.add({ minutes: 1 }),
    cancelledAt: null,
    version: 2,
    taxStrategyId: null,
    shipToSealed: null,
    sellerOrders: [sellerOrder(MINE, SELLER), sellerOrder(THEIRS, OTHER_SELLER, { readyAt: null })],
    lines: [],
  };
  const refund: Refund = {
    id: id<'Refund'>(0xe001),
    orderId: ORDER,
    sellerOrderId: THEIRS,
    sellerId: OTHER_SELLER,
    currency,
    gross: 1200n,
    tax: 0n,
    shipping: null,
    reason: 'damaged',
    lossBearer: 'seller',
    lossReasonCode: null,
    actor: { population: 'admin', accountId: ADMIN },
    state: 'succeeded',
    stripeIdempotencyKey: 'r1',
    stripeRefundId: null,
    attempts: 0,
    requestedAt: START.add({ minutes: 40 }),
    settledAt: START.add({ minutes: 41 }),
    lines: [],
  };

  beforeEach(async () => {
    fakes.reset();
    notes = new MemorySellerNotes();
    notes.sellerOrders.set(MINE, { orderId: ORDER, sellerId: SELLER, accountId: CUSTOMER });
    notes.sellerOrders.set(THEIRS, { orderId: ORDER, sellerId: OTHER_SELLER, accountId: CUSTOMER });
    audit = new OrderingAuditWriter();
    const orders = new MemoryOrders();
    orders.rows.set(ORDER, order);
    const refunds = Object.create(NO_REFUNDS) as RefundRepository;
    refunds.listForOrder = () => Promise.resolve([{ refund, creditNoteId: null }]);
    refunds.listOfSellerOrder = (_m, sellerOrderId, sellerId) =>
      Promise.resolve(
        [refund].filter((r) => r.sellerOrderId === sellerOrderId && r.sellerId === sellerId),
      );
    ({ app } = await createTestApp({
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(UNIT_OF_WORK)
          .useValue(new FakeUnitOfWork())
          .overrideProvider(AUDIT_WRITER)
          .useValue(audit)
          .overrideProvider(ORDER_REPOSITORY)
          .useValue(orders)
          .overrideProvider(REFUND_REPOSITORY)
          .useValue(refunds)
          .overrideProvider(SELLER_ORDER_NOTE_REPOSITORY)
          .useValue(notes)
          .overrideProvider(SELLER_NOTE_CIPHER)
          .useValue(new FakeAdminNoteCipher()),
    }));
    await app.get(SeedRoles).execute(testCallContext(marketOf(), 'system', 'note-seed-0001'), {});
    const roleOf = (scope: 'seller' | 'platform', seedCode: string) =>
      [...fakes.roles.values()].find(
        (r) => r.marketId === code && r.scope === scope && r.seedCode === seedCode,
      )!.id;
    fakes.seedRole({
      id: READ_ONLY_ROLE,
      marketId,
      scope: 'seller',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: SELLER,
      name: 'Order reader',
      permissionKeys: ['ordering.seller-order.view'],
      version: 1,
      createdAt: START,
    });
    fakes.seedSellerAccess({
      sellerId: SELLER,
      marketId,
      origin: 'self',
      state: 'approved',
      stateChangedAt: START,
      reapplyCount: 0,
      registeredAt: START,
      version: 3,
      createdAt: START,
    });
    const people = [
      [OWNER, 'seller', roleOf('seller', 'seller-owner')],
      [READER, 'seller', READ_ONLY_ROLE],
      [ADMIN, 'admin', roleOf('platform', 'viewer')],
    ] as const;
    people.forEach(([accountId, population, roleId], n) => {
      fakes.seedAccount({
        id: accountId,
        marketId,
        population,
        email: { typed: `p${n}@Example.com`, normalized: `p${n}@example.com` },
        displayName: `Person ${n}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(0xe100 + n),
        marketId,
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
      if (population === 'seller') {
        fakes.seedMembership({
          id: id<'SellerMembership'>(0xf100 + n),
          marketId,
          accountId,
          sellerId: SELLER,
          state: 'active',
          removedAt: null,
          version: 1,
          createdAt: START,
        });
      }
    });
  });
  afterEach(async () => {
    await app?.close();
  });

  let sessionCount = 0;
  function headersOf(accountId: Id<'Account'>, population: 'seller' | 'admin') {
    const issued = tokens.issue();
    sessionCount += 1;
    void fakes.sessionRepository.add(
      marketOf(),
      openSession({
        id: id<'Session'>(0xf800 + sessionCount),
        marketId,
        accountId,
        population,
        sellerId: population === 'seller' ? SELLER : null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      'x-market-id': code,
      ...panelHeaders(code, population),
      cookie: `__Host-session-${population}-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }
  const notesOf = (sellerOrderId: string) => `/ordering/seller/orders/${sellerOrderId}/notes`;

  it('lets the owner write and the team read the shop notes, sealed, audited without text', async () => {
    const written = await http()
      .post(notesOf(MINE))
      .set(headersOf(OWNER, 'seller'))
      .send({ body: '  Customer wants <b>no</b> onions  ' });
    const read = await http().get(notesOf(MINE)).set(headersOf(READER, 'seller'));

    expect(written.status).toBe(201);
    expect(written.headers['cache-control']).toBe('no-store');
    const note = written.body as { noteId: string; authorName: unknown };
    expect(Object.keys(note).sort()).toEqual([
      'authorAccountId',
      'authorName',
      'body',
      'byYou',
      'createdAt',
      'noteId',
    ]);
    expect(written.body).toMatchObject({
      noteId: notes.rows[0]!.id,
      body: 'Customer wants <b>no</b> onions',
      authorAccountId: OWNER,
      byYou: true,
      createdAt: START.toString(),
    });
    expect(notes.rows[0]!.bodySealed).not.toContain('onions');
    expect(audit.rows.map((r) => [r.action, r.targetId, r.after])).toEqual([
      ['ordering.seller-order.note-added', MINE, { noteId: note.noteId, length: 31 }],
    ]);
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect(read.body).toEqual({ notes: [{ ...written.body, byYou: false }] });
  });

  it('refuses a writer without the note key, no CSRF, an extra field, bad text and another shop', async () => {
    const readerWrites = await http()
      .post(notesOf(MINE))
      .set(headersOf(READER, 'seller'))
      .send({ body: 'x' });
    const noCsrf: Record<string, string> = headersOf(OWNER, 'seller');
    delete noCsrf['x-csrf-token'];
    const withoutCsrf = await http().post(notesOf(MINE)).set(noCsrf).send({ body: 'x' });
    const extra = await http()
      .post(notesOf(MINE))
      .set(headersOf(OWNER, 'seller'))
      .send({ body: 'x', pinned: true });
    const empty = await http()
      .post(notesOf(MINE))
      .set(headersOf(OWNER, 'seller'))
      .send({ body: '   ' });
    const theirs = await http()
      .post(notesOf(THEIRS))
      .set(headersOf(OWNER, 'seller'))
      .send({ body: 'x' });
    const theirsRead = await http().get(notesOf(THEIRS)).set(headersOf(OWNER, 'seller'));
    const badId = await http().get(notesOf('nope')).set(headersOf(OWNER, 'seller'));

    expect(readerWrites.status).toBe(403);
    expect(withoutCsrf.status).toBe(403);
    expect(extra.status).toBe(400);
    expect(empty.body).toMatchObject({
      code: 'validation.failed',
      details: { fields: [{ path: 'body', code: 'required' }] },
    });
    expect(theirs.status).toBe(404);
    expect(theirs.body).toEqual({ statusCode: 404, code: 'ordering.seller-order-not-found' });
    expect(theirsRead.status).toBe(404);
    expect(badId.status).toBe(400);
    expect(notes.rows).toHaveLength(0);
  });

  it('keeps the seller notes out of the admin panel', async () => {
    const res = await http().get(notesOf(MINE)).set(headersOf(ADMIN, 'admin'));
    expect([401, 403]).toContain(res.status);
  });

  it("answers the seller this seller order's activity only, and the admin the whole order", async () => {
    const seller = await http()
      .get(`/ordering/seller/orders/${MINE}/activity`)
      .set(headersOf(READER, 'seller'));
    const theirs = await http()
      .get(`/ordering/seller/orders/${THEIRS}/activity`)
      .set(headersOf(READER, 'seller'));
    const admin = await http()
      .get(`/ordering/admin/orders/${ORDER}/activity`)
      .set(headersOf(ADMIN, 'admin'));
    const unknown = await http()
      .get(`/ordering/admin/orders/${id<'Order'>(0xdead)}/activity`)
      .set(headersOf(ADMIN, 'admin'));

    expect(seller.status).toBe(200);
    expect(seller.headers['cache-control']).toBe('no-store');
    expect(seller.body).toEqual({
      events: [
        {
          kind: 'order-paid',
          at: START.add({ minutes: 1 }).toString(),
          sellerOrderId: MINE,
          refundId: null,
          amount: null,
          reason: null,
          by: null,
        },
        {
          kind: 'seller-order-ready',
          at: START.add({ minutes: 10 }).toString(),
          sellerOrderId: MINE,
          refundId: null,
          amount: null,
          reason: null,
          by: 'seller',
        },
        {
          kind: 'seller-order-shipped',
          at: START.add({ minutes: 30 }).toString(),
          sellerOrderId: MINE,
          refundId: null,
          amount: null,
          reason: null,
          by: null,
        },
      ],
    });
    expect(JSON.stringify(seller.body)).not.toMatch(new RegExp(`${THEIRS}|${CUSTOMER}`));
    expect(theirs.status).toBe(404);
    expect(admin.status).toBe(200);
    expect((admin.body as { events: { kind: string }[] }).events.map((e) => e.kind)).toEqual([
      'order-placed',
      'order-paid',
      'seller-order-ready',
      'seller-order-shipped',
      'seller-order-shipped',
      'refund-requested',
      'refund-succeeded',
    ]);
    expect((admin.body as { events: { amount: unknown }[] }).events[5]!.amount).toEqual({
      amount: '1200',
      currency,
    });
    expect(unknown.status).toBe(404);
  });

  it('refuses the activity routes to the wrong panel and without a session', async () => {
    const sellerOnAdmin = await http()
      .get(`/ordering/admin/orders/${ORDER}/activity`)
      .set(headersOf(OWNER, 'seller'));
    const anonymous = await http()
      .get(`/ordering/seller/orders/${MINE}/activity`)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'seller') });
    expect([401, 403]).toContain(sellerOnAdmin.status);
    expect(anonymous.status).toBe(401);
  });
});
