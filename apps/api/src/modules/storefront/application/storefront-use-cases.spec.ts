import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { AccessDeclaration } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import {
  STOREFRONT_NAVIGATION_APPROVE,
  STOREFRONT_NAVIGATION_EDIT,
  STOREFRONT_PAGE_ARCHIVE,
  STOREFRONT_PAGE_CREATE,
  STOREFRONT_PAGE_EDIT,
  STOREFRONT_PAGE_PUBLISH,
  STOREFRONT_PAGE_READ,
} from '../contracts/permissions';
import { STOREFRONT_AUDIT_ACTIONS } from '../domain/audit';
import type { PageDetailView } from './page-flow';
import type { PageRecord, PageRepository, Stamp, VersionRecord } from './ports/page.repository';
import type { StorefrontDependencies } from './storefront-dependencies';
import { AddStorefrontModule } from './use-cases/add-module.use-case';
import { ApproveStorefrontNavigation } from './use-cases/approve-navigation.use-case';
import { ArchiveStorefrontPage } from './use-cases/archive-page.use-case';
import { CreateStorefrontPage } from './use-cases/create-page.use-case';
import { ListStorefrontPages } from './use-cases/list-pages.use-case';
import { PublishStorefrontPage } from './use-cases/publish-page.use-case';
import { RemoveStorefrontModule } from './use-cases/remove-module.use-case';
import { ReorderStorefrontModules } from './use-cases/reorder-modules.use-case';
import { ReplaceStorefrontNavigationDraft } from './use-cases/replace-navigation-draft.use-case';
import { RestoreStorefrontPageVersion } from './use-cases/restore-page-version.use-case';
import { UpdateStorefrontModule } from './use-cases/update-module.use-case';
import { UpdateStorefrontPageSettings } from './use-cases/update-page-settings.use-case';
import { ViewStorefrontCatalogue } from './use-cases/view-catalogue.use-case';
import { ViewStorefrontNavigation } from './use-cases/view-navigation.use-case';
import { ViewStorefrontPage } from './use-cases/view-page.use-case';
import { ViewPublishedLandingPage } from './use-cases/view-published-landing-page.use-case';
import { ViewPublishedStorefrontNavigation } from './use-cases/view-published-navigation.use-case';
import { ViewPublishedStorefrontPage } from './use-cases/view-published-page.use-case';

// The storefront use cases in memory on both Market fixtures, behind a gate that grants each
// actor only its own keys: a content editor (read, edit, create, navigation edit) drafts pages
// and the navigation; only the platform admin's protected keys publish, archive and approve.
// Buyers with no session read only what was published or approved.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-17T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const EDITOR = id<'Account'>(0xed);
const ADMIN = id<'Account'>(0xad);
const ACTIONS = new Set<string>(STOREFRONT_AUDIT_ACTIONS.map((a) => a.action));
const EDITOR_KEYS = [
  STOREFRONT_PAGE_READ.key,
  STOREFRONT_PAGE_EDIT.key,
  STOREFRONT_PAGE_CREATE.key,
  STOREFRONT_NAVIGATION_EDIT.key,
];
const ADMIN_KEYS = [
  ...EDITOR_KEYS,
  STOREFRONT_PAGE_PUBLISH.key,
  STOREFRONT_PAGE_ARCHIVE.key,
  STOREFRONT_NAVIGATION_APPROVE.key,
];

class RecordingAudit implements AuditWriter {
  readonly entries: AuditEntry[] = [];
  record(_context: CallContext, entry: AuditEntry): Promise<void> {
    if (!ACTIONS.has(entry.action)) throw new Error(`audit: unknown action ${entry.action}`);
    this.entries.push(entry);
    return Promise.resolve();
  }
}

/** Like the tables: unique system keys, slugs and old slugs; one draft and one published version. */
class MemoryPages implements PageRepository {
  readonly pages = new Map<string, PageRecord>();
  readonly versionRows = new Map<string, VersionRecord>();
  readonly redirects = new Map<string, Id<'StorefrontPage'>>();
  readonly locked: string[] = [];

  listPages() {
    return Promise.resolve([...this.pages.values()].reverse());
  }
  summaries() {
    const pageIds = new Set([...this.versionRows.values()].map((v) => v.pageId));
    return Promise.resolve(
      [...pageIds].map((pageId) => {
        const of = [...this.versionRows.values()].filter((v) => v.pageId === pageId);
        const draft = of.find((v) => v.state === 'draft');
        const published = of.find((v) => v.state === 'published');
        return {
          pageId,
          draftVersionNo: draft?.versionNo ?? null,
          publishedVersionNo: published?.versionNo ?? null,
          publishedAt: published?.publishedAt ?? null,
        };
      }),
    );
  }
  findPage(_m: MarketContext, pageId: Id<'StorefrontPage'>) {
    return Promise.resolve(this.pages.get(pageId) ?? null);
  }
  findSystemPage(_m: MarketContext, key: string) {
    return Promise.resolve([...this.pages.values()].find((p) => p.systemKey === key) ?? null);
  }
  findBySlug(_m: MarketContext, slug: string) {
    return Promise.resolve([...this.pages.values()].find((p) => p.slug === slug) ?? null);
  }
  lockPage(m: MarketContext, pageId: Id<'StorefrontPage'>) {
    this.locked.push(pageId);
    return this.findPage(m, pageId);
  }
  insertPage(_m: MarketContext, page: PageRecord) {
    if (page.slug !== null && [...this.pages.values()].some((p) => p.slug === page.slug)) {
      throw new Error('unique slug');
    }
    if (
      page.systemKey !== null &&
      [...this.pages.values()].some((p) => p.systemKey === page.systemKey)
    ) {
      throw new Error('unique key');
    }
    this.pages.set(page.id, page);
    return Promise.resolve();
  }
  insertSystemPageIfAbsent(m: MarketContext, page: PageRecord) {
    if ([...this.pages.values()].some((p) => p.systemKey === page.systemKey)) {
      return Promise.resolve(false);
    }
    return this.insertPage(m, page).then(() => true);
  }
  updatePage(
    _m: MarketContext,
    pageId: Id<'StorefrontPage'>,
    change: Parameters<PageRepository['updatePage']>[2],
    stamp: Stamp,
  ) {
    this.pages.set(pageId, { ...this.pages.get(pageId)!, ...change, updatedAt: stamp.at });
    return Promise.resolve();
  }
  versions(_m: MarketContext, pageId: Id<'StorefrontPage'>) {
    return Promise.resolve(
      [...this.versionRows.values()]
        .filter((v) => v.pageId === pageId)
        .sort((a, b) => b.versionNo - a.versionNo),
    );
  }
  findVersion(
    _m: MarketContext,
    pageId: Id<'StorefrontPage'>,
    versionId: Id<'StorefrontPageVersion'>,
  ) {
    const row = this.versionRows.get(versionId);
    return Promise.resolve(row !== undefined && row.pageId === pageId ? row : null);
  }
  findDraft(_m: MarketContext, pageId: Id<'StorefrontPage'>) {
    return Promise.resolve(
      [...this.versionRows.values()].find((v) => v.pageId === pageId && v.state === 'draft') ??
        null,
    );
  }
  findPublished(_m: MarketContext, pageId: Id<'StorefrontPage'>) {
    return Promise.resolve(
      [...this.versionRows.values()].find((v) => v.pageId === pageId && v.state === 'published') ??
        null,
    );
  }
  lastVersionNo(_m: MarketContext, pageId: Id<'StorefrontPage'>) {
    return Promise.resolve(
      Math.max(
        0,
        ...[...this.versionRows.values()]
          .filter((v) => v.pageId === pageId)
          .map((v) => v.versionNo),
      ),
    );
  }
  async insertDraft(
    m: MarketContext,
    draft: Parameters<PageRepository['insertDraft']>[1],
    stamp: Stamp,
  ) {
    if ((await this.findDraft(m, draft.pageId)) !== null) throw new Error('two drafts');
    this.versionRows.set(draft.id, {
      ...draft,
      state: 'draft',
      settings: null,
      createdAt: stamp.at,
      updatedAt: stamp.at,
      publishedAt: null,
    });
  }
  updateDraft(
    _m: MarketContext,
    versionId: Id<'StorefrontPageVersion'>,
    placements: Record<string, unknown>,
    stamp: Stamp,
  ) {
    const row = this.versionRows.get(versionId)!;
    if (row.state === 'draft') {
      this.versionRows.set(versionId, {
        ...row,
        placements: structuredClone(placements),
        updatedAt: stamp.at,
      });
    }
    return Promise.resolve();
  }
  updateDraftSettings(
    _m: MarketContext,
    versionId: Id<'StorefrontPageVersion'>,
    settings: Record<string, unknown>,
    stamp: Stamp,
  ) {
    const row = this.versionRows.get(versionId)!;
    if (row.state === 'draft') {
      this.versionRows.set(versionId, {
        ...row,
        settings: structuredClone(settings),
        updatedAt: stamp.at,
      });
    }
    return Promise.resolve();
  }
  publishDraft(
    _m: MarketContext,
    pageId: Id<'StorefrontPage'>,
    draftId: Id<'StorefrontPageVersion'>,
    stamp: Stamp,
  ) {
    for (const [key, row] of this.versionRows) {
      if (row.pageId === pageId && row.state === 'published') {
        this.versionRows.set(key, { ...row, state: 'retired' });
      }
    }
    const draft = this.versionRows.get(draftId)!;
    this.versionRows.set(draftId, { ...draft, state: 'published', publishedAt: stamp.at });
    return Promise.resolve();
  }
  findRedirect(_m: MarketContext, slug: string) {
    return Promise.resolve(this.redirects.get(slug) ?? null);
  }
  insertRedirect(_m: MarketContext, redirect: Parameters<PageRepository['insertRedirect']>[1]) {
    if (this.redirects.has(redirect.fromSlug)) throw new Error('unique redirect');
    this.redirects.set(redirect.fromSlug, redirect.pageId);
    return Promise.resolve();
  }
  deleteRedirect(_m: MarketContext, fromSlug: string) {
    this.redirects.delete(fromSlug);
    return Promise.resolve();
  }
}

describe.each([['AU'], ['ZZ']] as const)('storefront pages and navigation in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const gate = createUseCaseGate(markets, {
    check: (context: CallContext, declaration: AccessDeclaration) => {
      const actor = context.actor;
      const held =
        actor.kind === 'authenticated' && actor.accountId === ADMIN ? ADMIN_KEYS : EDITOR_KEYS;
      const rule = declaration.rule;
      const allowed = rule.kind !== 'permissions' || rule.allOf.every((key) => held.includes(key));
      return Promise.resolve(
        allowed ? { allowed: true } : { allowed: false, denial: { code: 'access.denied' } },
      );
    },
  });
  const actor = (accountId: Id<'Account'>, population: 'admin' | 'seller' = 'admin') =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId,
        sessionId: id<'Session'>(0x61),
        sellerId: population === 'seller' ? id<'Seller'>(0x51) : null,
      }),
      `sf-${accountId.slice(-4)}-abcd`,
    );
  const editor = actor(EDITOR);
  const admin = actor(ADMIN);
  const buyer = testCallContext(market, 'anonymous');

  let pages: MemoryPages;
  let audit: RecordingAudit;
  let deps: StorefrontDependencies;
  beforeEach(() => {
    pages = new MemoryPages();
    audit = new RecordingAudit();
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      pages,
      audit,
      ids: new SequenceIdGenerator(clock),
      clock,
    };
  });

  type Answer =
    | { readonly ok: true; readonly value: unknown }
    | { readonly ok: false; readonly error: unknown };
  type Runnable = new (
    g: typeof gate,
    d: StorefrontDependencies,
  ) => { execute(c: CallContext, i: never): Promise<Answer> };
  const run = (type: Runnable, context: CallContext, input: unknown): Promise<Answer> =>
    new type(gate, deps).execute(context, input as never);
  const value = async <T>(promise: Promise<Answer>): Promise<T> => {
    const result = await promise;
    if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.error)}`);
    return result.value as T;
  };
  const errorOf = async (promise: Promise<Answer>) => {
    const result = await promise;
    return result.ok ? 'allowed' : result.error;
  };
  const newPage = {
    templateKey: 'campaign-landing',
    title: 'Eid specials',
    slug: 'eid-specials',
  };
  const shelf = { module: 'product-shelf', config: { source: { kind: 'bestsellers' }, limit: 6 } };
  const published = (key: string) =>
    value<{
      kind: string;
      page: { versionNo: number | null; slots: { key: string; modules: { module: string }[] }[] };
    }>(run(ViewPublishedStorefrontPage, buyer, { key }));
  const landing = (slug: string) => run(ViewPublishedLandingPage, buyer, { slug });
  /** The draft as a publisher reviews it: its version number and last change time. */
  const reviewed = async (page: string | null) => {
    const view = await value<PageDetailView>(
      page === null
        ? run(ViewStorefrontNavigation, admin, {})
        : run(ViewStorefrontPage, admin, { page }),
    );
    return {
      versionNo: view.draft.versionNo ?? 1,
      updatedAt: (view.draft.updatedAt ?? T0).toString(),
    };
  };
  const publish = async (context: CallContext, page: string) =>
    run(PublishStorefrontPage, context, { page, body: await reviewed(page) });
  const approve = async (context: CallContext) =>
    run(ApproveStorefrontNavigation, context, { body: await reviewed(null) });

  it('lists every system page as defaults, then the landing pages; the catalogue is code', async () => {
    const list = await value<{ systemKey: string | null; status: string }[]>(
      run(ListStorefrontPages, editor, {}),
    );
    expect(list.map((p) => p.systemKey)).toContain('home');
    expect(list.every((p) => p.status === 'default')).toBe(true);
    const catalogue = await value<{ modules: { key: string }[] }>(
      run(ViewStorefrontCatalogue, editor, {}),
    );
    expect(catalogue.modules.map((m) => m.key)).toContain('faq');
  });

  it("serves a never-edited home page from its template's defaults", async () => {
    const home = await published('home');
    expect(home.page.versionNo).toBeNull();
    expect(home.page.slots.find((s) => s.key === 'main')!.modules.map((m) => m.module)).toEqual([
      'product-shelf',
      'product-shelf',
      'sellers-near-you',
    ]);
    expect(pages.pages.size).toBe(0);
  });

  it('lets an editor build a draft that buyers see only after a platform admin publishes it', async () => {
    const draft = await value<PageDetailView>(
      run(AddStorefrontModule, editor, {
        page: 'home',
        slot: 'main',
        body: { ...shelf, position: 0 },
      }),
    );
    expect(draft.draft.placements.main).toHaveLength(4);
    expect((await published('home')).page.versionNo).toBeNull();

    expect(await errorOf(publish(editor, 'home'))).toEqual({
      code: 'access.denied',
    });
    const done = await value<PageDetailView>(publish(admin, 'home'));
    expect(done.published?.versionNo).toBe(1);
    const home = await published('home');
    expect(home.page.versionNo).toBe(1);
    expect(home.page.slots.find((s) => s.key === 'main')!.modules).toHaveLength(4);
    expect(audit.entries.map((e) => e.action)).toEqual([
      'storefront.page.create',
      'storefront.draft.change',
      'storefront.page.publish',
    ]);
  });

  it('edits, switches off, reorders and removes modules; a switched-off module is not served', async () => {
    const start = await value<PageDetailView>(run(ViewStorefrontPage, editor, { page: 'home' }));
    expect(start.draft.versionNo).toBeNull();
    const added = await value<PageDetailView>(
      run(AddStorefrontModule, editor, { page: 'home', slot: 'main', body: shelf }),
    );
    const ids = added.draft.placements.main!.map((p) => p.id);
    const first = ids[0]!;
    await value(
      run(UpdateStorefrontModule, editor, {
        page: 'home',
        slot: 'main',
        placementId: first,
        body: { enabled: false },
      }),
    );
    await value(
      run(ReorderStorefrontModules, editor, {
        page: 'home',
        slot: 'main',
        placementIds: [...ids].reverse(),
      }),
    );
    const removed = await value<PageDetailView>(
      run(RemoveStorefrontModule, editor, {
        page: 'home',
        slot: 'main',
        placementId: ids[1],
      }),
    );
    expect(removed.draft.placements.main!.map((p) => p.id)).toEqual([ids[3], ids[2], first]);
    await value(publish(admin, 'home'));
    const served = (await published('home')).page.slots.find((s) => s.key === 'main')!.modules;
    expect(served).toHaveLength(2);
    expect(
      await errorOf(
        run(UpdateStorefrontModule, editor, {
          page: 'home',
          slot: 'main',
          placementId: first,
          body: { config: { source: { kind: 'nope' } } },
        }),
      ),
    ).toMatchObject({ code: 'validation.failed' });
    expect(
      await errorOf(run(AddStorefrontModule, editor, { page: 'home', slot: 'nope', body: shelf })),
    ).toEqual({ code: 'storefront.slot-not-found' });
  });

  it('refuses every change of a locked page, and publishing with nothing new', async () => {
    expect(
      await errorOf(
        run(AddStorefrontModule, editor, {
          page: 'checkout',
          slot: 'content',
          body: shelf,
        }),
      ),
    ).toEqual({ code: 'storefront.page-locked' });
    expect(await errorOf(publish(admin, 'account'))).toEqual({
      code: 'storefront.page-locked',
    });
    expect(await errorOf(publish(admin, 'offers'))).toEqual({
      code: 'storefront.nothing-to-publish',
    });
  });

  it('creates a landing page from a template, publishes it and serves it inside its live window', async () => {
    const created = await value<PageDetailView>(
      run(CreateStorefrontPage, editor, { ...newPage, endsAt: '2026-10-20T00:00:00Z' }),
    );
    expect(created.status).toBe('draft');
    expect(created.draft.placements.hero!.map((p) => p.module)).toEqual(['banner']);
    expect(await errorOf(landing('eid-specials'))).toEqual({
      code: 'storefront.page-not-found',
    });
    expect(await errorOf(run(CreateStorefrontPage, editor, newPage))).toEqual({
      code: 'storefront.slug-taken',
    });

    await value(publish(admin, created.id!));
    const live = await value<{ kind: string; page: { title: string } }>(landing('eid-specials'));
    expect(live).toMatchObject({ kind: 'page', page: { title: 'Eid specials' } });

    clock.set(Temporal.Instant.from('2026-10-21T00:00:00Z'));
    expect(await errorOf(landing('eid-specials'))).toEqual({
      code: 'storefront.page-not-found',
    });
    clock.set(T0);
  });

  it('keeps an old slug sending buyers on, and an archived page sends them where the admin chose', async () => {
    const created = await value<PageDetailView>(run(CreateStorefrontPage, editor, newPage));
    await value(publish(admin, created.id!));
    const edited = await value<PageDetailView>(
      run(UpdateStorefrontPageSettings, editor, {
        page: created.id,
        body: { title: 'Eid', slug: 'eid-2026' },
      }),
    );
    // An editor's settings wait in the draft: buyers see them only once an admin publishes it.
    expect(edited.draft.settings).toMatchObject({
      kind: 'dynamic',
      title: 'Eid',
      slug: 'eid-2026',
    });
    expect(edited).toMatchObject({ title: 'Eid specials', slug: 'eid-specials' });
    expect(await value(landing('eid-specials'))).toMatchObject({
      kind: 'page',
      page: { title: 'Eid specials' },
    });
    expect(await errorOf(landing('eid-2026'))).toEqual({ code: 'storefront.page-not-found' });
    await value(publish(admin, created.id!));
    expect(await value(landing('eid-2026'))).toMatchObject({ page: { title: 'Eid' } });
    expect(await value(landing('eid-specials'))).toEqual({
      kind: 'redirect',
      to: '/l/eid-2026',
    });
    const other = await errorOf(
      run(CreateStorefrontPage, editor, { ...newPage, slug: 'eid-specials' }),
    );
    expect(other).toEqual({ code: 'storefront.slug-taken' });

    expect(
      await errorOf(run(ArchiveStorefrontPage, editor, { page: created.id, body: {} })),
    ).toEqual({ code: 'access.denied' });
    // No redirect loop: a landing page never sends buyers to itself.
    expect(
      await errorOf(
        run(ArchiveStorefrontPage, admin, {
          page: created.id,
          body: { redirectTo: '/l/eid-2026' },
        }),
      ),
    ).toEqual({ code: 'validation.failed', fields: [{ path: 'redirectTo', code: 'not-live' }] });
    await value(
      run(ArchiveStorefrontPage, admin, {
        page: created.id,
        body: { redirectTo: '/offers' },
      }),
    );
    expect(await value(landing('eid-2026'))).toEqual({ kind: 'redirect', to: '/offers' });
    expect(await value(landing('eid-specials'))).toEqual({
      kind: 'redirect',
      to: '/offers',
    });
    expect(
      await errorOf(
        run(AddStorefrontModule, editor, { page: created.id, slot: 'main', body: shelf }),
      ),
    ).toEqual({ code: 'storefront.page-archived' });
  });

  it('restores an earlier version into the draft without changing what buyers see', async () => {
    await value(
      run(AddStorefrontModule, editor, {
        page: 'offers',
        slot: 'top',
        body: { module: 'banner', config: { title: 'One', image: { ref: 'a', alt: 'A' } } },
      }),
    );
    const first = await value<PageDetailView>(publish(admin, 'offers'));
    const v1 = first.versions.find((v) => v.state === 'published')!;
    const banner = first.draft.placements.top![0]!.id;
    await value(
      run(RemoveStorefrontModule, editor, {
        page: 'offers',
        slot: 'top',
        placementId: banner,
      }),
    );
    await value(publish(admin, 'offers'));
    const restored = await value<PageDetailView>(
      run(RestoreStorefrontPageVersion, editor, { page: 'offers', versionId: v1.id }),
    );
    expect(restored.draft.placements.top).toHaveLength(1);
    expect(
      (await published('offers')).page.slots.find((s) => s.key === 'top')!.modules,
    ).toHaveLength(0);
  });

  it('shows the navigation only after a platform admin approves it, with keys separate from pages', async () => {
    const draft = {
      slots: {
        rail: [{ config: { label: 'Deals', target: { kind: 'system-page', key: 'offers' } } }],
        'drawer-categories': [{ config: { categoryId: id(0xc1) } }],
      },
    };
    await value(run(ReplaceStorefrontNavigationDraft, editor, draft));
    const before = await value<{
      page: { versionNo: number | null; slots: { modules: unknown[] }[] };
    }>(run(ViewPublishedStorefrontNavigation, buyer, {}));
    expect(before.page.versionNo).toBeNull();
    expect(before.page.slots.every((s) => s.modules.length === 0)).toBe(true);

    expect(await errorOf(approve(editor))).toEqual({
      code: 'access.denied',
    });
    // The navigation is not a page: the page routes do not reach it.
    expect(
      await errorOf(
        run(PublishStorefrontPage, admin, {
          page: 'navigation',
          body: { versionNo: 1, updatedAt: T0.toString() },
        }),
      ),
    ).toEqual({
      code: 'storefront.page-not-found',
    });
    expect(
      await errorOf(
        run(AddStorefrontModule, editor, {
          page: 'navigation',
          slot: 'rail',
          body: { module: 'nav-link', config: {} },
        }),
      ),
    ).toEqual({ code: 'storefront.page-not-found' });
    expect(await errorOf(run(ViewPublishedStorefrontPage, buyer, { key: 'navigation' }))).toEqual({
      code: 'storefront.page-not-found',
    });

    await value(approve(admin));
    const after = await value<{
      page: { versionNo: number; slots: { key: string; modules: unknown[] }[] };
    }>(run(ViewPublishedStorefrontNavigation, buyer, {}));
    expect(after.page.versionNo).toBe(1);
    expect(after.page.slots.find((s) => s.key === 'rail')!.modules).toHaveLength(1);
    const view = await value<PageDetailView>(run(ViewStorefrontNavigation, editor, {}));
    expect(view.published?.versionNo).toBe(1);
    expect(audit.entries.at(-1)?.action).toBe('storefront.page.publish');

    expect(
      await errorOf(
        run(ReplaceStorefrontNavigationDraft, editor, {
          slots: {
            rail: [
              { config: { label: 'x', target: { kind: 'path', path: 'https://evil.example' } } },
            ],
          },
        }),
      ),
    ).toMatchObject({ code: 'validation.failed' });
  });

  it('publishes only the draft the publisher reviewed', async () => {
    await value(run(AddStorefrontModule, editor, { page: 'home', slot: 'main', body: shelf }));
    const seen = await reviewed('home');
    clock.set(T0.add({ minutes: 1 }));
    await value(run(AddStorefrontModule, editor, { page: 'home', slot: 'main', body: shelf }));
    expect(await errorOf(run(PublishStorefrontPage, admin, { page: 'home', body: seen }))).toEqual({
      code: 'storefront.draft-changed',
    });
    expect(
      await errorOf(run(PublishStorefrontPage, admin, { page: 'home', body: { versionNo: 1 } })),
    ).toEqual({ code: 'validation.failed', fields: [{ path: 'updatedAt', code: 'required' }] });
    expect((await published('home')).page.versionNo).toBeNull();
    await value(publish(admin, 'home'));
    expect((await published('home')).page.versionNo).toBe(1);
    clock.set(T0);
  });

  it("keeps a live page's window until an admin publishes the change, and an old slug only leads to a live page", async () => {
    const created = await value<PageDetailView>(run(CreateStorefrontPage, editor, newPage));
    await value(publish(admin, created.id!));
    await value(
      run(UpdateStorefrontPageSettings, editor, {
        page: created.id,
        body: { title: 'Eid', slug: 'eid-2026', endsAt: '2026-10-18T00:00:00Z' },
      }),
    );
    clock.set(Temporal.Instant.from('2026-10-19T00:00:00Z'));
    // Unpublished, the window the editor set does not end the page.
    expect(await value(landing('eid-specials'))).toMatchObject({ kind: 'page' });
    clock.set(T0);
    await value(publish(admin, created.id!));
    clock.set(Temporal.Instant.from('2026-10-19T00:00:00Z'));
    expect(await errorOf(landing('eid-2026'))).toEqual({ code: 'storefront.page-not-found' });
    expect(await errorOf(landing('eid-specials'))).toEqual({ code: 'storefront.page-not-found' });
    clock.set(T0);
  });

  it('refuses a seller actor and leaves buyers no write', async () => {
    const seller = actor(id<'Account'>(0x5e), 'seller');
    expect(await errorOf(run(ListStorefrontPages, seller, {}))).toMatchObject({
      code: 'access.denied',
    });
    expect(await errorOf(run(CreateStorefrontPage, buyer, newPage))).toMatchObject({
      code: 'access.unauthenticated',
    });
  });
});
