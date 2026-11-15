import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { CLAIM_TERM_LOCALES } from '../src/modules/catalog/application/ports/claim-term-locales';
import { CLAIM_TEXT_MATCHER } from '../src/modules/catalog/application/ports/claim-text-matcher';
import { PRODUCT_REPOSITORY } from '../src/modules/catalog/application/ports/product.repository';
import { SELLER_ELIGIBILITY_READER } from '../src/modules/catalog/application/ports/seller-eligibility.reader';
import { TOPIC_READER } from '../src/modules/catalog/application/ports/topic.reader';
import { OWN_CATALOG_READER } from '../src/modules/catalog/application/ports/own-catalog.reader';
import { TOPIC_REPOSITORY } from '../src/modules/catalog/application/ports/topic.repository';
import { TOPIC_SUGGESTION_STORE } from '../src/modules/catalog/application/ports/topic-suggestion.store';
import { type TopicState } from '../src/modules/catalog/domain/topic';
import { TopicSuggestion } from '../src/modules/catalog/domain/topic-suggestion';
import { TOPIC_SUGGESTION_ADMIN_STATUS } from '../src/modules/catalog/presentation/topic-suggestion.controller';
import { OWN_TOPIC_SUGGESTION_STATUS } from '../src/modules/catalog/presentation/own-topic-suggestion.controller';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { claimLocalesOf, halalOnlyMatcher } from './support/catalog-attribute-editor-fakes';
import { MemoryTopicSuggestionStore } from './support/catalog-suggestion-fakes';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The tag-suggestion routes over HTTP (product tags package T5): the real guards, controllers,
// gate and use cases with the real role seed; the stores, the claim matcher, the product reader and
// the eligibility answer as in-memory fakes. Proved in both Market fixtures: a reviewer lists and
// rejects, a role with only the review key cannot approve, approve creates the topic, the CSRF
// token, JSON and closed bodies, a foreign product answers like an unknown one, and the seller's
// list shows only their own suggestions.

const START = Temporal.Instant.from('2026-11-11T00:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const REVIEWER = id<'Account'>(0xd701);
const REVIEW_ONLY = id<'Account'>(0xd702);
const OWNER = id<'Account'>(0xd703);
const REVIEWER_ROLE = id<'Role'>(0xd801);
const REVIEW_ONLY_ROLE = id<'Role'>(0xd802);
const PRODUCT = id<'Product'>(0xda01);
const FOREIGN_PRODUCT = id<'Product'>(0xda02);
const SELLER = id<'Seller'>(0xdb01);
const OTHER_SELLER = id<'Seller'>(0xdb02);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

it('maps each tag-suggestion refusal to its HTTP status', () => {
  expect(TOPIC_SUGGESTION_ADMIN_STATUS).toMatchObject({
    'suggestion.not-found': 404,
    'suggestion.stale': 409,
    'suggestion.not-open': 409,
    'suggestion.topic-invalid': 422,
    'suggestion.reason-invalid': 422,
    'topic.claim-word': 422,
    'topic.term-taken': 409,
    'validation.failed': 400,
  });
  expect(OWN_TOPIC_SUGGESTION_STATUS).toMatchObject({
    'product.not-found': 404,
    'suggestion.already-open': 409,
    'suggestion.topic-exists': 409,
    'suggestion.limit-reached': 422,
    'topic.claim-word': 422,
    'seller.not-eligible': 403,
  });
});

describe('tag suggestions over HTTP (integration)', () => {
  let app: NestExpressApplication;
  const suggestions = new MemoryTopicSuggestionStore();
  const topics = new Map<string, TopicState>();
  const http = () => request(app.getHttpServer());

  const topicRepository = {
    add: (_m: unknown, state: TopicState) => {
      topics.set(state.id, state);
      return Promise.resolve(null);
    },
    findById: (_m: unknown, topicId: string) => Promise.resolve(topics.get(topicId) ?? null),
    slugTaken: (_m: unknown, slug: string) =>
      Promise.resolve([...topics.values()].some((t) => t.slug === slug)),
    takenTermKeys: (_m: unknown, terms: { locale: string; key: string }[]) => {
      const used = new Set(
        [...topics.values()].flatMap((t) => t.terms.map((term) => `${term.locale}|${term.key}`)),
      );
      return Promise.resolve(terms.filter((t) => used.has(`${t.locale}|${t.key}`)));
    },
    save: () => Promise.resolve(null),
  };
  const topicReader = {
    list: () => Promise.reject(new Error('unused')),
    briefsOf: () => Promise.resolve([]),
  };

  async function boot(env: Record<string, string> = {}) {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info', ...env },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(new FixedClock(START))
          .overrideProvider(TOPIC_SUGGESTION_STORE)
          .useValue(suggestions)
          .overrideProvider(TOPIC_REPOSITORY)
          .useValue(topicRepository)
          .overrideProvider(TOPIC_READER)
          .useValue(topicReader)
          .overrideProvider(SELLER_ELIGIBILITY_READER)
          .useValue({ isEligible: () => Promise.resolve(true) })
          .overrideProvider(PRODUCT_REPOSITORY)
          .useValue({
            findById: (_m: unknown, productId: string) =>
              Promise.resolve(
                productId === PRODUCT
                  ? {
                      state: {
                        id: PRODUCT,
                        scope: 'SELLER',
                        ownerSellerId: SELLER,
                        status: 'draft',
                        productCode: 'P1',
                      },
                    }
                  : productId === FOREIGN_PRODUCT
                    ? {
                        state: {
                          id: FOREIGN_PRODUCT,
                          scope: 'SELLER',
                          ownerSellerId: OTHER_SELLER,
                          status: 'draft',
                          productCode: 'P2',
                        },
                      }
                    : null,
              ),
          })
          .overrideProvider(OWN_CATALOG_READER)
          .useValue({ findWorkingCopies: () => Promise.resolve([]) })
          .overrideProvider(CLAIM_TEXT_MATCHER)
          .useValue(halalOnlyMatcher)
          .overrideProvider(CLAIM_TERM_LOCALES)
          .useValue({
            covered: (context: { market: { marketId: string } }) =>
              claimLocalesOf(localesOf(context.market.marketId)).covered(context as never),
          }),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
  const localeOf = (code: string) => (code === 'AU' ? 'en-AU' : 'ja-JP');
  const localesOf = (code: string) => (code === 'AU' ? ['en-AU'] : ['ja-JP', 'en-US']);

  function seedAdmin(
    code: string,
    accountId: Id<'Account'>,
    roleId: Id<'Role'>,
    roleName: string,
    keys: string[],
    n: number,
  ) {
    const marketId = code as AccountState['marketId'];
    fakes.seedRole({
      id: roleId,
      marketId,
      scope: 'platform',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: null,
      name: roleName,
      permissionKeys: keys,
      version: 1,
      createdAt: START,
    });
    fakes.seedAccount({
      id: accountId,
      marketId,
      population: 'admin',
      email: { typed: `a${n}@Example.com`, normalized: `a${n}@example.com` },
      displayName: `Admin ${n}`,
      status: 'active',
      emailVerifiedAt: START,
      existingAccountNoticeAt: null,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    });
    fakes.seedAssignment({
      id: id<'RoleAssignment'>(0xe800 + n),
      marketId,
      accountId,
      roleId,
      assignedByAccountId: null,
      assignedAt: START,
      version: 1,
    });
  }

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'tsug-0002'), {});
    const marketId = code as AccountState['marketId'];
    seedAdmin(
      code,
      REVIEWER,
      REVIEWER_ROLE,
      'Tag reviewer',
      ['catalog.topic-suggestion.review', 'catalog.topic.manage'],
      1,
    );
    seedAdmin(
      code,
      REVIEW_ONLY,
      REVIEW_ONLY_ROLE,
      'Review only',
      ['catalog.topic-suggestion.review'],
      2,
    );
    const ownerRole = [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === 'seller' && r.seedCode === 'seller-owner',
    )!.id;
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
    fakes.seedAccount({
      id: OWNER,
      marketId,
      population: 'seller',
      email: { typed: 'owner@Example.com', normalized: 'owner@example.com' },
      displayName: 'owner',
      status: 'active',
      emailVerifiedAt: START,
      existingAccountNoticeAt: null,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    });
    fakes.seedAssignment({
      id: id<'RoleAssignment'>(0xea01),
      marketId,
      accountId: OWNER,
      roleId: ownerRole,
      assignedByAccountId: null,
      assignedAt: START,
      version: 1,
    });
    fakes.seedMembership({
      id: id<'SellerMembership'>(0xeb01),
      marketId,
      accountId: OWNER,
      sellerId: SELLER,
      state: 'active',
      removedAt: null,
      version: 1,
      createdAt: START,
    });
  }

  function session(
    code: string,
    population: 'admin' | 'seller',
    account: Id<'Account'>,
    n: number,
  ) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf800 + n),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population,
        sellerId: population === 'seller' ? SELLER : null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: START,
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

  function stored(code: string, n: number, sellerId: Id<'Seller'>, label = `Tag ${n} fun`) {
    const built = TopicSuggestion.open({
      id: id<'TopicSuggestion'>(0xdd00 + n),
      marketId: code as AccountState['marketId'],
      sellerId,
      productId: PRODUCT,
      label,
      now: START.add({ seconds: n }),
    });
    if (!built.ok) throw new Error(built.error.code);
    suggestions.rows.set(built.value.state.id, built.value);
    return built.value.state.id;
  }

  const QUEUE = '/catalog/admin/topic-suggestions';
  const OWN = '/catalog/seller/topic-suggestions';

  beforeEach(() => {
    fakes.reset();
    suggestions.reset();
    topics.clear();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('documents the admin routes and the two seller routes in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(document.paths[QUEUE]).toHaveProperty('get');
    for (const action of ['approve', 'map', 'reject']) {
      expect(document.paths[`${QUEUE}/{suggestionId}/${action}`]).toHaveProperty('post');
    }
    expect(document.paths['/catalog/seller/products/{productId}/topic-suggestions']).toHaveProperty(
      'post',
    );
    expect(document.paths[OWN]).toHaveProperty('get');
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('lists the queue for a reviewer, no-store; anonymous is 401', async () => {
      await boot();
      await seeded(code);
      const suggestionId = stored(code, 1, SELLER);
      const listed = await http()
        .get(QUEUE)
        .set(session(code, 'admin', REVIEWER, 1))
        .expect(200);
      expect(listed.headers['cache-control']).toBe('no-store');
      expect(listed.body).toMatchObject({
        requiredLocales: [localeOf(code)],
        items: [{ id: suggestionId, version: 1, label: 'Tag 1 fun', suggestedSlug: 'tag-1-fun' }],
      });
      await http()
        .get(QUEUE)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'admin') })
        .expect(401);
    });

    it('approves: the topic is created; a role with only the review key cannot approve', async () => {
      await boot();
      await seeded(code);
      const suggestionId = stored(code, 1, SELLER);
      const denied = await http()
        .post(`${QUEUE}/${suggestionId}/approve`)
        .set(session(code, 'admin', REVIEW_ONLY, 2))
        .send({ version: 1, group: 'use' })
        .expect(403);
      expect(denied.body).toEqual({ statusCode: 403, code: 'access.denied' });
      expect(topics.size).toBe(0);
      const approved = await http()
        .post(`${QUEUE}/${suggestionId}/approve`)
        .set(session(code, 'admin', REVIEWER, 1))
        .send({ version: 1, group: 'use' })
        .expect(200);
      expect((approved.body as { suggestion: unknown }).suggestion).toMatchObject({
        id: suggestionId,
        status: 'approved',
        version: 2,
      });
      expect([...topics.values()].map((t) => t.slug)).toEqual(['tag-1-fun']);
      const again = await http()
        .post(`${QUEUE}/${suggestionId}/approve`)
        .set(session(code, 'admin', REVIEWER, 1))
        .send({ version: 2, group: 'use' })
        .expect(409);
      expect(again.body).toEqual({ statusCode: 409, code: 'suggestion.not-open' });
    });

    it('refuses a name with a certification word (422) and keeps the suggestion open', async () => {
      await boot();
      await seeded(code);
      const suggestionId = stored(code, 1, SELLER);
      const refused = await http()
        .post(`${QUEUE}/${suggestionId}/approve`)
        .set(session(code, 'admin', REVIEWER, 1))
        .send({ version: 1, group: 'use', name: 'Halal feast' })
        .expect(422);
      expect(refused.body).toMatchObject({ code: 'topic.claim-word' });
      expect(suggestions.rows.get(suggestionId)!.state.status).toBe('open');
    });

    it('rejects with a reason; CSRF, JSON and closed bodies are enforced', async () => {
      await boot();
      await seeded(code);
      const suggestionId = stored(code, 1, SELLER);
      const reviewer = session(code, 'admin', REVIEWER, 1);
      const noCsrf = Object.fromEntries(
        Object.entries(reviewer).filter(([k]) => k !== 'x-csrf-token'),
      );
      await http()
        .post(`${QUEUE}/${suggestionId}/reject`)
        .set(noCsrf)
        .send({ version: 1, reason: 'Too broad.' })
        .expect(403);
      await http()
        .post(`${QUEUE}/${suggestionId}/reject`)
        .set(reviewer)
        .set('content-type', 'text/plain')
        .send('version=1')
        .expect(415);
      await http()
        .post(`${QUEUE}/${suggestionId}/reject`)
        .set(reviewer)
        .send({ version: 1, reason: 'Too broad.', extra: true })
        .expect(400);
      const rejected = await http()
        .post(`${QUEUE}/${suggestionId}/reject`)
        .set(reviewer)
        .send({ version: 1, reason: 'Too broad.' })
        .expect(200);
      expect(rejected.body).toEqual({
        suggestion: { id: suggestionId, status: 'rejected', version: 2, topicId: null },
      });
    });

    it('lets a seller suggest, answers a foreign product like an unknown one, and lists only their own', async () => {
      await boot();
      await seeded(code);
      const owner = session(code, 'seller', OWNER, 3);
      const opened = await http()
        .post(`/catalog/seller/products/${PRODUCT}/topic-suggestions`)
        .set(owner)
        .send({ label: 'Weekend grill' })
        .expect(201);
      expect(opened.body).toMatchObject({ status: 'open', version: 1 });
      const foreign = await http()
        .post(`/catalog/seller/products/${FOREIGN_PRODUCT}/topic-suggestions`)
        .set(owner)
        .send({ label: 'Weekend grill' })
        .expect(404);
      const unknown = await http()
        .post(`/catalog/seller/products/${id<'Product'>(0xdaff)}/topic-suggestions`)
        .set(owner)
        .send({ label: 'Weekend grill' })
        .expect(404);
      expect(foreign.body).toEqual(unknown.body);
      const claim = await http()
        .post(`/catalog/seller/products/${PRODUCT}/topic-suggestions`)
        .set(owner)
        .send({ label: 'Halal feast' })
        .expect(422);
      expect(claim.body).toMatchObject({ code: 'topic.claim-word' });
      const repeat = await http()
        .post(`/catalog/seller/products/${PRODUCT}/topic-suggestions`)
        .set(owner)
        .send({ label: 'weekend GRILL' })
        .expect(409);
      expect(repeat.body).toMatchObject({ code: 'suggestion.already-open' });
      stored(code, 9, OTHER_SELLER, 'Someone else');
      const mine = await http().get(OWN).set(owner).expect(200);
      expect((mine.body as { items: { label: string }[] }).items.map((item) => item.label)).toEqual(
        ['Weekend grill'],
      );
      expect(mine.body).toMatchObject({ openCount: 1, maxOpen: 10 });
      await http()
        .get(OWN)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller') })
        .expect(401);
    });
  });
});
