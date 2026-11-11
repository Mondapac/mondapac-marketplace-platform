import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { cleanClaimTextMatcher } from '../../../../../test/support/clean-claim-text-matcher.fake';
import { unavailableClaimTextMatcher } from '../../../../../test/support/unavailable-claim-text-matcher.fake';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { TopicState } from '../../domain/topic';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ClaimTermLocales } from '../ports/claim-term-locales';
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';
import type { TopicListQuery, TopicReader } from '../ports/topic.reader';
import type { TopicConflict, TopicRepository } from '../ports/topic.repository';
import { TopicCreate } from './topic-create.use-case';
import { TopicEdit } from './topic-edit.use-case';
import { TopicGet } from './topic-get.use-case';
import { TopicList } from './topic-list.use-case';

// The topic use cases of package T1 in memory, on both Market fixtures: the required
// default-locale name, claim-word refusal over names, synonyms, intro and slug (and a matcher that
// is down fails closed), terms another topic already uses, slug derivation and uniqueness, the
// version check, archive and restore, and the admin-only rule. The database behaviour is in
// test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-11-07T00:00:00Z');

const FIXTURES = [
  { code: 'AU', locales: { default: 'en', supported: ['en', 'ar'] } },
  { code: 'ZZ', locales: { default: 'zz', supported: ['zz', 'en'] } },
] as const;

describe.each(FIXTURES)('topic use cases in market $code', ({ code, locales }) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const main = locales.default;
  const second = locales.supported.find((l) => l !== main)!;

  const rows = new Map<string, TopicState>();
  let refuseSave: TopicConflict | null = null;
  const keysOf = (state: TopicState) => state.terms.map((t) => `${t.locale}|${t.key}`);
  const topics: TopicRepository = {
    add: (_m, state) => {
      if ([...rows.values()].some((row) => row.slug === state.slug)) {
        return Promise.resolve('topic.slug-taken');
      }
      rows.set(state.id, state);
      return Promise.resolve(null);
    },
    findById: (_m, id) => Promise.resolve(rows.get(id) ?? null),
    slugTaken: (_m, wanted) => Promise.resolve([...rows.values()].some((r) => r.slug === wanted)),
    takenTermKeys: (_m, terms, except) => {
      const used = new Set(
        [...rows.values()].filter((r) => r.id !== except).flatMap((r) => keysOf(r)),
      );
      return Promise.resolve(terms.filter((t) => used.has(`${t.locale}|${t.key}`)));
    },
    save: (_m, state, expectedVersion) => {
      if (rows.get(state.id)?.version !== expectedVersion) {
        throw new StaleAggregateError('topic', state.id);
      }
      if (refuseSave !== null) return Promise.resolve(refuseSave);
      rows.set(state.id, state);
      return Promise.resolve(null);
    },
  };
  let lastQuery: TopicListQuery | null = null;
  const topicReader: TopicReader = {
    briefsOf: () => Promise.resolve([]),
    list: (_m, query) => {
      lastQuery = query;
      return Promise.resolve({
        items: [...rows.values()].filter((r) => query.status === null || r.status === query.status),
        nextAfterId: null,
      });
    },
  };
  const unitOfWork = {
    run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
  } as unknown as UnitOfWork;
  const policy = {
    locales: () => ({ default: main, supported: [...locales.supported] }),
  } as unknown as CatalogMarketPolicy;

  const allCovered: ClaimTermLocales = {
    covered: () => Promise.resolve(ok([...locales.supported])),
  };
  const build = (
    matcher: ClaimTextMatcher = cleanClaimTextMatcher,
    claimLocales: ClaimTermLocales = allCovered,
  ) => ({
    create: new TopicCreate(gate, {
      unitOfWork,
      topics,
      policy,
      matcher,
      claimLocales,
      clock,
      ids,
    }),
    edit: new TopicEdit(gate, { unitOfWork, topics, policy, matcher, claimLocales, clock }),
    get: new TopicGet(gate, { unitOfWork, topics }),
    list: new TopicList(gate, { unitOfWork, topicReader, policy }),
  });

  const contextOf = (population: 'admin' | 'seller'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: population === 'seller' ? ids.next<'Seller'>() : null,
      }),
    );
  const admin = contextOf('admin');

  beforeEach(() => {
    rows.clear();
    refuseSave = null;
    lastQuery = null;
  });

  it('declares permission rules under their own names', () => {
    expect(TopicCreate.access).toEqual({
      name: 'catalog.topic-create',
      rule: { kind: 'permissions', allOf: ['catalog.topic.manage'] },
    });
    expect(TopicEdit.access).toEqual({
      name: 'catalog.topic-edit',
      rule: { kind: 'permissions', allOf: ['catalog.topic.manage'] },
    });
    expect(TopicGet.access).toEqual({
      name: 'catalog.topic-get',
      rule: { kind: 'permissions', allOf: ['catalog.topic.read'] },
    });
    expect(TopicList.access).toEqual({
      name: 'catalog.topic-list',
      rule: { kind: 'permissions', allOf: ['catalog.topic.read'] },
    });
  });

  it('creates an active topic with a slug derived from the default-locale name', async () => {
    const result = await build().create.execute(admin, {
      group: 'cuisine',
      names: { [main]: 'Persian Food', [second]: 'طعام فارسي' },
      synonyms: { [main]: ['Iranian food'] },
      intro: 'Rice, kebab and herbs.',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.topic).toMatchObject({
      slug: 'persian-food',
      group: 'cuisine',
      status: 'active',
      names: { [main]: 'Persian Food', [second]: 'طعام فارسي' },
      synonyms: { [main]: ['Iranian food'] },
      intro: 'Rice, kebab and herbs.',
      createdAt: T0.toString(),
      version: 1,
    });
  });

  it('suffixes a derived slug that is taken and refuses a given slug that is taken', async () => {
    const { create } = build();
    await create.execute(admin, { group: 'use', names: { [main]: 'BBQ' } });

    const again = await create.execute(admin, { group: 'use', names: { [main]: 'BBQ grill' } });
    const derived = await create.execute(admin, {
      group: 'use',
      slug: 'bbq',
      names: { [main]: 'Barbecue' },
    });
    const clash = await create.execute(admin, { group: 'use', names: { [main]: 'B.B.Q.' } });

    expect(again.ok && again.value.topic.slug).toBe('bbq-grill');
    expect(derived).toEqual({ ok: false, error: { code: 'topic.slug-taken' } });
    // "B.B.Q." normalises to "b b q", a new term, and its slug "b-b-q" is free.
    expect(clash.ok && clash.value.topic.slug).toBe('b-b-q');
    const suffixed = await create.execute(admin, {
      group: 'use',
      names: { [main]: 'bbq!' },
    });
    expect(suffixed).toEqual({
      ok: false,
      error: { code: 'topic.term-taken', fields: [{ path: `names.${main}`, code: 'taken' }] },
    });
  });

  it('suffixes the derived slug with a number when the plain one is taken', async () => {
    const { create } = build();
    await create.execute(admin, { group: 'use', slug: 'ramadan', names: { [main]: 'Ramadan' } });

    const second = await create.execute(admin, {
      group: 'occasion',
      names: { [main]: 'Ramadan gifts' },
      slug: undefined,
    });
    const third = await create.execute(admin, {
      group: 'occasion',
      names: { [main]: 'Ramadán' },
    });

    expect(second.ok && second.value.topic.slug).toBe('ramadan-gifts');
    // "Ramadán" is a new term (the accent stays in the key) whose slug "ramadan" is taken.
    expect(third.ok && third.value.topic.slug).toBe('ramadan-2');
  });

  it('refuses a synonym or name another topic already uses, by field', async () => {
    const { create } = build();
    await create.execute(admin, {
      group: 'use',
      names: { [main]: 'BBQ' },
      synonyms: { [main]: ['Barbecue'] },
    });

    const result = await create.execute(admin, {
      group: 'use',
      names: { [main]: 'Grilling' },
      synonyms: { [main]: ['Charcoal', 'barbecue'] },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'topic.term-taken',
        fields: [{ path: `synonyms.${main}.1`, code: 'taken' }],
      },
    });
    expect(rows.size).toBe(1);
  });

  it('refuses a missing group or default-locale name, an unknown key and a bad slug', async () => {
    const { create } = build();

    expect(await create.execute(admin, { names: { [second]: 'Iftar' } })).toEqual({
      ok: false,
      error: {
        code: 'validation.failed',
        fields: [
          { path: 'group', code: 'required' },
          { path: `names.${main}`, code: 'required' },
        ],
      },
    });
    expect(
      await create.execute(admin, { group: 'use', names: { [main]: 'Ab' }, extra: 1 } as never),
    ).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'extra', code: 'unknown' }] },
    });
    expect(
      await create.execute(admin, { group: 'use', names: { [main]: 'Ab' }, slug: 'Bad Slug' }),
    ).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'slug', code: 'format' }] },
    });
  });

  it('refuses claim words in a name, synonym, intro or slug, and fails closed when the matcher is down', async () => {
    const hit = { typeCode: 'halal', span: { fromToken: 0, toToken: 0 } };
    const matcher: ClaimTextMatcher = {
      match: (_c, texts) =>
        Promise.resolve(ok(texts.map((t) => (/halal|organic/i.test(t.text) ? [hit] : [])))),
    };

    const refused = await build(matcher).create.execute(admin, {
      group: 'use',
      names: { [main]: 'Halal BBQ' },
      synonyms: { [main]: ['Grill', 'Organic grill'] },
      intro: 'All organic.',
    });
    const bySlug = await build(matcher).create.execute(admin, {
      group: 'use',
      slug: 'halal-meat',
      names: { [main]: 'Meat' },
    });
    const down = await build(unavailableClaimTextMatcher).create.execute(admin, {
      group: 'use',
      names: { [main]: 'BBQ' },
    });

    expect(refused).toEqual({
      ok: false,
      error: {
        code: 'topic.claim-word',
        fields: [
          { path: 'slug', code: 'claim-word' },
          { path: `names.${main}`, code: 'claim-word' },
          { path: `synonyms.${main}.1`, code: 'claim-word' },
          { path: 'intro', code: 'claim-word' },
        ],
      },
    });
    expect(bySlug).toEqual({
      ok: false,
      error: { code: 'topic.claim-word', fields: [{ path: 'slug', code: 'claim-word' }] },
    });
    expect(down).toEqual({ ok: false, error: { code: 'access.unavailable' } });
    expect(rows.size).toBe(0);
  });

  it('refuses a text in a locale the claim vocabulary does not cover, and checks the saved slug', async () => {
    const onlyMain: ClaimTermLocales = { covered: () => Promise.resolve(ok([main])) };
    const uncovered = await build(cleanClaimTextMatcher, onlyMain).create.execute(admin, {
      group: 'use',
      names: { [main]: 'Grill', [second]: 'Grill two' },
      synonyms: { [second]: ['Grill three'] },
    });
    expect(uncovered).toEqual({
      ok: false,
      error: {
        code: 'topic.locale-uncheckable',
        fields: [
          { path: `names.${second}`, code: 'locale-uncheckable' },
          { path: `synonyms.${second}.0`, code: 'locale-uncheckable' },
        ],
      },
    });
  });

  it('fails closed when the matcher throws, answers in the wrong shape or the vocabulary is down', async () => {
    const throwing: ClaimTextMatcher = { match: () => Promise.reject(new Error('down')) };
    const malformed: ClaimTextMatcher = {
      match: (_c, texts) => Promise.resolve(ok(texts.map(() => 'x' as never))),
    };
    const vocabularyDown: ClaimTermLocales = {
      covered: () => Promise.reject(new Error('down')),
    };
    const input = { group: 'use', names: { [main]: 'Grill' } };

    for (const result of [
      await build(throwing).create.execute(admin, input),
      await build(malformed).create.execute(admin, input),
      await build(cleanClaimTextMatcher, vocabularyDown).create.execute(admin, input),
    ]) {
      expect(result).toEqual({ ok: false, error: { code: 'access.unavailable' } });
    }
    expect(rows.size).toBe(0);
  });

  it('checks the numbered slug it saves when the plain one is taken', async () => {
    const seen: string[] = [];
    const recording: ClaimTextMatcher = {
      match: (_c, texts) => {
        seen.push(...texts.map((t) => t.text));
        return Promise.resolve(ok(texts.map(() => [])));
      },
    };
    await build().create.execute(admin, {
      group: 'occasion',
      slug: 'ramadan',
      names: { [main]: 'Ramadan' },
    });

    const result = await build(recording).create.execute(admin, {
      group: 'occasion',
      names: { [main]: 'Ramadán' },
    });

    expect(result.ok && result.value.topic.slug).toBe('ramadan-2');
    expect(seen[0]).toBe('ramadan 2');
  });

  it('refuses everyone who is not an admin', async () => {
    const { create, edit, get, list } = build();
    const seller = contextOf('seller');

    for (const result of [
      await create.execute(seller, { group: 'use', names: { [main]: 'Ab' } }),
      await edit.execute(seller, {
        topicId: 'x',
        version: 1,
        group: 'use',
        names: { [main]: 'Ab' },
      }),
      await get.execute(seller, { topicId: 'x' }),
      await list.execute(seller, {}),
    ]) {
      expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    }
  });

  describe('edit', () => {
    async function created() {
      const result = await build().create.execute(admin, {
        group: 'occasion',
        names: { [main]: 'Ramadan' },
        synonyms: { [main]: ['Iftar'] },
      });
      if (!result.ok) throw new Error('setup');
      return result.value.topic;
    }

    it('replaces the content, archives, keeps the slug and raises the version', async () => {
      const topic = await created();

      const result = await build().edit.execute(admin, {
        topicId: topic.id,
        version: 1,
        status: 'archived',
        group: 'use',
        names: { [main]: 'Ramadan food', [second]: 'رمضان' },
        synonyms: { [main]: ['Iftar', 'Suhoor'] },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.topic).toMatchObject({
        slug: 'ramadan',
        group: 'use',
        status: 'archived',
        names: { [main]: 'Ramadan food', [second]: 'رمضان' },
        synonyms: { [main]: ['Iftar', 'Suhoor'] },
        intro: null,
        version: 2,
      });
    });

    it('keeps the status when it is left out and restores an archived topic', async () => {
      const topic = await created();
      const edit = build().edit;
      const kept = await edit.execute(admin, {
        topicId: topic.id,
        version: 1,
        group: 'occasion',
        names: { [main]: 'Ramadan' },
      });
      const archived = await edit.execute(admin, {
        topicId: topic.id,
        version: 2,
        status: 'archived',
        group: 'occasion',
        names: { [main]: 'Ramadan' },
      });
      const restored = await edit.execute(admin, {
        topicId: topic.id,
        version: 3,
        status: 'active',
        group: 'occasion',
        names: { [main]: 'Ramadan' },
      });

      expect(kept.ok && kept.value.topic.status).toBe('active');
      expect(kept.ok && kept.value.topic.synonyms).toEqual({});
      expect(archived.ok && archived.value.topic.status).toBe('archived');
      expect(restored.ok && restored.value.topic.status).toBe('active');
    });

    it('lets a topic keep its own terms but not take another topic’s', async () => {
      const topic = await created();
      await build().create.execute(admin, { group: 'use', names: { [main]: 'BBQ' } });

      const own = await build().edit.execute(admin, {
        topicId: topic.id,
        version: 1,
        group: 'occasion',
        names: { [main]: 'RAMADAN' },
        synonyms: { [main]: ['iftar'] },
      });
      const other = await build().edit.execute(admin, {
        topicId: topic.id,
        version: 2,
        group: 'occasion',
        names: { [main]: 'Ramadan' },
        synonyms: { [main]: ['bbq'] },
      });

      expect(own.ok).toBe(true);
      expect(other).toEqual({
        ok: false,
        error: {
          code: 'topic.term-taken',
          fields: [{ path: `synonyms.${main}.0`, code: 'taken' }],
        },
      });
    });

    it('answers conflict.stale for an old version, not-found for an unknown id, and an unknown status', async () => {
      const topic = await created();
      const edit = build().edit;

      expect(
        await edit.execute(admin, {
          topicId: topic.id,
          version: 7,
          group: 'occasion',
          names: { [main]: 'Ramadan' },
        }),
      ).toEqual({ ok: false, error: { code: 'conflict.stale' } });
      expect(
        await edit.execute(admin, {
          topicId: 'not-an-id',
          version: 1,
          group: 'occasion',
          names: { [main]: 'Ramadan' },
        }),
      ).toEqual({ ok: false, error: { code: 'topic.not-found' } });
      expect(
        await edit.execute(admin, {
          topicId: topic.id,
          version: 1,
          status: 'merged',
          group: 'occasion',
          names: { [main]: 'Ramadan' },
        }),
      ).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'status', code: 'unknown' }] },
      });
    });

    it('answers term-taken when the store refuses a term (a race)', async () => {
      const topic = await created();
      refuseSave = 'topic.term-taken';

      const result = await build().edit.execute(admin, {
        topicId: topic.id,
        version: 1,
        group: 'occasion',
        names: { [main]: 'Other' },
      });

      expect(result).toEqual({ ok: false, error: { code: 'topic.term-taken' } });
    });
  });

  it('reads one topic and lists with filters and the form facts', async () => {
    const { create, get, list } = build();
    const a = await create.execute(admin, { group: 'use', names: { [main]: 'BBQ' } });
    if (!a.ok) throw new Error('setup');

    expect(await get.execute(admin, { topicId: a.value.topic.id })).toEqual({
      ok: true,
      value: { topic: a.value.topic },
    });
    expect(await get.execute(admin, { topicId: ids.next<'Topic'>() })).toEqual({
      ok: false,
      error: { code: 'topic.not-found' },
    });
    const all = await list.execute(admin, { group: 'use', search: '  bb  ' });
    expect(all.ok && all.value.items.map((i) => i.slug)).toEqual(['bbq']);
    expect(lastQuery).toEqual({
      status: null,
      group: 'use',
      search: 'bb',
      afterId: null,
      limit: 25,
    });
    expect(await list.execute(admin, { status: 'archived' })).toEqual({
      ok: true,
      value: {
        items: [],
        nextAfterId: null,
        locales: { default: main, supported: [...locales.supported] },
        groups: ['occasion', 'cuisine', 'use'],
        maxSynonyms: 10,
      },
    });
    for (const [input, path, problem] of [
      [{ limit: 0 }, 'limit', 'range'],
      [{ group: 'season' }, 'group', 'unknown'],
      [{ status: 'gone' }, 'status', 'unknown'],
      [{ search: 'x'.repeat(81) }, 'search', 'too-long'],
      [{ afterId: 'x' }, 'afterId', 'format'],
    ] as const) {
      expect(await list.execute(admin, input)).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path, code: problem }] },
      });
    }
  });
});
