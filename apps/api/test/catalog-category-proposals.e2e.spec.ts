import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { CATEGORY_EDIT_STORE } from '../src/modules/catalog/application/ports/category-edit.store';
import { CATEGORY_PROPOSAL_CAPABILITY } from '../src/modules/catalog/application/ports/category-proposal-capability';
import { CLAIM_TERM_LOCALES } from '../src/modules/catalog/application/ports/claim-term-locales';
import { CLAIM_TEXT_MATCHER } from '../src/modules/catalog/application/ports/claim-text-matcher';
import { PLATFORM_CATEGORY_REPOSITORY } from '../src/modules/catalog/application/ports/platform-category.repository';
import { RATE_COUNTER_KEYS } from '../src/modules/catalog/application/ports/rate-counter-keys';
import { RATE_COUNTER_REPOSITORY } from '../src/modules/catalog/application/ports/rate-counter.repository';
import { SELLER_ELIGIBILITY_READER } from '../src/modules/catalog/application/ports/seller-eligibility.reader';
import { SELLER_NAMES_READER } from '../src/modules/catalog/application/ports/seller-names.reader';
import {
  SELLER_CATEGORY_STORE,
  type SellerCategoryStore,
} from '../src/modules/catalog/application/ports/seller-category.store';
import { ConfigCatalogMarketPolicy } from '../src/modules/catalog/infrastructure/config-catalog-market-policy';
import { CATEGORY_PROPOSAL_ADMIN_STATUS } from '../src/modules/catalog/presentation/category-proposal-admin.controller';
import { OWN_CATEGORY_PROPOSAL_STATUS } from '../src/modules/catalog/presentation/own-category-proposal.controller';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { MarketRegistry } from '../src/platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import {
  MemoryCategoryEditStore,
  MemoryTreeVersion,
} from './support/catalog-category-editor-fakes';
import { MemorySellerCategoryStore } from './support/catalog-seller-category-fakes';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The seller category proposal routes and the admin proposal and shelf routes over HTTP (categories
// C9a; CAT-51 to CAT-54): the real guards, the gate with the real role seed, the real use cases and
// controllers; the shelf store as an in-memory fake that keeps the Markets apart (one store per
// Market behind one port), and the ports to other modules as fixed fakes. Proved here, in both
// Market fixtures: no session is 401, a closed body refuses an unknown key with the validation
// shape, the refusal-to-status table of both controllers, 404 for an unknown, malformed or
// other-Market id (another seller's proposal included), and the routes are in OpenAPI.

const START = Temporal.Instant.from('2026-11-08T00:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const OWNER = id<'Account'>(0xa901);
const OTHER_OWNER = id<'Account'>(0xa902);
const ADMIN = id<'Account'>(0xa911);
const DECIDER = id<'Account'>(0xa912);
const DECIDER_ROLE = id<'Role'>(0xf931);
const SELLER = id<'Seller'>(0xb901);
const OTHER_SELLER = id<'Seller'>(0xb902);
const cat = (n: number): Id<'Category'> => id<'Category'>(0xcd00 + n);
const MISSING = id<'CategoryProposal'>(0xdfff);

/**
 * One in-memory store per Market behind the one port: a call picks its store by the Market it
 * carries, so an id of the other Market is unknown, as the SQL store's `market_id` does.
 */
class PerMarketShelves {
  readonly stores = new Map<string, MemorySellerCategoryStore>();
  of(marketId: string): MemorySellerCategoryStore {
    let store = this.stores.get(marketId);
    if (store === undefined) {
      store = new MemorySellerCategoryStore();
      this.stores.set(marketId, store);
    }
    return store;
  }
  asPort(): SellerCategoryStore {
    const methods = Object.getOwnPropertyNames(MemorySellerCategoryStore.prototype).filter(
      (name) => name !== 'constructor' && name !== 'snapshot',
    );
    const port: Record<string, (market: MarketContext, ...rest: unknown[]) => unknown> = {};
    for (const name of methods) {
      port[name] = (market, ...rest) => {
        const store = this.of(market.marketId) as unknown as Record<
          string,
          (...args: unknown[]) => unknown
        >;
        return store[name]!(market, ...rest);
      };
    }
    return port as unknown as SellerCategoryStore;
  }
}

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

describe.each(TEST_MARKETS)(
  'category proposal routes over HTTP in market %s (integration)',
  (code) => {
    let app: NestExpressApplication;
    const clock = new FixedClock(START);
    const http = () => request(app.getHttpServer());
    const market = testMarketContext(code, PLATFORM_TENANT_ID);
    const otherCode = TEST_MARKETS.find((candidate) => candidate !== code)!;
    const shelves = new PerMarketShelves();
    const tree = new MemoryCategoryEditStore();
    const treeVersion = new MemoryTreeVersion();
    let mayPropose: boolean;
    let eligible: boolean;
    let reservedCount: number;
    let defaultLocale: string;
    let maxPending: number;
    const store = () => shelves.of(code);

    beforeEach(async () => {
      fakes.reset();
      shelves.stores.clear();
      tree.reset();
      treeVersion.version = 1;
      mayPropose = true;
      eligible = true;
      reservedCount = 1;
      ({ app } = await createTestApp({
        env: { LOG_LEVEL: 'info', API_DOCS_ENABLED: 'true' },
        panelOrigins: true,
        override: (builder) =>
          fakes
            .override(builder)
            .overrideProvider(CLOCK)
            .useValue(clock)
            .overrideProvider(SELLER_CATEGORY_STORE)
            .useValue(shelves.asPort())
            .overrideProvider(CATEGORY_PROPOSAL_CAPABILITY)
            .useValue({ allows: () => Promise.resolve(mayPropose) })
            .overrideProvider(SELLER_ELIGIBILITY_READER)
            .useValue({ isEligible: () => Promise.resolve(eligible) })
            .overrideProvider(SELLER_NAMES_READER)
            .useValue({
              storeNames: (_c: unknown, ids: readonly string[]) =>
                Promise.resolve(new Map(ids.map((sellerId) => [sellerId, 'Shop']))),
            })
            .overrideProvider(RATE_COUNTER_KEYS)
            .useValue({ keyOf: () => new Uint8Array(32) })
            .overrideProvider(RATE_COUNTER_REPOSITORY)
            .useValue({
              reserve: (
                _m: unknown,
                asked: readonly { limit: { kind: string } }[],
                now: Temporal.Instant,
              ) =>
                Promise.resolve(
                  asked.map((counter) => ({
                    kind: counter.limit.kind,
                    count: reservedCount,
                    windowStartedAt: now,
                  })),
                ),
            })
            .overrideProvider(CLAIM_TEXT_MATCHER)
            .useValue({
              match: (_c: unknown, texts: readonly { text: string }[]) =>
                Promise.resolve({
                  ok: true as const,
                  value: texts.map((t) =>
                    /halal/i.test(t.text)
                      ? [{ typeCode: 'halal', span: { fromToken: 0, toToken: 0 } }]
                      : [],
                  ),
                }),
            })
            .overrideProvider(CLAIM_TERM_LOCALES)
            .useValue({
              covered: () =>
                Promise.resolve({ ok: true, value: ['en-AU', 'en-US', 'ja-JP', 'fa', 'ar'] }),
            })
            .overrideProvider(CATEGORY_EDIT_STORE)
            .useValue(tree)
            .overrideProvider(PLATFORM_CATEGORY_REPOSITORY)
            .useValue(treeVersion),
      }));
      const policy = new ConfigCatalogMarketPolicy(app.get(MarketRegistry));
      defaultLocale = policy.locales(market).default;
      maxPending = policy.maxPendingCategoryProposals(market);
      // Live platform categories in both Markets: the same ids, so only the Market tells them apart.
      for (const marketId of [code, otherCode]) {
        shelves.of(marketId).platform.set(cat(1), 'active');
        shelves.of(marketId).platform.set(cat(2), 'active');
      }
      shelves.of(otherCode).platform.set(cat(9), 'active');

      await app.get(SeedRoles).execute(testCallContext(market, 'system', 'proposal-0001'), {});
      const marketId = code as AccountState['marketId'];
      const roleOf = (scope: 'seller' | 'platform', seedCode: string) =>
        [...fakes.roles.values()].find(
          (r) => r.marketId === code && r.scope === scope && r.seedCode === seedCode,
        )!.id;
      // Decides proposals but holds no protected key (a default role never lists one).
      fakes.seedRole({
        id: DECIDER_ROLE,
        marketId,
        scope: 'platform',
        kind: 'custom',
        seedCode: null,
        seedVersion: null,
        sellerId: null,
        name: 'Proposal decider',
        permissionKeys: ['catalog.category-proposal.decide'],
        version: 1,
        createdAt: START,
      });
      for (const sellerId of [SELLER, OTHER_SELLER]) {
        fakes.seedSellerAccess({
          sellerId,
          marketId,
          origin: 'self',
          state: 'approved',
          stateChangedAt: START,
          reapplyCount: 0,
          registeredAt: START,
          version: 3,
          createdAt: START,
        });
      }
      let n = 0;
      for (const [accountId, label, population, roleId, sellerId] of [
        [OWNER, 'owner', 'seller', roleOf('seller', 'seller-owner'), SELLER],
        [OTHER_OWNER, 'other', 'seller', roleOf('seller', 'seller-owner'), OTHER_SELLER],
        [ADMIN, 'admin', 'admin', roleOf('platform', 'platform-administrator'), null],
        [DECIDER, 'decider', 'admin', DECIDER_ROLE, null],
      ] as const) {
        n += 1;
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
        fakes.seedAssignment({
          id: id<'RoleAssignment'>(0xe900 + n),
          marketId,
          accountId,
          roleId,
          assignedByAccountId: null,
          assignedAt: START,
          version: 1,
        });
        if (sellerId !== null) {
          fakes.seedMembership({
            id: id<'SellerMembership'>(0xf900 + n),
            marketId,
            accountId,
            sellerId,
            state: 'active',
            removedAt: null,
            version: 1,
            createdAt: START,
          });
        }
      }
    });
    afterEach(async () => {
      await app?.close();
    });

    let sessionNo = 0;
    function sessionFor(
      population: 'seller' | 'admin',
      account: Id<'Account'>,
      sellerId: Id<'Seller'> | null,
    ) {
      sessionNo += 1;
      const issued = tokens.issue();
      void fakes.sessionRepository.add(
        market,
        openSession({
          id: id<'Session'>(0xfc00 + sessionNo),
          marketId: code as AccountState['marketId'],
          accountId: account,
          population,
          sellerId,
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
    const seller = () => sessionFor('seller', OWNER, SELLER);
    const admin = () => sessionFor('admin', ADMIN, null);
    const decider = () => sessionFor('admin', DECIDER, null);
    const anonymous = (population: 'seller' | 'admin') => ({
      'x-market-id': code,
      ...panelHeaders(code, population),
    });

    const SELLER_BASE = '/catalog/seller';
    const ADMIN_BASE = '/catalog/admin';
    const propose = (name: string, parent = 2, extra: Record<string, unknown> = {}) => ({
      platformParentId: cat(parent),
      texts: { [defaultLocale]: { name, ...extra } },
    });
    const proposeOk = async (name: string, parent = 2): Promise<string> => {
      const response = await http()
        .post(`${SELLER_BASE}/category-proposals`)
        .set(seller())
        .send(propose(name, parent))
        .expect(201);
      return (response.body as { proposalId: string }).proposalId;
    };
    const approveOk = async (proposalId: string): Promise<string> => {
      const response = await http()
        .post(`${ADMIN_BASE}/category-proposals/${proposalId}/approve`)
        .set(admin())
        .send({ version: 1 })
        .expect(200);
      return (response.body as { sellerCategoryId: string }).sellerCategoryId;
    };
    /** A pending proposal of the other seller, written straight to the store of the Market. */
    const foreignProposal = async (
      marketId: string,
      n: number,
    ): Promise<Id<'CategoryProposal'>> => {
      const proposalId = id<'CategoryProposal'>(0xd900 + n);
      await shelves.of(marketId).addProposal(testMarketContext(marketId, PLATFORM_TENANT_ID), {
        id: proposalId,
        sellerId: OTHER_SELLER,
        platformParentId: cat(2),
        texts: [{ locale: defaultLocale, name: 'Foreign', description: null }],
        normalisedName: `foreign ${n}`,
        now: START,
      });
      return proposalId;
    };
    const foreignShelf = async (marketId: string, n: number): Promise<Id<'SellerCategory'>> => {
      const shelfId = id<'SellerCategory'>(0xd800 + n);
      await shelves.of(marketId).insertShelf(testMarketContext(marketId, PLATFORM_TENANT_ID), {
        id: shelfId,
        sellerId: OTHER_SELLER,
        platformParentId: cat(2),
        slug: `foreign-${n}`,
        texts: [{ locale: defaultLocale, name: 'Foreign shelf', description: null }],
        now: START,
      });
      return shelfId;
    };

    type Error = { statusCode: number; code: string; details?: Record<string, unknown> };

    describe('the session gate', () => {
      // A valid body for each write: the closed body is checked before the use case's gate, so an
      // empty body would answer 400 and never reach the session check.
      const sellerRoutes = [
        ['get', '/category-proposals', {}],
        ['post', '/category-proposals', { platformParentId: cat(2), texts: { en: { name: 'x' } } }],
        ['post', `/category-proposals/${MISSING}/cancel`, { version: 1 }],
        ['put', `/offers/${MISSING}/shelf`, { shelfId: null, version: 1 }],
      ] as const;
      const adminRoutes = [
        ['get', '/category-proposals', {}],
        ['post', `/category-proposals/${MISSING}/approve`, { version: 1 }],
        ['post', `/category-proposals/${MISSING}/reject`, { version: 1, reasonCode: 'other' }],
        ['get', `/sellers/${SELLER}/shelves`, {}],
        ['post', `/shelves/${MISSING}/promote`, { version: 1, slug: 'x', treeVersion: 1 }],
        ['post', `/shelves/${MISSING}/merge`, { version: 1, categoryId: cat(1) }],
      ] as const;

      it.each(sellerRoutes)(
        'refuses %s %s of the seller with no session as 401',
        async (verb, path, body) => {
          await http()
            [verb](`${SELLER_BASE}${path}`)
            .set(anonymous('seller'))
            .send(body)
            .expect(401);
        },
      );

      it.each(adminRoutes)(
        'refuses %s %s of the admin with no session as 401',
        async (verb, path, body) => {
          await http()[verb](`${ADMIN_BASE}${path}`).set(anonymous('admin')).send(body).expect(401);
        },
      );

      it('refuses a write with no CSRF token as 403 request.csrf', async () => {
        const withoutToken: Record<string, string> = { ...seller() };
        delete withoutToken['x-csrf-token'];
        const response = await http()
          .post(`${SELLER_BASE}/category-proposals`)
          .set(withoutToken)
          .send(propose('Spices'))
          .expect(403);
        expect((response.body as Error).code).toBe('request.csrf');
      });

      it('refuses a seller session on an admin route and the reverse', async () => {
        await http().get(`${ADMIN_BASE}/category-proposals`).set(seller()).expect(401);
        await http().get(`${SELLER_BASE}/category-proposals`).set(admin()).expect(401);
      });

      it('refuses the admin who holds the decide key but not the protected promote and merge key', async () => {
        const shelfId = await approveOk(await proposeOk('Spices'));
        const session = decider();
        await http()
          .post(`${ADMIN_BASE}/shelves/${shelfId}/promote`)
          .set(session)
          .send({ version: 1, slug: 'spices', treeVersion: 1 })
          .expect(403);
        await http()
          .post(`${ADMIN_BASE}/shelves/${shelfId}/merge`)
          .set(session)
          .send({ version: 1, categoryId: cat(1) })
          .expect(403);
        await http().get(`${ADMIN_BASE}/category-proposals`).set(session).expect(200);
      });
    });

    describe('closed bodies', () => {
      const cases = [
        ['seller', 'POST /category-proposals', 'post', `${SELLER_BASE}/category-proposals`],
        [
          'seller',
          'POST /category-proposals/:id/cancel',
          'post',
          `${SELLER_BASE}/category-proposals/${MISSING}/cancel`,
        ],
        ['seller', 'PUT /offers/:id/shelf', 'put', `${SELLER_BASE}/offers/${MISSING}/shelf`],
        [
          'admin',
          'POST /category-proposals/:id/approve',
          'post',
          `${ADMIN_BASE}/category-proposals/${MISSING}/approve`,
        ],
        [
          'admin',
          'POST /category-proposals/:id/reject',
          'post',
          `${ADMIN_BASE}/category-proposals/${MISSING}/reject`,
        ],
        ['admin', 'POST /shelves/:id/promote', 'post', `${ADMIN_BASE}/shelves/${MISSING}/promote`],
        ['admin', 'POST /shelves/:id/merge', 'post', `${ADMIN_BASE}/shelves/${MISSING}/merge`],
      ] as const;

      it.each(cases)(
        '%s %s: an unknown key is 400 with the validation shape',
        async (who, _name, verb, path) => {
          const session = who === 'seller' ? seller() : admin();
          const response = await http()[verb](path).set(session).send({ surprise: 1 }).expect(400);
          const body = response.body as Error;
          expect(body.statusCode).toBe(400);
          expect(body.code).toBe('validation.failed');
          expect(body.details?.['fields']).toEqual(
            expect.arrayContaining([{ path: 'surprise', code: 'unknown-field' }]),
          );
        },
      );

      it('names a missing required key', async () => {
        const response = await http()
          .post(`${ADMIN_BASE}/category-proposals/${MISSING}/reject`)
          .set(admin())
          .send({ version: 1 })
          .expect(400);
        expect((response.body as Error).details?.['fields']).toEqual([
          { path: 'reasonCode', code: 'required' },
        ]);
      });

      it('refuses a body that is not JSON as 415 and one that is not an object as 400', async () => {
        await http()
          .post(`${SELLER_BASE}/category-proposals`)
          .set(seller())
          .set('content-type', 'text/plain')
          .send('x')
          .expect(415);
        const response = await http()
          .post(`${SELLER_BASE}/category-proposals`)
          .set(seller())
          .send([1])
          .expect(400);
        expect((response.body as Error).code).toBe('validation.failed');
      });

      it('refuses a seller id in the propose body: the seller is the session’s', async () => {
        const response = await http()
          .post(`${SELLER_BASE}/category-proposals`)
          .set(seller())
          .send({ ...propose('Spices'), sellerId: OTHER_SELLER })
          .expect(400);
        expect((response.body as Error).code).toBe('validation.failed');
        expect(store().proposals.size).toBe(0);
      });
    });

    describe('the refusals of the seller routes', () => {
      it('maps the table of the controller', () => {
        expect(OWN_CATEGORY_PROPOSAL_STATUS).toMatchObject({
          'category-proposal.limit': 422,
          'category-proposal.duplicate': 409,
          'category-proposal.not-allowed': 403,
          'seller.not-eligible': 403,
          'category.parent-not-found': 404,
          'request.throttled': 429,
        });
      });

      it('proposes, lists and cancels', async () => {
        const proposalId = await proposeOk('Spices');
        const list = await http()
          .get(`${SELLER_BASE}/category-proposals`)
          .set(seller())
          .expect(200);
        expect(list.headers['cache-control']).toBe('no-store');
        const listed = list.body as {
          canPropose: boolean;
          maxPending: number;
          proposals: { id: string; status: string }[];
        };
        expect(listed.canPropose).toBe(true);
        expect(listed.maxPending).toBe(maxPending);
        expect(listed.proposals.map((p) => [p.id, p.status])).toEqual([[proposalId, 'pending']]);
        const cancelled = await http()
          .post(`${SELLER_BASE}/category-proposals/${proposalId}/cancel`)
          .set(seller())
          .send({ version: 1 })
          .expect(200);
        expect(cancelled.body).toMatchObject({ status: 'cancelled' });
        const again = await http()
          .post(`${SELLER_BASE}/category-proposals/${proposalId}/cancel`)
          .set(seller())
          .send({ version: 2 })
          .expect(409);
        expect((again.body as Error).code).toBe('category-proposal.not-pending');
      });

      it('answers category-proposal.duplicate as 409', async () => {
        await proposeOk('Spices');
        const response = await http()
          .post(`${SELLER_BASE}/category-proposals`)
          .set(seller())
          .send(propose('SPICES'))
          .expect(409);
        expect((response.body as Error).code).toBe('category-proposal.duplicate');
      });

      it('answers category-proposal.limit as 422 with the cap in details.max', async () => {
        for (let n = 1; n <= maxPending; n += 1) await proposeOk(`Shelf ${n}`);
        const response = await http()
          .post(`${SELLER_BASE}/category-proposals`)
          .set(seller())
          .send(propose('One too many'))
          .expect(422);
        expect(response.body).toEqual({
          statusCode: 422,
          code: 'category-proposal.limit',
          details: { max: maxPending },
        });
      });

      it('answers category-proposal.not-allowed as 403 when an admin turned SEL-26 off', async () => {
        mayPropose = false;
        const response = await http()
          .post(`${SELLER_BASE}/category-proposals`)
          .set(seller())
          .send(propose('Spices'))
          .expect(403);
        expect((response.body as Error).code).toBe('category-proposal.not-allowed');
        expect(store().proposals.size).toBe(0);
      });

      it('answers seller.not-eligible as 403 when the seller may not sell', async () => {
        eligible = false;
        const response = await http()
          .post(`${SELLER_BASE}/category-proposals`)
          .set(seller())
          .send(propose('Spices'))
          .expect(403);
        expect((response.body as Error).code).toBe('seller.not-eligible');
      });

      it('answers category.parent-not-found as 404 for an unknown parent and for a parent of the other Market', async () => {
        const unknown = await http()
          .post(`${SELLER_BASE}/category-proposals`)
          .set(seller())
          .send(propose('Spices', 77))
          .expect(404);
        expect((unknown.body as Error).code).toBe('category.parent-not-found');
        // cat(9) is live in the other Market only.
        const foreign = await http()
          .post(`${SELLER_BASE}/category-proposals`)
          .set(seller())
          .send(propose('Spices', 9))
          .expect(404);
        expect(foreign.body).toEqual(unknown.body);
      });

      it('answers a blocked term as 400 validation.failed naming the paths, never the words', async () => {
        const bad = code === 'AU' ? 'shit' : 'zzbad';
        const response = await http()
          .post(`${SELLER_BASE}/category-proposals`)
          .set(seller())
          .send(propose(`${bad} spices`))
          .expect(400);
        expect(response.body).toEqual({
          statusCode: 400,
          code: 'validation.failed',
          details: { fields: [{ path: `texts.${defaultLocale}.name`, code: 'blocked-term' }] },
        });
        expect(JSON.stringify(response.body)).not.toContain(bad);
      });

      it('answers a claim word as 422', async () => {
        const response = await http()
          .post(`${SELLER_BASE}/category-proposals`)
          .set(seller())
          .send(propose('Halal spices'))
          .expect(422);
        expect((response.body as Error).code).toBe('category.claim-word');
      });

      it('answers request.throttled as 429 with Retry-After', async () => {
        reservedCount = 21;
        const response = await http()
          .post(`${SELLER_BASE}/category-proposals`)
          .set(seller())
          .send(propose('Spices'))
          .expect(429);
        expect((response.body as Error).code).toBe('request.throttled');
        expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
        expect(store().proposals.size).toBe(0);
      });

      it('answers 404 to cancel with another seller’s proposal, an unknown one and a malformed id', async () => {
        const theirs = await foreignProposal(code, 1);
        const session = seller();
        const cancelOf = (proposalId: string) =>
          http()
            .post(`${SELLER_BASE}/category-proposals/${proposalId}/cancel`)
            .set(session)
            .send({ version: 1 });
        const foreign = await cancelOf(theirs).expect(404);
        const unknown = await cancelOf(MISSING).expect(404);
        const malformed = await cancelOf('not-an-id').expect(404);
        expect(foreign.body).toEqual({ statusCode: 404, code: 'category-proposal.not-found' });
        expect(unknown.body).toEqual(foreign.body);
        expect(malformed.body).toEqual(foreign.body);
        expect(store().proposals.get(theirs)?.view.status).toBe('pending');
      });

      it('answers 404 to cancel with a proposal id that exists only in the other Market', async () => {
        const elsewhere = await foreignProposal(otherCode, 2);
        const response = await http()
          .post(`${SELLER_BASE}/category-proposals/${elsewhere}/cancel`)
          .set(seller())
          .send({ version: 1 })
          .expect(404);
        expect((response.body as Error).code).toBe('category-proposal.not-found');
        expect(shelves.of(otherCode).proposals.get(elsewhere)?.view.status).toBe('pending');
      });

      it('answers 404 to a shelf put for an unknown Offer', async () => {
        const response = await http()
          .put(`${SELLER_BASE}/offers/${id<'Offer'>(0xe9ff)}/shelf`)
          .set(seller())
          .send({ shelfId: null, version: 1 })
          .expect(404);
        expect((response.body as Error).code).toBe('offer.not-found');
      });
    });

    describe('the admin routes', () => {
      it('maps the table of the controller', () => {
        expect(CATEGORY_PROPOSAL_ADMIN_STATUS).toMatchObject({
          'category-proposal.not-found': 404,
          'seller-category.not-found': 404,
          'category.not-found': 404,
          'category-proposal.not-pending': 409,
          'conflict.stale': 409,
        });
      });

      it('lists the waiting queue and approves, rejects and reads a seller’s shelves', async () => {
        const first = await proposeOk('Spices');
        const second = await proposeOk('Nuts');
        const queue = await http().get(`${ADMIN_BASE}/category-proposals`).set(admin()).expect(200);
        expect(queue.headers['cache-control']).toBe('no-store');
        expect(JSON.stringify(queue.body)).toContain(first);
        const shelfId = await approveOk(first);
        const rejected = await http()
          .post(`${ADMIN_BASE}/category-proposals/${second}/reject`)
          .set(admin())
          .send({ version: 1, reasonCode: 'too-narrow' })
          .expect(200);
        expect(rejected.body).toMatchObject({ status: 'rejected' });
        const shelvesOf = await http()
          .get(`${ADMIN_BASE}/sellers/${SELLER}/shelves`)
          .set(admin())
          .expect(200);
        expect(JSON.stringify(shelvesOf.body)).toContain(shelfId);
        const stale = await http()
          .post(`${ADMIN_BASE}/category-proposals/${first}/approve`)
          .set(admin())
          .send({ version: 1 })
          .expect(409);
        expect((stale.body as Error).code).toBe('category-proposal.not-pending');
      });

      it('refuses an unknown reason code as 400', async () => {
        const proposalId = await proposeOk('Spices');
        const response = await http()
          .post(`${ADMIN_BASE}/category-proposals/${proposalId}/reject`)
          .set(admin())
          .send({ version: 1, reasonCode: 'because' })
          .expect(400);
        expect((response.body as Error).code).toBe('validation.failed');
        expect(store().proposals.get(proposalId)?.view.status).toBe('pending');
      });

      it('answers category-proposal.not-allowed as 403 on approval when SEL-26 went off meanwhile', async () => {
        const proposalId = await proposeOk('Spices');
        mayPropose = false;
        const response = await http()
          .post(`${ADMIN_BASE}/category-proposals/${proposalId}/approve`)
          .set(admin())
          .send({ version: 1 })
          .expect(403);
        expect((response.body as Error).code).toBe('category-proposal.not-allowed');
      });

      it('answers a stale version as 409 conflict.stale', async () => {
        const proposalId = await proposeOk('Spices');
        const response = await http()
          .post(`${ADMIN_BASE}/category-proposals/${proposalId}/approve`)
          .set(admin())
          .send({ version: 7 })
          .expect(409);
        expect((response.body as Error).code).toBe('conflict.stale');
      });

      it('answers the same 404 to approve and reject for an unknown, malformed and other-Market proposal', async () => {
        const elsewhere = await foreignProposal(otherCode, 3);
        const session = admin();
        for (const action of ['approve', 'reject'] as const) {
          const send = (proposalId: string) =>
            http()
              .post(`${ADMIN_BASE}/category-proposals/${proposalId}/${action}`)
              .set(session)
              .send(action === 'approve' ? { version: 1 } : { version: 1, reasonCode: 'other' });
          const unknown = await send(MISSING).expect(404);
          expect(unknown.body).toEqual({ statusCode: 404, code: 'category-proposal.not-found' });
          expect((await send('not-an-id').expect(404)).body).toEqual(unknown.body);
          expect((await send(elsewhere).expect(404)).body).toEqual(unknown.body);
        }
        expect(shelves.of(otherCode).proposals.get(elsewhere)?.view.status).toBe('pending');
      });

      it('answers the same 404 to promote and merge for an unknown, malformed and other-Market shelf', async () => {
        const elsewhere = await foreignShelf(otherCode, 4);
        const session = admin();
        const promote = (shelfId: string) =>
          http()
            .post(`${ADMIN_BASE}/shelves/${shelfId}/promote`)
            .set(session)
            .send({ version: 1, slug: 'foreign', treeVersion: 1 });
        const merge = (shelfId: string) =>
          http()
            .post(`${ADMIN_BASE}/shelves/${shelfId}/merge`)
            .set(session)
            .send({ version: 1, categoryId: cat(1) });
        for (const send of [promote, merge]) {
          const unknown = await send(MISSING).expect(404);
          expect(unknown.body).toEqual({ statusCode: 404, code: 'seller-category.not-found' });
          expect((await send('not-an-id').expect(404)).body).toEqual(unknown.body);
          expect((await send(elsewhere).expect(404)).body).toEqual(unknown.body);
        }
        expect(shelves.of(otherCode).shelves.get(elsewhere)?.status).toBe('active');
      });

      it('merges a shelf into a live category and answers 404 category.not-found for a target of the other Market', async () => {
        const shelfId = await approveOk(await proposeOk('Spices'));
        const session = admin();
        const merge = (categoryId: string, version = 1) =>
          http()
            .post(`${ADMIN_BASE}/shelves/${shelfId}/merge`)
            .set(session)
            .send({ version, categoryId });
        // cat(9) is live in the other Market only; cat(77) is live nowhere.
        const foreign = await merge(cat(9)).expect(404);
        expect(foreign.body).toEqual({ statusCode: 404, code: 'category.not-found' });
        expect((await merge(cat(77)).expect(404)).body).toEqual(foreign.body);
        expect((await merge('not-an-id').expect(404)).body).toEqual(foreign.body);
        expect(store().shelves.get(shelfId as Id<'SellerCategory'>)?.status).toBe('active');
        const merged = await merge(cat(1)).expect(200);
        expect(merged.body).toMatchObject({ status: 'merged', mergedIntoId: cat(1) });
        const closed = await merge(cat(1), 2).expect(409);
        expect((closed.body as Error).code).toBe('seller-category.not-active');
      });
    });

    it('lists the seven C9a routes in OpenAPI', async () => {
      const response = await http().get('/docs-json').expect(200);
      const paths = Object.keys((response.body as { paths: Record<string, unknown> }).paths);
      for (const path of [
        '/catalog/seller/category-proposals',
        '/catalog/seller/category-proposals/{proposalId}/cancel',
        '/catalog/seller/offers/{offerId}/shelf',
        '/catalog/admin/category-proposals',
        '/catalog/admin/category-proposals/{proposalId}/approve',
        '/catalog/admin/category-proposals/{proposalId}/reject',
        '/catalog/admin/sellers/{sellerId}/shelves',
        '/catalog/admin/shelves/{shelfId}/promote',
        '/catalog/admin/shelves/{shelfId}/merge',
      ]) {
        expect(paths).toContain(path);
      }
    });
  },
);
