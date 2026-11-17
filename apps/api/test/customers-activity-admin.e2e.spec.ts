import type { NestExpressApplication } from '@nestjs/platform-express';
import { money, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { CART_REPOSITORY } from '../src/modules/cart/application/ports/cart.repository';
import { SAVED_ITEM_REPOSITORY } from '../src/modules/cart/application/ports/saved-item.repository';
import { InMemorySavedItems } from '../src/modules/cart/application/testing/in-memory-saved-items';
import type { CartState } from '../src/modules/cart/domain/cart';
import { CART_REMINDER_REPOSITORY } from '../src/modules/notifications/application/ports/cart-reminder.repository';
import { BEHAVIOUR_EVENT_REPOSITORY } from '../src/modules/engagement/application/ports/behaviour-event.repository';
import { PERSONALIZATION_SETTING_REPOSITORY } from '../src/modules/engagement/application/ports/personalization-setting.repository';
import {
  InMemoryBehaviourEvents,
  InMemoryPersonalizationSettings,
} from '../src/modules/engagement/application/testing/in-memory-engagement';
import { MARKETING_CONSENT_REPOSITORY } from '../src/modules/legal/application/ports/marketing-consent.repository';
import { InMemoryMarketingConsents } from '../src/modules/legal/application/testing/in-memory-marketing-consents';
import { CONVERSATION_REPOSITORY } from '../src/modules/assistant/application/ports/conversation.repository';
import { MemoryConversations } from '../src/modules/assistant/application/testing/assistant-fakes';
import { CUSTOMER_LIST_READER } from '../src/modules/customers/application/ports/customer-list.reader';
import { CUSTOMER_TIMELINE_REPOSITORY } from '../src/modules/customers/application/ports/customer-timeline.repository';
import { InMemoryCustomerList } from '../src/modules/customers/application/testing/in-memory-customer-list';
import { InMemoryCustomerTimeline } from '../src/modules/customers/application/testing/in-memory-customer-management';
import type { CustomerListRow } from '../src/modules/customers/domain/customer-list';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The customer page's shopping and privacy sections over HTTP (customers management phase 2b,
// part 2): the real guards, gate, controllers, customers' use cases and the owners' facades and
// use cases (cart, notifications, engagement, legal, assistant), with the owners' stores in
// memory. Proves each owner's key (customers.customers.view alone reaches no section), CSRF on a
// POST, the closed bodies, `no-store`, money as a string, no search text and no message, and the
// export's step-up and audit row, in both Markets.

const START = Temporal.Instant.from('2026-11-16T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const SECURITY = id<'Account'>(0xa001);
const VIEWER = id<'Account'>(0xa002);
const BUYER = id<'Account'>(0xa201);
const ROLE = id<'Role'>(0xe001);
const VIEW_ROLE = id<'Role'>(0xe002);
const KEYS = [
  'customers.customers.view',
  'customers.customers.export',
  'cart.customer-cart.view',
  'notifications.customer-cart-reminder.view',
  'engagement.customer-behaviour.view',
  'legal.customer-consent.view',
  'assistant.customer-conversation.view',
];
const EXPORT_STEP_UP = 'customers.customers.export';
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

describe.each(TEST_MARKETS)('customer page activity sections over HTTP in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let clock: FixedClock;
  let timeline: InMemoryCustomerTimeline;
  let saved: InMemorySavedItems;
  let events: InMemoryBehaviourEvents;
  let settings: InMemoryPersonalizationSettings;
  let consents: InMemoryMarketingConsents;
  let conversations: MemoryConversations;
  const currency = code === 'AU' ? 'AUD' : 'NZD';
  const carts = {
    findActiveByAccount: (m: MarketContext, accountId: Id<'Account'>): Promise<CartState | null> =>
      Promise.resolve(
        m.marketId === market.marketId && accountId === BUYER
          ? {
              id: id<'Cart'>(0xc001),
              marketId: market.marketId,
              owner: { kind: 'account', accountId },
              status: 'active',
              lastChangedAt: START,
              mergedIntoCartId: null,
              mergedAt: null,
              version: 1,
              createdAt: START.subtract({ hours: 2 }),
              lines: [
                {
                  id: id<'CartLine'>(0xc101),
                  offerId: id<'Offer'>(0xc201),
                  variantId: id<'Variant'>(0xc301),
                  quantity: 2,
                  priceAtAdd: money(1999n, currency),
                  addedAt: START.subtract({ hours: 1 }),
                },
              ],
            }
          : null,
      ),
  };
  const reminders = {
    pageOfAccount: (m: MarketContext, accountId: Id<'Account'>) =>
      Promise.resolve(
        m.marketId === market.marketId && accountId === BUYER
          ? [
              {
                accountId,
                cartChangedAt: START.subtract({ hours: 30 }),
                stage: 1 as const,
                takenAt: START.subtract({ hours: 6 }),
              },
            ]
          : [],
      ),
    countOfAccount: (m: MarketContext, accountId: Id<'Account'>) =>
      Promise.resolve(m.marketId === market.marketId && accountId === BUYER ? 1 : 0),
  };

  async function seedOwners() {
    saved = new InMemorySavedItems();
    events = new InMemoryBehaviourEvents();
    settings = new InMemoryPersonalizationSettings();
    consents = new InMemoryMarketingConsents();
    conversations = new MemoryConversations();
    for (const n of [1, 2]) {
      await saved.upsert(market, {
        id: id<'SavedItem'>(0xd000 + n),
        accountId: BUYER,
        offerId: id<'Offer'>(0xd100 + n),
        variantId: id<'Variant'>(0xd200 + n),
        savedAt: START.subtract({ hours: n }),
      });
    }
    const facts = [
      { kind: 'added-to-cart', offerId: id<'Offer'>(0xc201), variantId: id<'Variant'>(0xc301) },
      { kind: 'category-viewed', categoryId: id<'Category'>(0xe501) },
      { kind: 'search-performed', query: 'very private search' },
    ] as const;
    for (const [n, fact] of facts.entries()) {
      await events.append(market, {
        id: id<'BehaviourEvent'>(0xe000 + n),
        subject: { kind: 'account', accountId: BUYER },
        facts: fact,
        occurredAt: START.subtract({ hours: n + 1 }),
      });
    }
    await consents.record(
      market,
      {
        id: id<'MarketingConsent'>(0xe601),
        accountId: BUYER,
        channel: 'email',
        granted: true,
        source: 'sign-up',
        changedAt: START.subtract({ hours: 3 }),
        createdAt: START.subtract({ hours: 3 }),
      },
      {
        id: id<'MarketingConsentChange'>(0xe701),
        accountId: BUYER,
        channel: 'email',
        granted: true,
        source: 'sign-up',
        occurredAt: START.subtract({ hours: 3 }),
      },
    );
    await conversations.create(market, {
      id: '0199aaaa-0000-7000-8000-000000000001',
      owner: { kind: 'account', accountId: BUYER },
      turns: 0,
      retentionDays: 30,
      startedAt: START.subtract({ hours: 4 }),
    });
    await conversations.append(market, '0199aaaa-0000-7000-8000-000000000001', {
      role: 'buyer',
      text: 'a private question',
      cards: [],
      at: START,
    } as never);
  }
  const http = () => request(app!.getHttpServer());
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const marketId = code as AccountState['marketId'];

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
    await seedOwners();
    const list = new InMemoryCustomerList();
    list.add(market, row(BUYER));
    timeline = new InMemoryCustomerTimeline(list);
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
          .overrideProvider(CART_REPOSITORY)
          .useValue(carts)
          .overrideProvider(SAVED_ITEM_REPOSITORY)
          .useValue(saved)
          .overrideProvider(CART_REMINDER_REPOSITORY)
          .useValue(reminders)
          .overrideProvider(BEHAVIOUR_EVENT_REPOSITORY)
          .useValue(events)
          .overrideProvider(PERSONALIZATION_SETTING_REPOSITORY)
          .useValue(settings)
          .overrideProvider(MARKETING_CONSENT_REPOSITORY)
          .useValue(consents)
          .overrideProvider(CONVERSATION_REPOSITORY)
          .useValue(conversations),
    }));
    await app.get(SeedRoles).execute(testCallContext(market, 'system', 'sections-seed'), {});
    const role = (roleId: Id<'Role'>, keys: string[]) =>
      fakes.seedRole({
        id: roleId,
        marketId,
        scope: 'platform',
        kind: 'custom',
        seedCode: null,
        seedVersion: null,
        sellerId: null,
        name: `Sections ${keys.length}`,
        permissionKeys: keys,
        version: 1,
        createdAt: START,
      });
    role(ROLE, KEYS);
    role(VIEW_ROLE, ['customers.customers.view']);
    account(SECURITY, 'admin', 'security');
    account(VIEWER, 'admin', 'viewer');
    account(BUYER, 'customer', 'buyer');
    for (const [n, accountId, roleId] of [
      [1, SECURITY, ROLE],
      [2, VIEWER, VIEW_ROLE],
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
    // The seed's own audit rows are not this suite's subject.
    fakes.audits.length = 0;
  }

  function sessionOf(n: number, accountId: Id<'Account'>, population: 'admin' | 'customer') {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      market,
      openSession({
        id: id<'Session'>(0xf100 + n),
        marketId,
        accountId,
        population,
        sellerId: null,
        transport: 'cookie',
        device: population === 'customer' ? 'safari.ios' : null,
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

  it('reads the cart, the behaviour and the consent, each behind its owner’s key', async () => {
    await boot();
    const admin = sessionOf(1, SECURITY, 'admin');
    const viewer = sessionOf(2, VIEWER, 'admin');

    const cart = await http().get(`${base}/cart`).set(admin);
    expect(cart.status).toBe(200);
    expect(cart.headers['cache-control']).toBe('no-store');
    expect(cart.body).toMatchObject({
      savedCount: 2,
      cart: { lines: [{ quantity: 2, priceAtAdd: { amount: '1999', currency } }] },
    });

    const behaviour = await http().get(`${base}/behaviour`).set(admin);
    expect(behaviour.status).toBe(200);
    expect(behaviour.body).toMatchObject({
      personalization: { enabled: true, changedAt: null },
      summary: { categoryViews: 1, cartAdditions: 1, productViews: 0 },
    });
    expect(JSON.stringify(behaviour.body)).not.toContain('private');

    const consent = await http().get(`${base}/consent`).set(admin);
    expect(consent.status).toBe(200);
    expect(consent.body).toMatchObject({
      channels: [{ channel: 'email', granted: true, source: 'sign-up' }],
    });

    for (const path of ['cart', 'behaviour', 'consent']) {
      const denied = await http().get(`${base}/${path}`).set(viewer);
      expect(denied.status).toBe(403);
    }
    const unknown = await http()
      .get(`/customers/admin/customers/${id(0xa999)}/cart`)
      .set(admin);
    expect(unknown.status).toBe(404);
  });

  it('pages each super list, behind its owner’s key and the CSRF token', async () => {
    await boot();
    const admin = sessionOf(1, SECURITY, 'admin');
    const viewer = sessionOf(2, VIEWER, 'admin');
    const lists: [string, number][] = [
      ['saved-items', 2],
      ['cart-reminders', 1],
      ['cart-additions', 1],
      ['consent-history', 1],
      ['assistant-conversations', 1],
    ];
    for (const [path, total] of lists) {
      const page = await http().post(`${base}/${path}`).set(admin).send({ paging: 'pages' });
      expect([path, page.status]).toEqual([path, 200]);
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.body).toMatchObject({ total, page: 1, hasNext: false });
      expect((page.body as { items: unknown[] }).items).toHaveLength(total);
      expect((await http().post(`${base}/${path}`).set(viewer).send({})).status).toBe(403);
      const stray = await http().post(`${base}/${path}`).set(admin).send({ accountId: BUYER });
      expect(stray.status).toBe(400);
    }
    const conversationsPage = await http()
      .post(`${base}/assistant-conversations`)
      .set(admin)
      .send({ paging: 'prev-next' });
    expect(conversationsPage.body).toMatchObject({ total: null, conversationCount: 1 });
    expect(JSON.stringify(conversationsPage.body)).not.toContain('private');
    const { 'x-csrf-token': _csrf, ...noCsrf } = admin;
    void _csrf;
    expect((await http().post(`${base}/saved-items`).set(noCsrf).send({})).status).toBe(403);
    const badRange = await http()
      .post(`${base}/cart-additions`)
      .set(admin)
      .send({ filters: { from: 'yesterday' } });
    expect(badRange.status).toBe(400);
  });

  it('asks a fresh two-step proof for an export, and writes the file with it', async () => {
    await boot();
    const admin = sessionOf(1, SECURITY, 'admin');
    const refused = await http()
      .post(`${base}/cart-additions/export`)
      .set(admin)
      .send({ format: 'csv' });
    expect(refused.status).toBe(403);
    expect((refused.body as { code: string }).code).toMatch(/^second-factor\./);

    fakes.factors.set(SECURITY, {
      id: id<'SecondFactor'>(0xf301),
      marketId,
      accountId: SECURITY,
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
    const file = await http()
      .post(`${base}/cart-additions/export`)
      .set(admin)
      .send({ format: 'csv' });
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('text/csv');
    expect(file.headers['cache-control']).toBe('no-store');
    expect(file.text).toContain(id(0xc201));
    expect(file.text).not.toContain('private');
    expect(
      fakes.audits.filter((audit) => audit.action === 'customers.customer-section.exported'),
    ).toMatchObject([{ targetId: BUYER, after: { section: 'cart-additions', rowCount: 1 } }]);
  });
});
