import type {
  AuditEntry,
  CallContext,
  Id,
  MarketContext,
  PendingEvent,
  Result,
} from '@mondapac/shared-kernel';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  MemoryCategoryEditStore,
  MemoryTreeVersion,
} from '../../../../../test/support/catalog-category-editor-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_CATEGORY_TREE_EDIT } from '../../contracts/permissions';
import type { EditableCategory } from '../../domain/category-edit';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type { CategoryWriteDependencies } from '../categories/category-editor';
import type { ClaimTermLocales } from '../ports/claim-term-locales';
import type { ClaimTextMatcher, ClaimTextToMatch } from '../ports/claim-text-matcher';
import type { PlatformCategoryRepository } from '../ports/platform-category.repository';
import { CategoryChangeSlug } from './category-change-slug.use-case';
import { CategoryCreate } from './category-create.use-case';
import { CategoryDiscard } from './category-discard.use-case';
import { CategoryEditDetails } from './category-edit-details.use-case';
import { CategoryHide } from './category-hide.use-case';
import { CategoryReorder } from './category-reorder.use-case';
import { CategoryShow } from './category-show.use-case';

// The tree editor's use cases in memory (categories package C3a), on both Market fixtures: the
// key, the admin population and the acting-as refusal; the closed input; the tree-version guard;
// the depth cap from Market configuration; the claim-word check in every locale, fail closed;
// hide and show with the cascade marker; one audit row and the events per write. The SQL is in
// test/db/catalog-category-editor.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const T0 = Temporal.Instant.from('2026-11-03T10:00:00Z');
const ADMIN = '01990000-0000-7000-8000-0000000000a1';

const cat = (n: number): Id<'Category'> =>
  `01990000-0000-7000-8000-${(0xd00 + n).toString(16).padStart(12, '0')}` as Id<'Category'>;

describe.each(['AU', 'ZZ'] as const)('category editor use cases in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const locales = policy.locales(market);
  const english = locales.default;
  const second = locales.supported.find((locale) => locale !== english) ?? null;
  const maxDepth = policy.maxCategoryDepth(market);

  const context = (population: 'admin' | 'seller' = 'admin'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ADMIN as never,
        sessionId: '01990000-0000-7000-8000-0000000000a2' as never,
        sellerId:
          population === 'seller' ? ('01990000-0000-7000-8000-0000000000a3' as never) : null,
      }),
    );
  const actingAs = (): CallContext => {
    const base = context();
    return { ...base, actor: { ...base.actor, actingAs: { adminAccountId: ADMIN } } as never };
  };

  let store: MemoryCategoryEditStore;
  let tree: MemoryTreeVersion;
  let audits: AuditEntry[];
  let events: PendingEvent[];
  let allow: boolean;
  const coveredAll = (): Result<readonly string[], never> =>
    ok([...new Set([...locales.supported, 'en'])]);
  let covered: Result<readonly string[], { code: 'claim-text.check-unavailable' }>;
  let matcherDown: boolean;
  let claimWords: RegExp;
  let matched: ClaimTextToMatch[];
  let unitOpen: boolean;
  let claimInsideUnit: boolean;

  const check: AuthorisationCheck = {
    check: (_context, declaration) =>
      Promise.resolve(
        allow &&
          declaration.rule.kind === 'permissions' &&
          declaration.rule.allOf.includes(CATALOG_CATEGORY_TREE_EDIT.key)
          ? { allowed: true }
          : { allowed: false, denial: { code: 'access.denied' } },
      ),
  };
  // `err` commits nothing and an exception commits nothing (unit of work P 3.1): the memory
  // stores are put back to what they were when the unit opened.
  const unitOfWork = {
    run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => {
      const saved = {
        rows: new Map(store.rows),
        revisions: store.revisions.length,
        retired: store.retired.length,
        version: tree.version,
        audits: audits.length,
        events: events.length,
      };
      const rollback = (): void => {
        store.rows = saved.rows;
        store.revisions.length = saved.revisions;
        store.retired.length = saved.retired;
        tree.version = saved.version;
        audits.length = saved.audits;
        events.length = saved.events;
      };
      unitOpen = true;
      try {
        const result = await work();
        if (!result.ok) rollback();
        return result;
      } catch (error) {
        rollback();
        throw error;
      } finally {
        unitOpen = false;
      }
    },
  } as unknown as UnitOfWork;
  const matcher: ClaimTextMatcher = {
    match: (_c, texts) => {
      if (unitOpen) claimInsideUnit = true;
      matched.push(...texts);
      if (matcherDown) return Promise.resolve(err({ code: 'claim-text.check-unavailable' }));
      return Promise.resolve(
        ok(
          texts.map((t) =>
            claimWords.test(t.text)
              ? [{ typeCode: 'halal', span: { fromToken: 0, toToken: 0 } }]
              : [],
          ),
        ),
      );
    },
  };
  const claimLocales: ClaimTermLocales = {
    covered: () => {
      if (unitOpen) claimInsideUnit = true;
      return Promise.resolve(covered);
    },
  };
  const audit: AuditWriter = {
    record: (_c, entry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  const outbox = {
    append: (_c: CallContext, batch: readonly PendingEvent[]) => {
      events.push(...batch);
      return Promise.resolve();
    },
  };

  const clock = new FixedClock(T0);
  let ids: SequenceIdGenerator;

  const build = () => {
    const gate = createUseCaseGate(markets, check);
    const deps: CategoryWriteDependencies = {
      unitOfWork,
      store,
      categories: tree as unknown as PlatformCategoryRepository,
      policy,
      matcher,
      claimLocales,
      audit,
      outbox,
      clock,
      ids,
    };
    return {
      create: new CategoryCreate(gate, deps),
      edit: new CategoryEditDetails(gate, deps),
      reorder: new CategoryReorder(gate, deps),
      hide: new CategoryHide(gate, deps),
      show: new CategoryShow(gate, deps),
      slug: new CategoryChangeSlug(gate, deps),
      discard: new CategoryDiscard(gate, deps),
    };
  };

  const text = (name: string, extra: Record<string, unknown> = {}) => ({
    [english]: { name, ...extra },
  });
  const stored = (
    n: number,
    parent: number | null,
    patch: Partial<EditableCategory> = {},
  ): EditableCategory => ({
    id: cat(n),
    parentId: parent === null ? null : cat(parent),
    slug: `c${n}`,
    status: 'active',
    hiddenById: null,
    position: n,
    version: 1,
    revisionNo: 1,
    createdByKind: 'admin',
    showInMenu: true,
    imageId: null,
    seo: { title: null, description: null, noindex: false },
    texts: [{ locale: english, name: `Category ${n}`, shortDescription: null, keywords: [] }],
    ...patch,
  });

  beforeEach(() => {
    store = new MemoryCategoryEditStore();
    tree = new MemoryTreeVersion();
    ids = new SequenceIdGenerator(clock);
    audits = [];
    events = [];
    allow = true;
    covered = coveredAll();
    matcherDown = false;
    claimWords = /halal/i;
    matched = [];
    unitOpen = false;
    claimInsideUnit = false;
  });

  describe('access', () => {
    const body = () => ({ slug: 'rice', texts: text('Rice'), treeVersion: 1 });
    it('refuses a caller without the key', async () => {
      allow = false;
      expect(await build().create.execute(context(), body())).toEqual(
        err({ code: 'access.denied' }),
      );
      expect(store.rows.size).toBe(0);
    });
    it('refuses a seller session and an acting-as session', async () => {
      expect(await build().create.execute(context('seller'), body())).toEqual(
        err({ code: 'access.denied' }),
      );
      expect(await build().create.execute(actingAs(), body())).toEqual(
        err({ code: 'access.denied' }),
      );
      expect(store.rows.size).toBe(0);
    });
    it('declares the same permission rule on all seven write use cases', () => {
      const expected = { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_EDIT.key] };
      const names = new Map<unknown, string>([
        [CategoryCreate, 'catalog.category-create'],
        [CategoryEditDetails, 'catalog.category-edit-details'],
        [CategoryReorder, 'catalog.category-reorder'],
        [CategoryHide, 'catalog.category-hide'],
        [CategoryShow, 'catalog.category-show'],
        [CategoryChangeSlug, 'catalog.category-change-slug'],
        [CategoryDiscard, 'catalog.category-discard'],
      ]);
      expect(names.size).toBe(7);
      for (const [useCase, name] of names) {
        const { access } = useCase as { access: { name: string; rule: unknown } };
        expect(access.name).toBe(name);
        expect(access.rule).toEqual(expected);
      }
    });
    it('refuses an unknown key in the input', async () => {
      const answer = await build().create.execute(context(), { ...body(), status: 'active' });
      expect(answer).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'status', code: 'unknown' }] }),
      );
    });
  });

  describe('create', () => {
    it('adds a hidden category last among its siblings, with a revision, one audit row and two events', async () => {
      store.put(stored(1, null, { position: 3 }));
      const answer = await build().create.execute(context(), {
        slug: 'rice',
        texts: text('Rice', { shortDescription: 'Grains', keywords: ['basmati'] }),
        seo: { title: 'Rice | Mondapac', noindex: false },
        treeVersion: 1,
      });
      expect(answer.ok).toBe(true);
      if (!answer.ok) return;
      const created = store.rows.get(answer.value.category.id)!;
      expect(created).toMatchObject({
        slug: 'rice',
        status: 'hidden',
        parentId: null,
        position: 4,
        createdByKind: 'admin',
        showInMenu: true,
      });
      expect(created.texts).toEqual([
        { locale: english, name: 'Rice', shortDescription: 'Grains', keywords: ['basmati'] },
      ]);
      expect(answer.value.category).toMatchObject({ status: 'hidden', version: 1, treeVersion: 2 });
      expect(store.revisions).toEqual([
        { categoryId: created.id, kind: 'created', revisionNo: 1, author: ADMIN },
      ]);
      expect(audits.map((a) => [a.action, a.targetId])).toEqual([
        ['catalog.platform-category.created', created.id],
      ]);
      expect(events.map((e) => e.type)).toEqual(['catalog.platform-category-created.v1']);
      expect(tree.version).toBe(2);
      expect(claimInsideUnit).toBe(false);
    });

    it('checks every filled text, keyword, search-result field and the slug', async () => {
      await build().create.execute(context(), {
        slug: 'rice',
        texts: text('Rice', { shortDescription: 'Grains', keywords: ['basmati', 'jasmine'] }),
        seo: { title: 'Rice title', description: 'Rice description' },
        treeVersion: 1,
      });
      expect(matched.map((t) => t.text).sort()).toEqual(
        ['Grains', 'Rice', 'Rice description', 'Rice title', 'basmati', 'jasmine', 'rice'].sort(),
      );
    });

    it('refuses a claim word, naming the paths and never the words, and writes nothing', async () => {
      const answer = await build().create.execute(context(), {
        slug: 'halal-rice',
        texts: text('Halal rice', { keywords: ['halal'] }),
        treeVersion: 1,
      });
      expect(answer).toEqual(
        err({
          code: 'category.claim-word',
          fields: [
            { path: `texts.${english}.name`, code: 'claim-word' },
            { path: `texts.${english}.keywords.0`, code: 'claim-word' },
            { path: 'slug', code: 'claim-word' },
          ],
        }),
      );
      expect(store.rows.size).toBe(0);
      expect(tree.version).toBe(1);
    });

    it('fails closed when the vocabulary does not cover a locale, or cannot be read', async () => {
      if (second !== null) {
        covered = ok([english, 'en']);
        const answer = await build().create.execute(context(), {
          slug: 'rice',
          texts: { ...text('Rice'), [second]: { name: 'Second' } },
          treeVersion: 1,
        });
        expect(answer).toEqual(
          err({
            code: 'category.locale-uncheckable',
            fields: [{ path: `texts.${second}.name`, code: 'locale-uncheckable' }],
          }),
        );
      }
      covered = err({ code: 'claim-text.check-unavailable' });
      expect(
        await build().create.execute(context(), {
          slug: 'rice',
          texts: text('Rice'),
          treeVersion: 1,
        }),
      ).toEqual(err({ code: 'claim-text.check-unavailable' }));
      covered = coveredAll();
      matcherDown = true;
      expect(
        await build().create.execute(context(), {
          slug: 'rice',
          texts: text('Rice'),
          treeVersion: 1,
        }),
      ).toEqual(err({ code: 'claim-text.check-unavailable' }));
      expect(store.rows.size).toBe(0);
    });

    it('reads the depth cap from the Market: 4 in AU, 3 in ZZ', () => {
      expect(maxDepth).toBe(code === 'AU' ? 4 : 3);
    });

    it('requires the default locale name when no text is sent at all', async () => {
      const answer = await build().create.execute(context(), {
        slug: 'rice',
        texts: {},
        treeVersion: 1,
      });
      expect(answer).toEqual(
        err({
          code: 'category.required-locale-missing',
          fields: [{ path: `texts.${english}.name`, code: 'required' }],
        }),
      );
      expect(store.rows.size).toBe(0);
    });

    it('refuses a name in a locale the vocabulary does not cover, in every Market', async () => {
      covered = ok(['en']);
      const answer = await build().create.execute(context(), {
        slug: 'rice',
        texts: text('Rice'),
        treeVersion: 1,
      });
      if (english === 'en') {
        expect(answer.ok).toBe(true);
      } else {
        expect(answer).toEqual(
          err({
            code: 'category.locale-uncheckable',
            fields: [{ path: `texts.${english}.name`, code: 'locale-uncheckable' }],
          }),
        );
      }
    });

    it('checks the search fields and the slug with the English vocabulary, not the default locale', async () => {
      const answer = await build().create.execute(context(), {
        slug: 'rice',
        texts: text('Rice'),
        seo: { title: 'Rice', description: 'Long grain' },
        treeVersion: 1,
      });
      expect(answer.ok).toBe(true);
      expect(matched.filter((m) => m.text === 'Rice' || m.text === 'Long grain')).toEqual(
        expect.arrayContaining([
          { locale: 'en', text: 'Rice' },
          { locale: 'en', text: 'Long grain' },
        ]),
      );
      expect(matched.find((m) => m.text === 'rice')).toEqual({ locale: 'en', text: 'rice' });
    });

    it('keeps the search fields in the Latin script, so Japanese or Persian cannot slip past the English check', async () => {
      for (const title of ['お米', 'برنج', 'Рис']) {
        const answer = await build().create.execute(context(), {
          slug: 'rice',
          texts: text('Rice'),
          seo: { title },
          treeVersion: 1,
        });
        expect(answer).toEqual(
          err({ code: 'validation.failed', fields: [{ path: 'seo.title', code: 'english-only' }] }),
        );
      }
      expect(store.rows.size).toBe(0);
    });

    it('requires the default locale name', async () => {
      if (second === null) return;
      const answer = await build().create.execute(context(), {
        slug: 'rice',
        texts: { [second]: { name: 'Second' } },
        treeVersion: 1,
      });
      expect(answer).toEqual(
        err({
          code: 'category.required-locale-missing',
          fields: [{ path: `texts.${english}.name`, code: 'required' }],
        }),
      );
    });

    it('refuses a stale tree version before anything is written', async () => {
      tree.version = 5;
      expect(
        await build().create.execute(context(), {
          slug: 'rice',
          texts: text('Rice'),
          treeVersion: 4,
        }),
      ).toEqual(err({ code: 'conflict.stale' }));
      expect(store.rows.size).toBe(0);
      expect(tree.version).toBe(5);
    });

    it('refuses a taken slug, a slug held after a change, and a sibling with the same name', async () => {
      store.put(
        stored(1, null, {
          slug: 'rice',
          texts: [{ locale: english, name: 'Rice', shortDescription: null, keywords: [] }],
        }),
      );
      const input = (slug: string, name: string) => ({
        slug,
        texts: text(name),
        treeVersion: tree.version,
      });
      expect(await build().create.execute(context(), input('rice', 'Other'))).toEqual(
        err({ code: 'category.slug-taken' }),
      );
      store.heldSlugs.add('old-rice');
      expect(await build().create.execute(context(), input('old-rice', 'Other'))).toEqual(
        err({ code: 'category.slug-taken' }),
      );
      expect(await build().create.execute(context(), input('rice-2', 'rice'))).toEqual(
        err({
          code: 'category.sibling-name-taken',
          fields: [{ path: `texts.${english}.name`, code: 'sibling-name-taken' }],
        }),
      );
    });

    it('stops at the Market depth cap and accepts a parent one level above it', async () => {
      const chain = Array.from({ length: maxDepth }, (_, i) => stored(i + 1, i === 0 ? null : i));
      chain.forEach((entry) => store.put(entry));
      const underDeepest = await build().create.execute(context(), {
        parentId: cat(maxDepth),
        slug: 'too-deep',
        texts: text('Too deep'),
        treeVersion: tree.version,
      });
      expect(underDeepest).toEqual(err({ code: 'category.depth-exceeded', max: maxDepth }));
      const underPenultimate = await build().create.execute(context(), {
        parentId: cat(maxDepth - 1),
        slug: 'fits',
        texts: text('Fits'),
        treeVersion: tree.version,
      });
      expect(underPenultimate.ok).toBe(true);
    });

    it('refuses an unknown, malformed or archived parent', async () => {
      store.put(stored(2, null, { status: 'archived' }));
      for (const parentId of [cat(9), 'nope', cat(2)]) {
        expect(
          await build().create.execute(context(), {
            parentId,
            slug: 'rice',
            texts: text('Rice'),
            treeVersion: tree.version,
          }),
        ).toEqual(err({ code: 'category.parent-not-found' }));
      }
    });

    it('refuses a malformed slug', async () => {
      expect(
        await build().create.execute(context(), {
          slug: 'Rice!',
          texts: text('Rice'),
          treeVersion: 1,
        }),
      ).toEqual(err({ code: 'validation.failed', fields: [{ path: 'slug', code: 'format' }] }));
    });
  });

  describe('edit details', () => {
    const edit = (
      version: number,
      texts: Record<string, unknown>,
      rest: Record<string, unknown> = {},
    ) => build().edit.execute(context(), { categoryId: cat(1), version, texts, ...rest });

    it('replaces the content as a new revision, checks it, audits and announces', async () => {
      store.put(stored(1, null));
      const answer = await edit(1, text('Pantry', { shortDescription: 'Dry goods' }), {
        seo: { title: 'Pantry | Mondapac', noindex: true },
        showInMenu: false,
      });
      expect(answer).toEqual(
        ok({
          category: {
            id: cat(1),
            slug: 'c1',
            status: 'active',
            version: 2,
            revisionNo: 2,
            treeVersion: 1,
          },
        }),
      );
      expect(store.rows.get(cat(1))).toMatchObject({
        showInMenu: false,
        seo: { title: 'Pantry | Mondapac', description: null, noindex: true },
      });
      expect(store.revisions.map((r) => r.kind)).toEqual(['details-changed']);
      expect(audits.map((a) => a.action)).toEqual(['catalog.platform-category.details-changed']);
      expect(events.map((e) => e.type)).toEqual(['catalog.platform-category-changed.v1']);
      expect(tree.version).toBe(1);
      expect(claimInsideUnit).toBe(false);
    });

    it('writes nothing when nothing changed', async () => {
      store.put(
        stored(1, null, {
          texts: [{ locale: english, name: 'Pantry', shortDescription: null, keywords: [] }],
        }),
      );
      const answer = await edit(1, text('Pantry'));
      expect(answer.ok && answer.value.category).toMatchObject({ version: 1, revisionNo: 1 });
      expect(store.revisions).toEqual([]);
      expect(audits).toEqual([]);
      expect(events).toEqual([]);
    });

    it('refuses an older version', async () => {
      store.put(stored(1, null, { version: 3 }));
      expect(await edit(2, text('Pantry'))).toEqual(err({ code: 'conflict.stale' }));
      expect(store.revisions).toEqual([]);
    });

    it('turns a lost race on the version into conflict.stale', async () => {
      store.put(stored(1, null));
      const original = store.apply.bind(store);
      store.apply = (m, change) => {
        store.rows.set(cat(1), { ...store.rows.get(cat(1))!, version: 2 });
        return original(m, change);
      };
      expect(await edit(1, text('Pantry'))).toEqual(err({ code: 'conflict.stale' }));
    });

    it('refuses a claim word, an image id, a merged category and a sibling name clash', async () => {
      store.put(stored(1, null));
      store.put(
        stored(2, null, {
          texts: [{ locale: english, name: 'Spices', shortDescription: null, keywords: [] }],
        }),
      );
      store.put(stored(3, null, { status: 'merged' }));
      expect((await edit(1, text('Halal pantry'))).ok).toBe(false);
      expect(await edit(1, text('Pantry'), { imageId: cat(9) })).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'imageId', code: 'unsupported' }] }),
      );
      expect(await edit(1, text('spices'))).toEqual(
        err({
          code: 'category.sibling-name-taken',
          fields: [{ path: `texts.${english}.name`, code: 'sibling-name-taken' }],
        }),
      );
      expect(
        await build().edit.execute(context(), { categoryId: cat(3), version: 1, texts: text('X') }),
      ).toEqual(err({ code: 'category.not-editable' }));
      expect(
        await build().edit.execute(context(), { categoryId: cat(9), version: 1, texts: text('X') }),
      ).toEqual(err({ code: 'category.not-found' }));
      expect(store.revisions).toEqual([]);
    });
  });

  describe('reorder', () => {
    it('swaps with the neighbour, gives both a revision and raises the tree version', async () => {
      store.put(stored(1, null, { position: 0 }));
      store.put(stored(2, null, { position: 1 }));
      const answer = await build().reorder.execute(context(), {
        categoryId: cat(2),
        direction: 'up',
        treeVersion: 1,
      });
      expect(answer.ok).toBe(true);
      expect(store.rows.get(cat(2))!.position).toBe(0);
      expect(store.rows.get(cat(1))!.position).toBe(1);
      expect(store.revisions.map((r) => [r.categoryId, r.kind])).toEqual([
        [cat(2), 'reordered'],
        [cat(1), 'reordered'],
      ]);
      expect(events).toHaveLength(2);
      expect(audits.map((a) => a.action)).toEqual(['catalog.platform-category.reordered']);
      expect(tree.version).toBe(2);
    });

    it('refuses at the edge, with a bad direction, and on a stale tree', async () => {
      store.put(stored(1, null, { position: 0 }));
      expect(
        await build().reorder.execute(context(), {
          categoryId: cat(1),
          direction: 'up',
          treeVersion: 1,
        }),
      ).toEqual(err({ code: 'category.reorder-edge' }));
      expect(
        await build().reorder.execute(context(), {
          categoryId: cat(1),
          direction: 'left',
          treeVersion: 1,
        }),
      ).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'direction', code: 'unknown' }] }),
      );
      expect(
        await build().reorder.execute(context(), {
          categoryId: cat(1),
          direction: 'up',
          treeVersion: 9,
        }),
      ).toEqual(err({ code: 'conflict.stale' }));
    });
  });

  describe('hide and show', () => {
    // 1 > 2 > 3; 1 > 4 (hidden on its own)
    const seed = () => {
      store.put(stored(1, null));
      store.put(stored(2, 1));
      store.put(stored(3, 2));
      store.put(stored(4, 1, { status: 'hidden' }));
    };

    it('hides the subtree, marks the cascade, audits once and announces each node', async () => {
      seed();
      const answer = await build().hide.execute(context(), { categoryId: cat(1), treeVersion: 1 });
      expect(answer.ok && answer.value.category).toMatchObject({
        status: 'hidden',
        treeVersion: 2,
      });
      expect(
        [1, 2, 3, 4].map((n) => [
          store.rows.get(cat(n))!.status,
          store.rows.get(cat(n))!.hiddenById,
        ]),
      ).toEqual([
        ['hidden', null],
        ['hidden', cat(1)],
        ['hidden', cat(1)],
        ['hidden', null],
      ]);
      expect(store.revisions.map((r) => r.kind)).toEqual(['hidden', 'hidden', 'hidden']);
      expect(events).toHaveLength(3);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: 'catalog.platform-category.hidden',
        after: { cascaded: 2 },
      });
    });

    it('shows only what this Hide hid', async () => {
      seed();
      await build().hide.execute(context(), { categoryId: cat(1), treeVersion: 1 });
      const answer = await build().show.execute(context(), { categoryId: cat(1), treeVersion: 2 });
      expect(answer.ok && answer.value.category).toMatchObject({
        status: 'active',
        treeVersion: 3,
      });
      expect([1, 2, 3, 4].map((n) => store.rows.get(cat(n))!.status)).toEqual([
        'active',
        'active',
        'active',
        'hidden',
      ]);
      expect(store.rows.get(cat(2))!.hiddenById).toBeNull();
      expect(audits[1]).toMatchObject({
        action: 'catalog.platform-category.shown',
        after: { restored: 2 },
      });
    });

    it('cannot show a child under a hidden parent, or a node a parent hid', async () => {
      seed();
      await build().hide.execute(context(), { categoryId: cat(1), treeVersion: 1 });
      expect(await build().show.execute(context(), { categoryId: cat(2), treeVersion: 2 })).toEqual(
        err({ code: 'category.parent-hidden' }),
      );
      expect(await build().show.execute(context(), { categoryId: cat(4), treeVersion: 2 })).toEqual(
        err({ code: 'category.parent-hidden' }),
      );
    });

    it('cannot hide twice or show an active category, and refuses a stale tree', async () => {
      seed();
      expect(await build().hide.execute(context(), { categoryId: cat(4), treeVersion: 1 })).toEqual(
        err({ code: 'category.already-hidden' }),
      );
      expect(await build().show.execute(context(), { categoryId: cat(2), treeVersion: 1 })).toEqual(
        err({ code: 'category.not-hidden' }),
      );
      expect(await build().hide.execute(context(), { categoryId: cat(2), treeVersion: 7 })).toEqual(
        err({ code: 'conflict.stale' }),
      );
    });

    it('rolls the version guard: the second of two admins with the same tree version is stale', async () => {
      seed();
      const first = await build().hide.execute(context(), { categoryId: cat(2), treeVersion: 1 });
      const second = await build().hide.execute(context(), { categoryId: cat(1), treeVersion: 1 });
      expect(first.ok).toBe(true);
      expect(second).toEqual(err({ code: 'conflict.stale' }));
    });

    it('refuses to show a category without a name in a required locale', async () => {
      store.put(stored(1, null, { status: 'hidden', texts: [] }));
      expect(await build().show.execute(context(), { categoryId: cat(1), treeVersion: 1 })).toEqual(
        err({
          code: 'category.required-locale-missing',
          fields: [{ path: `texts.${english}.name`, code: 'required' }],
        }),
      );
    });
  });

  describe('change URL name', () => {
    it('retires the old slug, sets the new one, checks it, audits and announces', async () => {
      store.put(stored(1, null, { slug: 'old-name' }));
      const answer = await build().slug.execute(context(), {
        categoryId: cat(1),
        slug: 'new-name',
        treeVersion: 1,
      });
      expect(answer.ok && answer.value.category).toMatchObject({ slug: 'new-name', revisionNo: 2 });
      expect(store.retired).toEqual([{ id: cat(1), slug: 'old-name' }]);
      expect(store.rows.get(cat(1))!.slug).toBe('new-name');
      expect(store.revisions.map((r) => r.kind)).toEqual(['slug-changed']);
      expect(matched.map((t) => t.text)).toEqual(['new-name']);
      expect(claimInsideUnit).toBe(false);
      expect(audits.map((a) => a.action)).toEqual(['catalog.platform-category.slug-changed']);
    });

    it('refuses the same slug, a taken slug, a held slug, a claim word and a bad format', async () => {
      store.put(stored(1, null, { slug: 'old-name' }));
      store.put(stored(2, null, { slug: 'taken' }));
      store.heldSlugs.add('held');
      const run = (slug: string) =>
        build().slug.execute(context(), { categoryId: cat(1), slug, treeVersion: 1 });
      expect(await run('old-name')).toEqual(err({ code: 'category.slug-unchanged' }));
      expect(await run('taken')).toEqual(err({ code: 'category.slug-taken' }));
      expect(await run('held')).toEqual(err({ code: 'category.slug-taken' }));
      expect(await run('halal-pantry')).toEqual(
        err({ code: 'category.claim-word', fields: [{ path: 'slug', code: 'claim-word' }] }),
      );
      expect(await run('Bad Slug')).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'slug', code: 'format' }] }),
      );
      expect(store.retired).toEqual([]);
    });
  });

  describe('discard', () => {
    it('archives a hidden category that never went live, with a discarded revision', async () => {
      store.put(stored(1, null, { status: 'hidden' }));
      const answer = await build().discard.execute(context(), {
        categoryId: cat(1),
        treeVersion: 1,
      });
      expect(answer.ok && answer.value.category).toMatchObject({ status: 'archived' });
      expect(store.revisions.map((r) => r.kind)).toEqual(['discarded']);
      expect(audits.map((a) => a.action)).toEqual(['catalog.platform-category.discarded']);
    });

    it('refuses one that was shown, one a product revision named, one with a child and an active one', async () => {
      store.put(stored(1, null, { status: 'hidden' }));
      store.put(stored(2, null, { status: 'hidden' }));
      store.put(stored(3, 2, { status: 'hidden' }));
      store.put(stored(4, null));
      store.facts.set(cat(1), { everShown: true, productRevisions: 0 });
      const run = (n: number) =>
        build().discard.execute(context(), { categoryId: cat(n), treeVersion: tree.version });
      for (const n of [1, 2, 4])
        expect(await run(n)).toEqual(err({ code: 'category.not-discardable' }));
      store.facts.set(cat(3), { everShown: false, productRevisions: 2 });
      expect(await run(3)).toEqual(err({ code: 'category.not-discardable' }));
      expect(tree.version).toBe(1);
    });
  });
});
