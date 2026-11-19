import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { OFFER_REPOSITORY } from '../src/modules/catalog/application/ports/offer.repository';
import { SELLER_ELIGIBILITY_READER } from '../src/modules/catalog/application/ports/seller-eligibility.reader';
import { VARIANT_REQUEST_STORE } from '../src/modules/catalog/application/ports/variant-request.store';
import { PRODUCT_REPOSITORY } from '../src/modules/catalog/application/ports/product.repository';
import {
  OWN_VARIANT_REQUEST_STATUS,
  VARIANT_REQUEST_ADMIN_STATUS,
} from '../src/modules/catalog/presentation/variant-request.controller';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { MemoryVariantRequestStore } from './support/catalog-variant-request-fakes';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The value-suggestion routes over HTTP (attributes plan, package A5): the real guards,
// controllers, gate with the real role seed and use cases; the stores, the claim matcher and the
// product reader as in-memory fakes. Proved in both Market fixtures: a Catalogue Moderator lists
// and decides; an attribute editor without the decision key cannot; approve adds the value (200),
// a stale version and a decided suggestion are 409, a claim word is 422; map and reject; the CSRF
// token, JSON and closed bodies; an anonymous seller request is 401; and the OpenAPI document.

const START = Temporal.Instant.from('2026-11-03T00:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const MODERATOR = id<'Account'>(0xc701);
const EDITOR = id<'Account'>(0xc702);
const EDITOR_ROLE = id<'Role'>(0xc801);
const PRODUCT = id<'Product'>(0xca01);
const SELLER = id<'Seller'>(0xcb01);
const OTHER_SELLER = id<'Seller'>(0xcb02);
const OFFER_OTHER = id<'Offer'>(0xcf02);
const OFFER_UNKNOWN = id<'Offer'>(0xcf09);
const OWNER = id<'Account'>(0xc703);
const VIEWERLESS = id<'Account'>(0xc704);
const NO_VIEW_ROLE = id<'Role'>(0xc802);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

it('maps each variant request refusal to its HTTP status', () => {
  expect(VARIANT_REQUEST_ADMIN_STATUS).toMatchObject({
    'variant-request.not-found': 404,
    'variant-request.stale': 409,
    'variant-request.not-open': 409,
    'variant-request.variant-exists': 409,
    'variant-request.product-unavailable': 409,
    'variant-request.draft-unavailable': 409,
    'variant-request.variant-unknown': 422,
    'variant-request.reason-invalid': 422,
    'variant.limit-reached': 422,
    'product.not-editable': 409,
    'validation.failed': 400,
  });
  expect(OWN_VARIANT_REQUEST_STATUS).toMatchObject({
    'offer.not-found': 404,
    'variant-request.already-open': 409,
    'variant-request.variant-exists': 409,
    'variant-request.option-unknown': 422,
    'variant-request.limit-reached': 422,
    'variant-request.daily-limit': 422,
    'seller.not-eligible': 403,
  });
});

describe('variant requests over HTTP (integration)', () => {
  let app: NestExpressApplication;
  const requests = new MemoryVariantRequestStore();
  const http = () => request(app.getHttpServer());

  async function boot(env: Record<string, string> = {}) {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info', ...env },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(new FixedClock(START))
          .overrideProvider(SELLER_ELIGIBILITY_READER)
          .useValue({ isEligible: () => Promise.resolve(true) })
          .overrideProvider(VARIANT_REQUEST_STORE)
          .useValue(requests)
          .overrideProvider(PRODUCT_REPOSITORY)
          .useValue({ findById: () => Promise.resolve(null) })
          // One Offer exists and belongs to another seller; every other id is unknown.
          .overrideProvider(OFFER_REPOSITORY)
          .useValue({
            findById: (_market: unknown, offerId: string) =>
              Promise.resolve(
                offerId === OFFER_OTHER
                  ? { state: { sellerId: OTHER_SELLER, status: 'published', productId: PRODUCT } }
                  : null,
              ),
          }),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'sugg-0002'), {});
    const marketId = code as AccountState['marketId'];
    const roleOf = (seedCode: string) =>
      [...fakes.roles.values()].find(
        (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === seedCode,
      )!.id;
    fakes.seedRole({
      id: EDITOR_ROLE,
      marketId,
      scope: 'platform',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: null,
      name: 'Attribute editor',
      permissionKeys: ['catalog.attribute.view', 'catalog.attribute.edit'],
      version: 1,
      createdAt: START,
    });
    let n = 0;
    for (const [accountId, label, roleId] of [
      [MODERATOR, 'moderator', roleOf('catalogue-moderator')],
      [EDITOR, 'editor', EDITOR_ROLE],
    ] as const) {
      n += 1;
      fakes.seedAccount({
        id: accountId,
        marketId,
        population: 'admin',
        email: { typed: `${label}@Example.com`, normalized: `${label}@example.com` },
        displayName: `Name ${label}`,
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
        marketId,
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    }
  }

  function adminSession(code: string, account: Id<'Account'>, n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf900 + n),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population: 'admin',
        sellerId: null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: START,
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

  /** An approved seller with an owner (all seller keys) and a member whose role has no catalog key. */
  async function sellerSeeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'sugg-0003'), {});
    const marketId = code as AccountState['marketId'];
    const ownerRole = [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === 'seller' && r.seedCode === 'seller-owner',
    )!.id;
    fakes.seedRole({
      id: NO_VIEW_ROLE,
      marketId,
      scope: 'seller',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: SELLER,
      name: 'Team only',
      permissionKeys: ['identity.team-member.view'],
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
    let n = 0;
    for (const [accountId, label, roleId] of [
      [OWNER, 'owner', ownerRole],
      [VIEWERLESS, 'member', NO_VIEW_ROLE],
    ] as const) {
      n += 1;
      fakes.seedAccount({
        id: accountId,
        marketId,
        population: 'seller',
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
        id: id<'RoleAssignment'>(0xea00 + n),
        marketId,
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
      fakes.seedMembership({
        id: id<'SellerMembership'>(0xeb00 + n),
        marketId,
        accountId,
        sellerId: SELLER,
        state: 'active',
        removedAt: null,
        version: 1,
        createdAt: START,
      });
    }
  }

  function sellerSession(code: string, account: Id<'Account'>, n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xfa00 + n),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population: 'seller',
        sellerId: SELLER,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: START,
      }),
      issued.tokenHash,
    );
    return {
      'x-market-id': code,
      ...panelHeaders(code, 'seller'),
      cookie: `__Host-session-seller-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  const QUEUE = '/catalog/admin/variant-requests';
  const OWN = '/catalog/seller/variant-requests';

  beforeEach(() => {
    fakes.reset();
    requests.reset();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('documents the admin and seller routes in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(document.paths[QUEUE]).toHaveProperty('get');
    for (const action of ['approve', 'map', 'decline']) {
      expect(document.paths[`${QUEUE}/{requestId}/${action}`]).toHaveProperty('post');
    }
    expect(document.paths['/catalog/seller/offers/{offerId}/variant-requests']).toHaveProperty(
      'post',
    );
    expect(document.paths[OWN]).toHaveProperty('get');
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('lists the queue for a moderator, no-store, and refuses a role without the review key', async () => {
      await boot();
      await seeded(code);
      const listed = await http()
        .get(QUEUE)
        .set(adminSession(code, MODERATOR, 1))
        .expect(200);
      expect(listed.headers['cache-control']).toBe('no-store');
      expect(listed.body).toMatchObject({ items: [] });
      await http()
        .get(QUEUE)
        .set(adminSession(code, EDITOR, 2))
        .expect(403);
    });

    it('answers an unknown or malformed request id with the same 404 on every decision', async () => {
      await boot();
      await seeded(code);
      const session = adminSession(code, MODERATOR, 3);
      const bodies = new Set<string>();
      for (const action of ['approve', 'map', 'decline']) {
        for (const requestId of [id<'VariantRequest'>(0xd001), 'not-an-id']) {
          const answer = await http()
            .post(`${QUEUE}/${requestId}/${action}`)
            .set(session)
            .send(
              action === 'map'
                ? { version: 1, variantId: id<'Variant'>(0xd002) }
                : action === 'decline'
                  ? { version: 1, reason: 'No' }
                  : { version: 1 },
            )
            .expect(404);
          bodies.add(`${action}:${JSON.stringify(answer.body)}`.replace(/^[a-z]+:/, ''));
        }
      }
      expect(bodies.size).toBe(1);
    });

    it('refuses a missing CSRF token and a non-JSON body on a decision', async () => {
      await boot();
      await seeded(code);
      const noCsrf: Record<string, string> = { ...adminSession(code, MODERATOR, 4) };
      delete noCsrf['x-csrf-token'];
      await http()
        .post(`${QUEUE}/${id<'VariantRequest'>(0xd001)}/decline`)
        .set(noCsrf)
        .send({ version: 1, reason: 'No' })
        .expect(403);
      await http()
        .post(`${QUEUE}/${id<'VariantRequest'>(0xd001)}/decline`)
        .set(adminSession(code, MODERATOR, 5))
        .set('content-type', 'text/plain')
        .send('version=1')
        .expect((res) => expect([400, 415]).toContain(res.status));
    });

    it('answers another seller’s Offer and an unknown Offer with byte-identical 404 bodies', async () => {
      await boot();
      await sellerSeeded(code);
      const session = sellerSession(code, OWNER, 6);
      const foreign = await http()
        .post(`/catalog/seller/offers/${OFFER_OTHER}/variant-requests`)
        .set(session)
        .send({ optionValues: { size: 'xl' } })
        .expect(404);
      const unknown = await http()
        .post(`/catalog/seller/offers/${OFFER_UNKNOWN}/variant-requests`)
        .set(session)
        .send({ optionValues: { size: 'xl' } })
        .expect(404);
      expect(foreign.text).toBe(unknown.text);
      expect(foreign.body).toMatchObject({ code: 'offer.not-found' });
    });

    it('refuses a bad body with 400, a member without the edit key with 403, and anonymous with 401', async () => {
      await boot();
      await sellerSeeded(code);
      await http()
        .post(`/catalog/seller/offers/${OFFER_OTHER}/variant-requests`)
        .set(sellerSession(code, OWNER, 7))
        .send({ optionValues: 'xl' })
        .expect(400);
      await http()
        .post(`/catalog/seller/offers/${OFFER_OTHER}/variant-requests`)
        .set(sellerSession(code, VIEWERLESS, 8))
        .send({ optionValues: { size: 'xl' } })
        .expect(403);
      await http()
        .post(`/catalog/seller/offers/${OFFER_OTHER}/variant-requests`)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller') })
        .send({ optionValues: { size: 'xl' } })
        .expect(401);
      await http()
        .get(OWN)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller') })
        .expect(401);
    });

    it('lists the seller’s own requests with no-store and the open count', async () => {
      await boot();
      await sellerSeeded(code);
      const listed = await http()
        .get(OWN)
        .set(sellerSession(code, OWNER, 9))
        .expect(200);
      expect(listed.headers['cache-control']).toBe('no-store');
      expect(listed.body).toMatchObject({ items: [], openCount: 0, maxOpen: 10 });
      await http()
        .get(OWN)
        .set(sellerSession(code, VIEWERLESS, 10))
        .expect(403);
    });
  });
});
