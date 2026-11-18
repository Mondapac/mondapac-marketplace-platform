import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { CUSTOMER_READ_MODEL_REPOSITORY } from '../src/modules/customers/application/ports/customer-read-models.repository';
import {
  INVITE_LINK_REPOSITORY,
  SELLER_ATTRIBUTION_REPOSITORY,
} from '../src/modules/customers/application/ports/seller-invitations.repository';
import { InMemoryReadModels } from '../src/modules/customers/application/testing/in-memory-read-models';
import {
  InMemoryInviteLinks,
  InMemorySellerAttributions,
} from '../src/modules/customers/application/testing/in-memory-seller-invitations';
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

// The invite link routes over HTTP (customers phase 4a): the real guards, gate, controllers and use
// cases; links, attributions and the directory in memory; identity's fakes. Proves the anonymous
// resolve (one not-found answer, no-store), CSRF on the admin writes, the keys (a viewer lists but
// cannot decide), the closed bodies and the export's step-up, in both Markets.

const START = Temporal.Instant.from('2026-11-17T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const MANAGER = id<'Account'>(0xa001);
const VIEWER = id<'Account'>(0xa002);
const BUYER = id<'Account'>(0xa201);
const SHOP = id<'Seller'>(0x5101);
const ROLE = id<'Role'>(0xe001);
const VIEW_ROLE = id<'Role'>(0xe002);
const KEYS = [
  'customers.customers.view',
  'customers.customers.export',
  'customers.seller-attributions.manage',
];
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

describe.each(TEST_MARKETS)('seller invite link routes over HTTP in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let clock: FixedClock;
  let links: InMemoryInviteLinks;
  let attributions: InMemorySellerAttributions;
  const http = () => request(app!.getHttpServer());
  const market = testMarketContext(code, PLATFORM_TENANT_ID);

  async function boot() {
    const readModels = new InMemoryReadModels();
    await readModels.upsertDirectory(market, {
      accountId: BUYER,
      email: 'buyer@example.test',
      displayName: 'Buyer',
      status: 'active',
      emailVerified: true,
      signedUpAt: START,
    });
    links = new InMemoryInviteLinks();
    attributions = new InMemorySellerAttributions(readModels.directory);
    links.rows.push({
      id: id<'SellerInviteLink'>(0x1101),
      marketId: market.marketId,
      sellerId: SHOP,
      token: 'AAAAAAAAAAAAAAAAAAAAAAAAAA',
      createdByAccountId: id<'Account'>(0x5001),
      createdAt: START,
      revokedAt: null,
    });
    attributions.rows.push({
      marketId: market.marketId,
      accountId: BUYER,
      sellerId: SHOP,
      linkId: id<'SellerInviteLink'>(0x1101),
      attributedAt: START,
      status: 'active',
      rejectReason: null,
      flags: ['link-burst'],
      decidedByAccountId: null,
      decidedAt: null,
      version: 1,
    });
    ({ app } = await createTestApp({
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(CUSTOMER_READ_MODEL_REPOSITORY)
          .useValue(readModels)
          .overrideProvider(INVITE_LINK_REPOSITORY)
          .useValue(links)
          .overrideProvider(SELLER_ATTRIBUTION_REPOSITORY)
          .useValue(attributions),
    }));
    await app
      .get(SeedRoles)
      .execute(testCallContext(market, 'system', 'invitations-admin-seed'), {});
    const role = (roleId: Id<'Role'>, keys: string[]) =>
      fakes.seedRole({
        id: roleId,
        marketId: code as AccountState['marketId'],
        scope: 'platform',
        kind: 'custom',
        seedCode: null,
        seedVersion: null,
        sellerId: null,
        name: `Attributions ${keys.length}`,
        permissionKeys: keys,
        version: 1,
        createdAt: START,
      });
    role(ROLE, KEYS);
    role(VIEW_ROLE, ['customers.customers.view']);
    for (const [n, accountId, roleId, label] of [
      [1, MANAGER, ROLE, 'manager'],
      [2, VIEWER, VIEW_ROLE, 'viewer'],
    ] as const) {
      fakes.seedAccount({
        id: accountId,
        marketId: code as AccountState['marketId'],
        population: 'admin',
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

  it('answers an unknown or malformed token with one not-found, uncached, without a session', async () => {
    await boot();
    for (const token of ['ZZZZZZZZZZZZZZZZZZZZZZZZZZ', 'nope']) {
      const res = await http()
        .get(`/customers/store-invitations/${token}`)
        .set('x-market-id', code);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'customers.invitation-not-found' });
      expect(res.headers['cache-control']).toBe('no-store');
    }
  });

  it('lists for a viewer, refuses a viewer’s decision and a write without CSRF', async () => {
    await boot();
    const viewer = sessionOf(2, VIEWER);
    const listed = await http()
      .post('/customers/admin/seller-attributions/list')
      .set(viewer)
      .send({});
    expect(listed.status).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(listed.body).toMatchObject({
      items: [{ accountId: BUYER, email: 'buyer@example.test', flags: ['link-burst'] }],
      counts: { suspicious: 1, all: 1 },
    });
    const denied = await http()
      .post('/customers/admin/seller-attributions/decide')
      .set(viewer)
      .send({ decision: 'reject', accountIds: [BUYER] });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'access.denied' });
    const { 'x-csrf-token': _csrf, ...noCsrf } = sessionOf(1, MANAGER);
    void _csrf;
    const refused = await http()
      .post('/customers/admin/seller-attributions/decide')
      .set(noCsrf)
      .send({ decision: 'reject', accountIds: [BUYER] });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'request.csrf' });
    expect(attributions.rows[0]).toMatchObject({ status: 'active', version: 1 });
  });

  it('rejects with the key, refuses an unknown field, and asks a fresh proof for the export', async () => {
    await boot();
    const manager = sessionOf(1, MANAGER);
    const unknown = await http()
      .post('/customers/admin/seller-attributions/decide')
      .set(manager)
      .send({ decision: 'reject', accountIds: [BUYER], sellerId: SHOP });
    expect(unknown.status).toBe(400);
    const decided = await http()
      .post('/customers/admin/seller-attributions/decide')
      .set(manager)
      .send({ decision: 'reject', accountIds: [BUYER] });
    expect(decided.status).toBe(200);
    expect(decided.body).toEqual({
      results: [{ accountId: BUYER, outcome: 'changed', status: 'rejected' }],
    });
    const exported = await http()
      .post('/customers/admin/seller-attributions/export')
      .set(manager)
      .send({ format: 'csv' });
    expect(exported.status).toBe(403);
    expect((exported.body as { code: string }).code).toMatch(/^second-factor\./);
  });
});
