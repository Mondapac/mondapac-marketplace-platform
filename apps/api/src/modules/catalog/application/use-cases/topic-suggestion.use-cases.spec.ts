import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { cleanClaimTextMatcher } from '../../../../../test/support/clean-claim-text-matcher.fake';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { parseTopicContent, newTopic, type TopicState } from '../../domain/topic';
import type { TopicSuggestion } from '../../domain/topic-suggestion';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ClaimTermLocales } from '../ports/claim-term-locales';
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';
import type { ProductRepository } from '../ports/product.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import type { TopicRepository } from '../ports/topic.repository';
import type { TopicSuggestionStore } from '../ports/topic-suggestion.store';
import { OwnTopicSuggest } from './own-topic-suggest.use-case';
import { TopicSuggestionApprove } from './topic-suggestion-approve.use-case';
import { TopicSuggestionMap } from './topic-suggestion-map.use-case';
import { TopicSuggestionReject } from './topic-suggestion-reject.use-case';

// The tag suggestion use cases of package T5 in memory, on both Market fixtures: a seller's
// suggestion (claim words, a tag the list has, repeats, the open limit, ownership), an admin's
// approve, map and reject (version check, one decision, the topic created or chosen, the claim and
// term checks of an approval), and the access rules. The database behaviour is in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const T0 = Temporal.Instant.from('2026-11-11T00:00:00Z');

const FIXTURES = [
  { code: 'AU', locales: { default: 'en', supported: ['en', 'ar'] } },
  { code: 'ZZ', locales: { default: 'zz', supported: ['zz', 'en'] } },
] as const;

const claimWordMatcher: ClaimTextMatcher = {
  match: (_context, texts) =>
    Promise.resolve(
      ok(
        texts.map(({ text }) =>
          /halal/i.test(text) ? [{ typeCode: 'halal', span: { fromToken: 0, toToken: 1 } }] : [],
        ),
      ),
    ),
};

describe.each(FIXTURES)('tag suggestion use cases in market $code', ({ code, locales }) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const main = locales.default;
  const sellerId = ids.next<'Seller'>();
  const ownProduct = ids.next<'Product'>();
  const foreignProduct = ids.next<'Product'>();

  const topicRows = new Map<string, TopicState>();
  const suggestionRows = new Map<string, TopicSuggestion>();
  const audits: string[] = [];
  let eligible = true;

  const keysOf = (state: TopicState) => state.terms.map((t) => `${t.locale}|${t.key}`);
  const topics: TopicRepository = {
    add: (_m, state) => {
      if ([...topicRows.values()].some((row) => row.slug === state.slug)) {
        return Promise.resolve('topic.slug-taken');
      }
      topicRows.set(state.id, state);
      return Promise.resolve(null);
    },
    findById: (_m, id) => Promise.resolve(topicRows.get(id) ?? null),
    slugTaken: (_m, wanted) =>
      Promise.resolve([...topicRows.values()].some((r) => r.slug === wanted)),
    takenTermKeys: (_m, terms) => {
      const used = new Set([...topicRows.values()].flatMap((r) => keysOf(r)));
      return Promise.resolve(terms.filter((t) => used.has(`${t.locale}|${t.key}`)));
    },
    save: () => Promise.resolve(null),
  };
  const store: TopicSuggestionStore = {
    findById: (_m, id) => Promise.resolve(suggestionRows.get(id) ?? null),
    add: (_m, suggestion) => {
      const { sellerId: owner, labelKey, status } = suggestion.state;
      const repeat = [...suggestionRows.values()].some(
        ({ state }) =>
          state.sellerId === owner &&
          state.labelKey === labelKey &&
          status === 'open' &&
          state.status === 'open',
      );
      if (repeat) return Promise.resolve('suggestion.already-open');
      suggestionRows.set(suggestion.state.id, suggestion);
      return Promise.resolve(null);
    },
    saveDecision: (_m, suggestion) => {
      const stored = suggestionRows.get(suggestion.state.id);
      if (
        stored?.state.status !== 'open' ||
        stored.state.version !== suggestion.state.version - 1
      ) {
        throw new StaleAggregateError('topic-suggestion', suggestion.state.id);
      }
      suggestionRows.set(suggestion.state.id, suggestion);
      return Promise.resolve();
    },
    saveNotice: () => Promise.resolve(),
    openCountOfSeller: (_m, owner) =>
      Promise.resolve(
        [...suggestionRows.values()].filter(
          ({ state }) => state.sellerId === owner && state.status === 'open',
        ).length,
      ),
    listOpen: () => Promise.resolve([]),
    listOfProduct: () => Promise.resolve([]),
    listOfSeller: () => Promise.resolve([]),
    dueNotices: () => Promise.resolve([]),
  };
  const products = {
    findById: (_m: MarketContext, id: Id<'Product'>) =>
      Promise.resolve(
        id === ownProduct
          ? { state: { id, scope: 'SELLER', ownerSellerId: sellerId, status: 'draft' } }
          : id === foreignProduct
            ? {
                state: {
                  id,
                  scope: 'SELLER',
                  ownerSellerId: ids.next<'Seller'>(),
                  status: 'draft',
                },
              }
            : null,
      ),
  } as unknown as ProductRepository;
  const eligibility: SellerEligibilityReader = { isEligible: () => Promise.resolve(eligible) };
  const audit: AuditWriter = {
    record: (_c, entry) => {
      audits.push(entry.action);
      return Promise.resolve();
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

  const build = (matcher: ClaimTextMatcher = cleanClaimTextMatcher) => ({
    suggest: new OwnTopicSuggest(gate, {
      unitOfWork,
      products,
      topics,
      topicSuggestions: store,
      eligibility,
      policy,
      matcher,
      claimLocales: allCovered,
      audit,
      clock,
      ids,
    }),
    approve: new TopicSuggestionApprove(gate, {
      unitOfWork,
      topicSuggestions: store,
      topics,
      audit,
      clock,
      policy,
      matcher,
      claimLocales: allCovered,
      ids,
    }),
    map: new TopicSuggestionMap(gate, {
      unitOfWork,
      topicSuggestions: store,
      topics,
      audit,
      clock,
    }),
    reject: new TopicSuggestionReject(gate, { unitOfWork, topicSuggestions: store, audit, clock }),
  });

  const contextOf = (population: 'admin' | 'seller'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: population === 'seller' ? sellerId : null,
      }),
    );
  const admin = contextOf('admin');
  const seller = contextOf('seller');

  const existingTopic = (name: string, slug: string): TopicState => {
    const content = parseTopicContent(
      { group: 'use', names: { [main]: name } },
      { required: main, supported: [...locales.supported] },
    );
    if (!content.ok) throw new Error('content');
    const state = newTopic({
      id: ids.next<'Topic'>(),
      slug,
      content: content.value,
      createdBy: ids.next<'Account'>(),
      now: T0,
    });
    topicRows.set(state.id, state);
    return state;
  };

  async function openOne(label = 'Weekend grill'): Promise<TopicSuggestion> {
    const done = await build().suggest.execute(seller, { productId: ownProduct, label });
    if (!done.ok) throw new Error(done.error.code);
    return suggestionRows.get(done.value.id)!;
  }

  beforeEach(() => {
    topicRows.clear();
    suggestionRows.clear();
    audits.length = 0;
    eligible = true;
  });

  it('declares the rules: sellers edit, admins review, approval needs the manage key too', () => {
    expect(OwnTopicSuggest.access).toMatchObject({
      name: 'catalog.own-topic-suggest',
      rule: { kind: 'permissions', allOf: ['catalog.own-product.edit'] },
      whenSellerNotApproved: 'deny',
    });
    expect(TopicSuggestionApprove.access.rule).toEqual({
      kind: 'permissions',
      allOf: ['catalog.topic-suggestion.review', 'catalog.topic.manage'],
    });
    expect(TopicSuggestionMap.access.rule).toEqual({
      kind: 'permissions',
      allOf: ['catalog.topic-suggestion.review'],
    });
    expect(TopicSuggestionReject.access.rule).toEqual({
      kind: 'permissions',
      allOf: ['catalog.topic-suggestion.review'],
    });
  });

  describe('a seller suggests a tag', () => {
    it('opens a suggestion, audits ids only, and writes nothing to the product', async () => {
      const done = await build().suggest.execute(seller, {
        productId: ownProduct,
        label: '  Weekend   grill ',
      });
      expect(done).toMatchObject({ ok: true, value: { status: 'open', version: 1 } });
      const stored = [...suggestionRows.values()][0]!;
      expect(stored.state).toMatchObject({
        label: 'Weekend grill',
        sellerId,
        productId: ownProduct,
      });
      expect(audits).toEqual(['catalog.topic-suggestion.suggested']);
    });

    it('refuses a text that asserts a certification, and fails closed when the check is down', async () => {
      const claim = await build(claimWordMatcher).suggest.execute(seller, {
        productId: ownProduct,
        label: 'Halal feast',
      });
      expect(claim).toMatchObject({ ok: false, error: { code: 'topic.claim-word' } });
      const down = await build({
        match: () =>
          Promise.resolve({ ok: false, error: { code: 'claim-text.check-unavailable' } }),
      } as unknown as ClaimTextMatcher).suggest.execute(seller, {
        productId: ownProduct,
        label: 'Weekend grill',
      });
      expect(down).toMatchObject({ ok: false, error: { code: 'access.unavailable' } });
      expect(suggestionRows.size).toBe(0);
    });

    it('refuses a tag the list already has, even in other case', async () => {
      existingTopic('Weekend Grill', 'weekend-grill');
      const done = await build().suggest.execute(seller, {
        productId: ownProduct,
        label: 'weekend grill',
      });
      expect(done).toMatchObject({ ok: false, error: { code: 'suggestion.topic-exists' } });
    });

    it('refuses a repeat of an open suggestion, and more than ten open', async () => {
      await openOne('Weekend grill');
      const again = await build().suggest.execute(seller, {
        productId: ownProduct,
        label: 'WEEKEND grill',
      });
      expect(again).toMatchObject({ ok: false, error: { code: 'suggestion.already-open' } });
      for (let n = 1; n < 10; n += 1) await openOne(`Tag number ${n}`);
      const over = await build().suggest.execute(seller, {
        productId: ownProduct,
        label: 'One too many',
      });
      expect(over).toMatchObject({
        ok: false,
        error: { code: 'suggestion.limit-reached', max: 10 },
      });
    });

    it('answers the same for another seller’s product and an unknown one; refuses bad text', async () => {
      const foreign = await build().suggest.execute(seller, {
        productId: foreignProduct,
        label: 'Weekend grill',
      });
      const unknown = await build().suggest.execute(seller, {
        productId: ids.next<'Product'>(),
        label: 'Weekend grill',
      });
      expect(foreign).toEqual({ ok: false, error: { code: 'product.not-found' } });
      expect(unknown).toEqual(foreign);
      for (const label of ['x', 'x'.repeat(41), '   ']) {
        const bad = await build().suggest.execute(seller, { productId: ownProduct, label });
        expect(bad).toMatchObject({ ok: false, error: { code: 'suggestion.label-invalid' } });
      }
    });

    it('refuses a seller who may not sell, and an admin', async () => {
      eligible = false;
      expect(
        await build().suggest.execute(seller, { productId: ownProduct, label: 'Weekend grill' }),
      ).toEqual({ ok: false, error: { code: 'seller.not-eligible' } });
      eligible = true;
      expect(
        await build().suggest.execute(admin, { productId: ownProduct, label: 'Weekend grill' }),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
    });
  });

  describe('an admin decides', () => {
    it('approves: creates an active topic named as the seller asked, and closes the suggestion', async () => {
      const suggestion = await openOne('Weekend grill');
      const done = await build().approve.execute(admin, {
        suggestionId: suggestion.state.id,
        version: 1,
        group: 'occasion',
      });
      if (!done.ok) throw new Error(done.error.code);
      const topic = topicRows.get(done.value.suggestion.topicId!)!;
      expect(topic).toMatchObject({ slug: 'weekend-grill', group: 'occasion', status: 'active' });
      expect(topic.terms[0]).toMatchObject({ locale: main, kind: 'name', text: 'Weekend grill' });
      expect(done.value.suggestion).toMatchObject({ status: 'approved', version: 2 });
      expect(audits).toContain('catalog.topic-suggestion.decided');
    });

    it('approves under a name and slug the admin gives, and refuses a taken term or slug', async () => {
      existingTopic('Barbecue', 'barbecue');
      const first = await openOne('Weekend grill');
      const taken = await build().approve.execute(admin, {
        suggestionId: first.state.id,
        version: 1,
        group: 'use',
        name: 'barbecue',
      });
      expect(taken).toMatchObject({ ok: false, error: { code: 'topic.term-taken' } });
      const slug = await build().approve.execute(admin, {
        suggestionId: first.state.id,
        version: 1,
        group: 'use',
        slug: 'barbecue',
      });
      expect(slug).toEqual({ ok: false, error: { code: 'topic.slug-taken' } });
      const ok1 = await build().approve.execute(admin, {
        suggestionId: first.state.id,
        version: 1,
        group: 'use',
        name: 'Grill night',
        slug: 'grill-night',
      });
      expect(ok1.ok && topicRows.get(ok1.value.suggestion.topicId!)?.slug).toBe('grill-night');
    });

    it('refuses an approval whose name asserts a certification, and a group that is not one', async () => {
      const suggestion = await openOne('Weekend grill');
      const claim = await build(claimWordMatcher).approve.execute(admin, {
        suggestionId: suggestion.state.id,
        version: 1,
        group: 'use',
        name: 'Halal grill',
      });
      expect(claim).toMatchObject({ ok: false, error: { code: 'topic.claim-word' } });
      const group = await build().approve.execute(admin, {
        suggestionId: suggestion.state.id,
        version: 1,
        group: 'nonsense',
      });
      expect(group).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      expect(topicRows.size).toBe(0);
    });

    it('maps to an active topic, and refuses an unknown or archived one', async () => {
      const suggestion = await openOne('BBQ night');
      const target = existingTopic('Barbecue', 'barbecue');
      const archived = { ...existingTopic('Old', 'old'), status: 'archived' as const };
      topicRows.set(archived.id, archived);
      for (const topicId of [archived.id, ids.next<'Topic'>()]) {
        const refused = await build().map.execute(admin, {
          suggestionId: suggestion.state.id,
          version: 1,
          topicId,
        });
        expect(refused).toEqual({ ok: false, error: { code: 'suggestion.topic-invalid' } });
      }
      const done = await build().map.execute(admin, {
        suggestionId: suggestion.state.id,
        version: 1,
        topicId: target.id,
      });
      expect(done).toMatchObject({
        ok: true,
        value: { suggestion: { status: 'mapped', topicId: target.id } },
      });
    });

    it('rejects with a reason, once, and a stale version is refused', async () => {
      const suggestion = await openOne('Weekend grill');
      const stale = await build().reject.execute(admin, {
        suggestionId: suggestion.state.id,
        version: 7,
        reason: 'No.',
      });
      expect(stale).toEqual({ ok: false, error: { code: 'suggestion.stale' } });
      const empty = await build().reject.execute(admin, {
        suggestionId: suggestion.state.id,
        version: 1,
        reason: ' ',
      });
      expect(empty).toMatchObject({ ok: false, error: { code: 'suggestion.reason-invalid' } });
      const done = await build().reject.execute(admin, {
        suggestionId: suggestion.state.id,
        version: 1,
        reason: ' Too broad. ',
      });
      expect(done).toMatchObject({
        ok: true,
        value: { suggestion: { status: 'rejected', topicId: null } },
      });
      expect(suggestionRows.get(suggestion.state.id)?.state.rejectReason).toBe('Too broad.');
      const second = await build().reject.execute(admin, {
        suggestionId: suggestion.state.id,
        version: 2,
        reason: 'Again.',
      });
      expect(second).toEqual({ ok: false, error: { code: 'suggestion.not-open' } });
    });

    it('answers an unknown suggestion and a seller caller by their own codes', async () => {
      const unknown = await build().reject.execute(admin, {
        suggestionId: ids.next<'TopicSuggestion'>(),
        version: 1,
        reason: 'No.',
      });
      expect(unknown).toEqual({ ok: false, error: { code: 'suggestion.not-found' } });
      const suggestion = await openOne('Weekend grill');
      for (const run of [
        build().approve.execute(seller, {
          suggestionId: suggestion.state.id,
          version: 1,
          group: 'use',
        }),
        build().map.execute(seller, {
          suggestionId: suggestion.state.id,
          version: 1,
          topicId: 'x',
        }),
        build().reject.execute(seller, {
          suggestionId: suggestion.state.id,
          version: 1,
          reason: 'No.',
        }),
      ]) {
        expect(await run).toEqual({ ok: false, error: { code: 'access.denied' } });
      }
    });
  });
});
