import type { NestExpressApplication } from '@nestjs/platform-express';
import { ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { CLAIM_TERM_LOCALES } from '../src/modules/catalog/application/ports/claim-term-locales';
import {
  CLAIM_TEXT_MATCHER,
  type ClaimTextMatcher,
} from '../src/modules/catalog/application/ports/claim-text-matcher';
import {
  TOPIC_READER,
  type TopicReader,
} from '../src/modules/catalog/application/ports/topic.reader';
import {
  TOPIC_REPOSITORY,
  type TopicRepository,
} from '../src/modules/catalog/application/ports/topic.repository';
import type { TopicState } from '../src/modules/catalog/domain/topic';
import { TOPIC_ADMIN_STATUS } from '../src/modules/catalog/presentation/topic-admin.controller';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { StaleAggregateError } from '../src/platform/unit-of-work/errors';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The admin topic routes over HTTP (product tags package T1): the real guards, CSRF, closed
// bodies, controller, the gate with the real role seed and the use cases; the topic store as an
// in-memory fake and a claim matcher that flags "halal". Proved here, in both Market fixtures: the
// key gate (no session, no key, read-only key), CSRF, the write flow with its refusals and their
// status, and the OpenAPI entries.

const START = Temporal.Instant.from('2026-11-07T00:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const MANAGER = id<'Account'>(0xd101);
const READER = id<'Account'>(0xd102);
const MODERATOR = id<'Account'>(0xd103);
const MANAGER_ROLE = id<'Role'>(0xf911);
const READER_ROLE = id<'Role'>(0xf912);

/** The topic store in memory, per Market, with the unique slug and term rules of the tables. */
class MemoryTopics implements TopicRepository, TopicReader {
  readonly rows = new Map<string, TopicState>();
  #key = (market: MarketContext, topicId: string) => `${market.marketId}:${topicId}`;
  #inMarket = (market: MarketContext) =>
    [...this.rows.entries()]
      .filter(([key]) => key.startsWith(`${market.marketId}:`))
      .map(([, row]) => row);
  reset(): void {
    this.rows.clear();
  }
  #termClash(market: MarketContext, state: TopicState): boolean {
    const used = new Set(
      this.#inMarket(market)
        .filter((row) => row.id !== state.id)
        .flatMap((row) => row.terms.map((t) => `${t.locale}|${t.key}`)),
    );
    return state.terms.some((t) => used.has(`${t.locale}|${t.key}`));
  }
  add(market: MarketContext, state: TopicState) {
    if (this.#inMarket(market).some((row) => row.slug === state.slug)) {
      return Promise.resolve('topic.slug-taken' as const);
    }
    if (this.#termClash(market, state)) return Promise.resolve('topic.term-taken' as const);
    this.rows.set(this.#key(market, state.id), state);
    return Promise.resolve(null);
  }
  findById(market: MarketContext, topicId: Id<'Topic'>) {
    return Promise.resolve(this.rows.get(this.#key(market, topicId)) ?? null);
  }
  slugTaken(market: MarketContext, slug: string) {
    return Promise.resolve(this.#inMarket(market).some((row) => row.slug === slug));
  }
  takenTermKeys(
    market: MarketContext,
    terms: readonly { readonly locale: string; readonly key: string }[],
    except: Id<'Topic'> | null,
  ) {
    const used = new Set(
      this.#inMarket(market)
        .filter((row) => row.id !== except)
        .flatMap((row) => row.terms.map((t) => `${t.locale}|${t.key}`)),
    );
    return Promise.resolve(terms.filter((t) => used.has(`${t.locale}|${t.key}`)));
  }
  save(market: MarketContext, state: TopicState, expectedVersion: number) {
    if (this.rows.get(this.#key(market, state.id))?.version !== expectedVersion) {
      throw new StaleAggregateError('topic', state.id);
    }
    if (this.#termClash(market, state)) return Promise.resolve('topic.term-taken' as const);
    this.rows.set(this.#key(market, state.id), state);
    return Promise.resolve(null);
  }
  list(market: MarketContext, query: Parameters<TopicReader['list']>[1]) {
    const items = this.#inMarket(market)
      .filter((row) => query.status === null || row.status === query.status)
      .filter((row) => query.group === null || row.group === query.group)
      .filter(
        (row) =>
          query.search === null ||
          row.terms.some((t) => t.text.toLowerCase().includes(query.search!.toLowerCase())),
      )
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .slice(0, query.limit);
    return Promise.resolve({ items, nextAfterId: null });
  }
}

const halalMatcher: ClaimTextMatcher = {
  match: (_context, texts) =>
    Promise.resolve(
      ok(
        texts.map((t) =>
          /halal/i.test(t.text) ? [{ typeCode: 'halal', span: { fromToken: 0, toToken: 0 } }] : [],
        ),
      ),
    ),
};

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

describe('admin topic routes over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let clock: FixedClock;
  const topics = new MemoryTopics();
  const http = () => request(app.getHttpServer());

  async function boot(env: Record<string, string> = {}) {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info', ...env },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(TOPIC_REPOSITORY)
          .useValue(topics)
          .overrideProvider(TOPIC_READER)
          .useValue(topics)
          .overrideProvider(CLAIM_TEXT_MATCHER)
          .useValue(halalMatcher)
          .overrideProvider(CLAIM_TERM_LOCALES)
          .useValue({ covered: () => Promise.resolve(ok(['en-AU', 'ja-JP', 'en-US'])) }),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'topic-0001'), {});
    const marketId = code as AccountState['marketId'];
    const moderatorRole = [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === 'catalogue-moderator',
    )!.id;
    for (const [roleId, name, keys] of [
      [MANAGER_ROLE, 'Topic manager', ['catalog.topic.read', 'catalog.topic.manage']],
      [READER_ROLE, 'Topic reader', ['catalog.topic.read']],
    ] as const) {
      fakes.seedRole({
        id: roleId,
        marketId,
        scope: 'platform',
        kind: 'custom',
        seedCode: null,
        seedVersion: null,
        sellerId: null,
        name,
        permissionKeys: [...keys],
        version: 1,
        createdAt: START,
      });
    }
    let n = 0;
    for (const [accountId, label, roleId] of [
      [MANAGER, 'manager', MANAGER_ROLE],
      [READER, 'reader', READER_ROLE],
      [MODERATOR, 'moderator', moderatorRole],
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
        id: id<'RoleAssignment'>(0xea80 + n),
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
        id: id<'Session'>(0xfa00 + n),
        marketId: code as AccountState['marketId'],
        accountId: account,
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

  const ADMIN = '/catalog/admin/topics';

  beforeEach(() => {
    fakes.reset();
    topics.reset();
    clock = new FixedClock(START);
  });
  afterEach(async () => {
    await app?.close();
  });

  it('maps the refusals of the topic routes to their status', () => {
    expect(TOPIC_ADMIN_STATUS).toEqual({
      'validation.failed': 400,
      'topic.not-found': 404,
      'topic.slug-taken': 409,
      'topic.term-taken': 409,
      'conflict.stale': 409,
      'topic.claim-word': 422,
      'topic.locale-uncheckable': 422,
      'access.unavailable': 503,
    });
  });

  it('documents the topic routes in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    expect(document.paths[ADMIN]).toHaveProperty('get');
    expect(document.paths[ADMIN]).toHaveProperty('post');
    expect(document.paths[`${ADMIN}/{topicId}`]).toHaveProperty('get');
    expect(document.paths[`${ADMIN}/{topicId}`]).toHaveProperty('put');
    const create = document.paths[ADMIN]?.post?.responses;
    for (const status of ['201', '400', '403', '409', '422']) expect(create).toHaveProperty(status);
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const main = code === 'AU' ? 'en-AU' : 'ja-JP';

    it('answers 401 without a session and 403 to an admin without the key', async () => {
      await boot();
      await seeded(code);
      await http().get(ADMIN).set({ 'x-market-id': code }).expect(401);
      const moderator = adminSession(code, MODERATOR, 1);
      const read = await http().get(ADMIN).set(moderator).expect(403);
      expect(read.body).toMatchObject({ code: 'access.denied' });
      const write = await http()
        .post(ADMIN)
        .set(moderator)
        .send({ group: 'use', names: { [main]: 'BBQ' } })
        .expect(403);
      expect(write.body).toMatchObject({ code: 'access.denied' });
      expect(topics.rows.size).toBe(0);
    });

    it('lets the read key read and refuses its writes; a write needs the CSRF token', async () => {
      await boot();
      await seeded(code);
      const manager = adminSession(code, MANAGER, 2);
      const created = await http()
        .post(ADMIN)
        .set(manager)
        .send({ group: 'use', names: { [main]: 'BBQ' } })
        .expect(201);
      const topicId = (created.body as { topic: { id: string } }).topic.id;

      const reader = adminSession(code, READER, 3);
      const list = await http().get(ADMIN).set(reader).expect(200);
      expect(list.headers['cache-control']).toContain('no-store');
      expect(list.body).toMatchObject({
        items: [{ slug: 'bbq', status: 'active' }],
        groups: ['occasion', 'cuisine', 'use'],
        maxSynonyms: 10,
        locales: { default: main },
      });
      await http().get(`${ADMIN}/${topicId}`).set(reader).expect(200);
      await http()
        .post(ADMIN)
        .set(reader)
        .send({ group: 'use', names: { [main]: 'Grill' } })
        .expect(403);
      await http()
        .put(`${ADMIN}/${topicId}`)
        .set(reader)
        .send({ version: 1, group: 'use', names: { [main]: 'Grill' } })
        .expect(403);

      const withoutCsrf: Record<string, string> = { ...manager };
      delete withoutCsrf['x-csrf-token'];
      await http()
        .post(ADMIN)
        .set(withoutCsrf)
        .send({ group: 'use', names: { [main]: 'No Csrf' } })
        .expect(403);
      expect(topics.rows.size).toBe(1);
    });

    it('creates, refuses claim words, taken terms and a stale version, edits and archives', async () => {
      await boot();
      await seeded(code);
      const manager = adminSession(code, MANAGER, 4);
      const created = await http()
        .post(ADMIN)
        .set(manager)
        .send({
          group: 'occasion',
          names: { [main]: 'Ramadan' },
          synonyms: { [main]: ['Iftar'] },
          intro: 'Dates, sweets and everything for iftar.',
        })
        .expect(201);
      expect(created.body).toMatchObject({
        topic: {
          slug: 'ramadan',
          group: 'occasion',
          status: 'active',
          names: { [main]: 'Ramadan' },
          synonyms: { [main]: ['Iftar'] },
          version: 1,
        },
      });
      const topicId = (created.body as { topic: { id: string } }).topic.id;

      const claim = await http()
        .post(ADMIN)
        .set(manager)
        .send({ group: 'use', names: { [main]: 'Halal meat' } })
        .expect(422);
      expect(claim.body).toEqual({
        statusCode: 422,
        code: 'topic.claim-word',
        details: {
          fields: [
            { path: 'slug', code: 'claim-word' },
            { path: `names.${main}`, code: 'claim-word' },
          ],
        },
      });
      const taken = await http()
        .post(ADMIN)
        .set(manager)
        .send({ group: 'occasion', names: { [main]: 'IFTAR!' } })
        .expect(409);
      expect(taken.body).toMatchObject({
        code: 'topic.term-taken',
        details: { fields: [{ path: `names.${main}`, code: 'taken' }] },
      });
      const slug = await http()
        .post(ADMIN)
        .set(manager)
        .send({ group: 'occasion', slug: 'ramadan', names: { [main]: 'Eid' } })
        .expect(409);
      expect(slug.body).toMatchObject({ code: 'topic.slug-taken' });
      const unknown = await http()
        .post(ADMIN)
        .set(manager)
        .send({ group: 'use', names: { [main]: 'BBQ' }, status: 'active' })
        .expect(400);
      expect(unknown.body).toMatchObject({ code: 'validation.failed' });

      const edited = await http()
        .put(`${ADMIN}/${topicId}`)
        .set(manager)
        .send({
          version: 1,
          status: 'archived',
          group: 'occasion',
          names: { [main]: 'Ramadan' },
          synonyms: { [main]: ['Iftar', 'Suhoor'] },
        })
        .expect(200);
      expect(edited.body).toMatchObject({
        topic: {
          status: 'archived',
          synonyms: { [main]: ['Iftar', 'Suhoor'] },
          intro: null,
          version: 2,
        },
      });
      const stale = await http()
        .put(`${ADMIN}/${topicId}`)
        .set(manager)
        .send({ version: 1, group: 'occasion', names: { [main]: 'Ramadan' } })
        .expect(409);
      expect(stale.body).toMatchObject({ code: 'conflict.stale' });
      await http()
        .put(`${ADMIN}/${id<'Topic'>(0xdead)}`)
        .set(manager)
        .send({ version: 1, group: 'occasion', names: { [main]: 'Ramadan' } })
        .expect(404);
      const archived = await http().get(`${ADMIN}?status=archived`).set(manager).expect(200);
      expect((archived.body as { items: { id: string }[] }).items.map((t) => t.id)).toEqual([
        topicId,
      ]);
      await http().get(`${ADMIN}?group=season`).set(manager).expect(400);
    });
  });
});
