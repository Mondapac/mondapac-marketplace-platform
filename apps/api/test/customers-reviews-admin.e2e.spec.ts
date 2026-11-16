import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { CUSTOMER_LIST_READER } from '../src/modules/customers/application/ports/customer-list.reader';
import { CUSTOMER_TIMELINE_REPOSITORY } from '../src/modules/customers/application/ports/customer-timeline.repository';
import { InMemoryCustomerList } from '../src/modules/customers/application/testing/in-memory-customer-list';
import { InMemoryCustomerTimeline } from '../src/modules/customers/application/testing/in-memory-customer-management';
import type { CustomerListRow } from '../src/modules/customers/domain/customer-list';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { CUSTOMER_REVIEWS_READER } from '../src/modules/reviews/application/ports/customer-reviews.reader';
import { MemoryCustomerReviews } from '../src/modules/reviews/application/testing/in-memory-customer-reviews';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The customer page's reviews sections over HTTP (customers management phase 2b, part 3): the real
// guards, gate, controller, customers' use cases and reviews' facade and use cases, with reviews'
// reader in memory. Proves both keys (customers.customers.view alone, or the reviews key alone,
// reaches nothing), CSRF on a POST, the closed bodies and filters, `no-store`, no review text and
// no reporter, and the export's step-up and audit row, in both Markets.

const START = Temporal.Instant.from('2026-11-16T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const MODERATOR = id<'Account'>(0xa001);
const VIEWER = id<'Account'>(0xa002);
const REVIEWER = id<'Account'>(0xa003);
const BUYER = id<'Account'>(0xa201);
const REPORTER = id<'Account'>(0xa202);
const ROLE = id<'Role'>(0xe001);
const VIEW_ROLE = id<'Role'>(0xe002);
const REVIEWS_ROLE = id<'Role'>(0xe003);
const KEYS = [
  'customers.customers.view',
  'customers.customers.export',
  'reviews.customer-review.view',
];
const EXPORT_STEP_UP = 'customers.customers.export';
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

describe.each(TEST_MARKETS)('customer page reviews sections over HTTP in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let clock: FixedClock;
  let reader: MemoryCustomerReviews;
  const http = () => request(app!.getHttpServer());
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const marketId = code as AccountState['marketId'];
  const at = (hours: number) => START.subtract({ hours });

  function seedReviews() {
    reader = new MemoryCustomerReviews();
    for (const [n, status] of [
      [1, 'published'],
      [2, 'hidden'],
    ] as const) {
      reader.reviews.push({
        market: market.marketId,
        accountId: BUYER,
        row: {
          id: id<'ProductReview'>(0xb100 + n),
          productId: id<'Product'>(0xb200 + n),
          offerId: id<'Offer'>(0xb300 + n),
          sellerId: id<'Seller'>(0xb400),
          rating: 3,
          anonymous: true,
          status,
          createdAt: at(n),
          editedAt: null,
          publishedAt: status === 'published' ? at(n) : null,
          helpfulCount: 1,
          openReports: status === 'hidden' ? 1 : 0,
          lastModeration:
            status === 'hidden'
              ? { action: 'hide', reasonCode: 'abusive', byModerator: true, at: at(0) }
              : null,
        },
      });
    }
    reader.ratings.push({
      market: market.marketId,
      accountId: BUYER,
      row: {
        id: id<'SellerRating'>(0xb501),
        sellerId: id<'Seller'>(0xb400),
        sellerOrderId: id<'SellerOrder'>(0xb601),
        satisfaction: 4,
        asDescribed: true,
        arrivedOk: true,
        reasonCode: null,
        status: 'published',
        createdAt: at(3),
      },
    });
    reader.votes.push({
      market: market.marketId,
      accountId: BUYER,
      row: {
        reviewId: id<'ProductReview'>(0xb199),
        productId: id<'Product'>(0xb299),
        votedAt: at(4),
      },
    });
    reader.reports.push({
      market: market.marketId,
      accountId: BUYER,
      row: {
        id: id<'ReviewReport'>(0xb701),
        reviewId: id<'ProductReview'>(0xb102),
        role: 'about',
        reasonCode: 'off-topic',
        status: 'open',
        createdAt: at(1),
      },
    });
  }

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
      marketId,
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
    seedReviews();
    const list = new InMemoryCustomerList();
    list.add(market, row(BUYER));
    const timeline = new InMemoryCustomerTimeline(list);
    ({ app } = await createTestApp({
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(CUSTOMER_LIST_READER)
          .useValue(list)
          .overrideProvider(CUSTOMER_TIMELINE_REPOSITORY)
          .useValue(timeline)
          .overrideProvider(CUSTOMER_REVIEWS_READER)
          .useValue(reader),
    }));
    await app.get(SeedRoles).execute(testCallContext(market, 'system', 'reviews-seed'), {});
    const role = (roleId: Id<'Role'>, keys: string[]) =>
      fakes.seedRole({
        id: roleId,
        marketId,
        scope: 'platform',
        kind: 'custom',
        seedCode: null,
        seedVersion: null,
        sellerId: null,
        name: `Reviews ${roleId}`,
        permissionKeys: keys,
        version: 1,
        createdAt: START,
      });
    role(ROLE, KEYS);
    role(VIEW_ROLE, ['customers.customers.view']);
    role(REVIEWS_ROLE, ['reviews.customer-review.view']);
    account(MODERATOR, 'admin', 'moderator');
    account(VIEWER, 'admin', 'viewer');
    account(REVIEWER, 'admin', 'reviewer');
    account(BUYER, 'customer', 'buyer');
    account(REPORTER, 'customer', 'reporter');
    for (const [n, accountId, roleId] of [
      [1, MODERATOR, ROLE],
      [2, VIEWER, VIEW_ROLE],
      [3, REVIEWER, REVIEWS_ROLE],
    ] as const) {
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(0xe900 + n),
        marketId,
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    }
    fakes.audits.length = 0;
  }

  function sessionOf(n: number, accountId: Id<'Account'>) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      market,
      openSession({
        id: id<'Session'>(0xf100 + n),
        marketId,
        accountId,
        population: 'admin',
        sellerId: null,
        transport: 'cookie',
        device: null,
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

  const base = `/customers/admin/customers/${BUYER}`;

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
  });
  afterEach(async () => {
    await app?.close();
  });

  it('pages each reviews super list behind both keys and the CSRF token', async () => {
    await boot();
    const admin = sessionOf(1, MODERATOR);
    const viewer = sessionOf(2, VIEWER);
    const reviewer = sessionOf(3, REVIEWER);
    for (const [path, total] of [
      ['reviews', 2],
      ['seller-ratings', 1],
      ['helpful-votes', 1],
      ['review-reports', 1],
    ] as const) {
      const page = await http().post(`${base}/${path}`).set(admin).send({ paging: 'pages' });
      expect([path, page.status]).toEqual([path, 200]);
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.body).toMatchObject({ total, page: 1, hasNext: false });
      expect((await http().post(`${base}/${path}`).set(viewer).send({})).status).toBe(403);
      expect((await http().post(`${base}/${path}`).set(reviewer).send({})).status).toBe(403);
      const stray = await http().post(`${base}/${path}`).set(admin).send({ accountId: REPORTER });
      expect(stray.status).toBe(400);
    }
    const hidden = await http()
      .post(`${base}/reviews`)
      .set(admin)
      .send({ filters: { status: ['hidden'] }, paging: 'prev-next' });
    expect(hidden.status).toBe(200);
    expect(hidden.body).toMatchObject({
      total: null,
      items: [
        {
          reviewId: id(0xb102),
          status: 'hidden',
          openReports: 1,
          lastModeration: { action: 'hide', reasonCode: 'abusive', byModerator: true },
        },
      ],
    });
    expect(JSON.stringify(hidden.body)).not.toMatch(/title|body|"text"/);
    const reports = await http().post(`${base}/review-reports`).set(admin).send({});
    expect(JSON.stringify(reports.body)).not.toContain(REPORTER);
    const badStatus = await http()
      .post(`${base}/reviews`)
      .set(admin)
      .send({ filters: { status: ['visible'] } });
    expect(badStatus.status).toBe(400);
    const { 'x-csrf-token': _csrf, ...noCsrf } = admin;
    void _csrf;
    expect((await http().post(`${base}/reviews`).set(noCsrf).send({})).status).toBe(403);
    const unknown = await http()
      .post(`/customers/admin/customers/${id(0xa999)}/reviews`)
      .set(admin)
      .send({});
    expect(unknown.status).toBe(404);
  });

  it('asks a fresh two-step proof for an export, and audits the section', async () => {
    await boot();
    const admin = sessionOf(1, MODERATOR);
    const refused = await http().post(`${base}/reviews/export`).set(admin).send({ format: 'csv' });
    expect(refused.status).toBe(403);
    expect((refused.body as { code: string }).code).toMatch(/^second-factor\./);

    fakes.factors.set(MODERATOR, {
      id: id<'SecondFactor'>(0xf301),
      marketId,
      accountId: MODERATOR,
      state: 'active',
      secretCiphertext: 'sealed',
      pendingSecretCiphertext: null,
      lastAcceptedStep: null,
      activatedAt: START,
      lockedAt: null,
      createdAt: START,
      recoveryCodes: Array.from({ length: 10 }, (_, index) => ({
        position: index + 1,
        codeHash: new Uint8Array(32).fill(index + 1),
        usedAt: null,
      })),
      version: 1,
    });
    fakes.stepUpProofs.set(`${code}|${id<'Session'>(0xf101)}|${EXPORT_STEP_UP}`, clock.now());
    const file = await http().post(`${base}/reviews/export`).set(admin).send({ format: 'csv' });
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('text/csv');
    expect(file.headers['cache-control']).toBe('no-store');
    expect(file.text).toContain(id(0xb102));
    expect(
      fakes.audits.filter((audit) => audit.action === 'customers.customer-section.exported'),
    ).toMatchObject([{ targetId: BUYER, after: { section: 'reviews', rowCount: 2 } }]);
  });
});
