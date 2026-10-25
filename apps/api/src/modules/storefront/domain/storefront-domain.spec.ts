import { parseModuleConfig, MODULE_KEYS, type ModuleKey } from './modules';
import {
  isSlug,
  parseArchive,
  parseDynamicSettings,
  parseNewPage,
  parseStoredSettings,
  storedSettings,
} from './page-settings';
import {
  addPlacement,
  defaultPlacements,
  publishProblems,
  readPlacements,
  removePlacement,
  reorderPlacements,
  servedSlots,
  sizeProblems,
  storedPlacements,
  updatePlacement,
  type Placements,
} from './placements';
import { SYSTEM_PAGE_LIST, TEMPLATES, templateOf } from './templates';

// The storefront's code catalogue and the rules of a page version: every module checks its
// settings and stores them normalised, texts are plain text, links are site paths or https URLs,
// a slot takes only the modules its template allows and at most its maximum, and a version is
// published only with every slot's minimum.

const ids = () => {
  let n = 0;
  return () => `p-${(n += 1)}`;
};
const IMAGE = { ref: 'hero-1', alt: 'Fresh produce' };
const ID = '01990000-0000-7000-8000-000000000001';

const config = (module: ModuleKey, value: unknown) => parseModuleConfig(module, value);
const codes = (result: ReturnType<typeof parseModuleConfig>) =>
  result.ok ? [] : result.problems.map((p) => `${p.path}:${p.code}`);

describe('the module catalogue', () => {
  it('accepts and normalises valid settings of each module', () => {
    expect(config('banner', { title: '  Eid sale ', image: IMAGE, href: '/offers' })).toEqual({
      ok: true,
      config: { title: 'Eid sale', image: IMAGE, href: '/offers' },
    });
    expect(config('product-shelf', { source: { kind: 'bestsellers' } })).toEqual({
      ok: true,
      config: { source: { kind: 'bestsellers' }, limit: 12 },
    });
    expect(
      config('product-shelf', { source: { kind: 'manual', productIds: [ID] }, limit: 4 }).ok,
    ).toBe(true);
    expect(config('product-shelf', { source: { kind: 'tag', code: 'halal' } }).ok).toBe(true);
    expect(
      config('info-strip', { items: [{ icon: 'delivery' }, { icon: 'tax', text: 'GST incl.' }] })
        .ok,
    ).toBe(true);
    expect(
      config('text-block', {
        blocks: [
          { type: 'heading', text: 'About us', level: 3 },
          { type: 'paragraph', spans: [{ text: 'See ' }, { text: 'help', href: '/l/help' }] },
          { type: 'list', items: [[{ text: 'One' }], [{ text: 'Two' }]] },
        ],
      }).ok,
    ).toBe(true);
    expect(
      config('faq', { items: [{ question: 'Is it halal?', answer: [{ text: 'Yes.' }] }] }).ok,
    ).toBe(true);
    expect(
      config('nav-link', { label: 'Deals', target: { kind: 'system-page', key: 'offers' } }).ok,
    ).toBe(true);
    expect(config('nav-category', { categoryId: ID }).ok).toBe(true);
    expect(config('category-circles', {}).ok).toBe(true);
    expect(config('product-spotlight', {}).ok).toBe(true);
  });

  it('refuses unknown fields, missing texts, hidden characters and over-long texts', () => {
    expect(codes(config('banner', { title: 'x', image: IMAGE, html: '<b>' }))).toEqual([
      'config.html:unknown-field',
    ]);
    expect(codes(config('banner', { image: IMAGE }))).toEqual(['config.title:required']);
    expect(codes(config('banner', { title: 'a‮b', image: IMAGE }))).toEqual([
      'config.title:format',
    ]);
    expect(codes(config('banner', { title: 'x'.repeat(81), image: IMAGE }))).toEqual([
      'config.title:length',
    ]);
    expect(codes(config('banner', { title: 'x', image: { ref: 'hero-1' } }))).toEqual([
      'config.image.alt:required',
    ]);
    expect(codes(config('banner', { title: 'x', image: { ref: '../etc', alt: 'a' } }))).toEqual([
      'config.image.ref:format',
    ]);
  });

  it('accepts only site paths and https links', () => {
    const link = (href: string) => codes(config('banner', { title: 'x', image: IMAGE, href }));
    expect(link('/c/fruit?sort=new')).toEqual([]);
    expect(link('https://example.com/a')).toEqual([]);
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,x',
      'http://example.com',
      '//evil.example',
      '/a/../admin',
      'https://user:pw@example.com',
      '/a b',
      '/%2F%2Fevil.example',
      '/%2e%2e/admin',
    ]) {
      expect(link(bad)).toEqual(['config.href:format']);
    }
  });

  it('keeps the shelf sources and their parameters closed', () => {
    expect(codes(config('product-shelf', { source: { kind: 'brand', id: ID } }))).toEqual([
      'config.source.kind:enum',
    ]);
    expect(codes(config('product-shelf', { source: { kind: 'category' } }))).toEqual([
      'config.source.id:required',
    ]);
    expect(codes(config('product-shelf', { source: { kind: 'bestsellers', id: ID } }))).toEqual([
      'config.source.id:unknown-field',
    ]);
    expect(codes(config('product-shelf', { source: { kind: 'bestsellers' }, limit: 25 }))).toEqual([
      'config.limit:range',
    ]);
    expect(
      codes(config('product-shelf', { source: { kind: 'manual', productIds: [ID, ID] } })),
    ).toEqual(['config.source.productIds:duplicate']);
  });

  it('takes the personal shelf sources with no other field', () => {
    for (const kind of ['recently-viewed', 'for-you', 'bought-together']) {
      expect(config('product-shelf', { source: { kind } })).toEqual({
        ok: true,
        config: { source: { kind }, limit: 12 },
      });
      expect(codes(config('product-shelf', { source: { kind, id: ID } }))).toEqual([
        'config.source.id:unknown-field',
      ]);
      expect(codes(config('product-shelf', { source: { kind, code: 'halal' } }))).toEqual([
        'config.source.code:unknown-field',
      ]);
      expect(codes(config('product-shelf', { source: { kind, productIds: [ID] } }))).toEqual([
        'config.source.productIds:unknown-field',
      ]);
    }
  });

  it('gives rich text no heading level 1 and no markup', () => {
    expect(
      codes(config('text-block', { blocks: [{ type: 'heading', text: 'x', level: 1 }] })),
    ).toEqual(['config.blocks[0].level:enum']);
    expect(codes(config('text-block', { blocks: [{ type: 'html', text: '<p>' }] }))).toEqual([
      'config.blocks[0].type:enum',
    ]);
    expect(
      codes(config('text-block', { blocks: [{ type: 'heading', text: 'x', spans: [] }] })),
    ).toEqual(['config.blocks[0].spans:unknown-field']);
  });
});

describe('templates and system pages', () => {
  it('has default modules that pass their own checks and fit their slots, for every template', () => {
    for (const template of TEMPLATES.values()) {
      expect(() => defaultPlacements(template, { title: 'Page' }, ids())).not.toThrow();
    }
  });

  it('offers the four v1 templates at page creation, each slot naming only catalogued modules', () => {
    const dynamic = [...TEMPLATES.values()].filter((t) => t.scope === 'dynamic').map((t) => t.key);
    expect(dynamic).toEqual(['campaign-landing', 'brand-page', 'product-spotlight', 'info-page']);
    for (const template of TEMPLATES.values()) {
      for (const slot of template.slots) {
        for (const module of slot.modules) expect(MODULE_KEYS).toContain(module);
        expect(slot.min).toBeLessThanOrEqual(slot.max);
      }
    }
  });

  it('names a known template for every system page, and locks checkout, confirmation and account', () => {
    for (const page of SYSTEM_PAGE_LIST) expect(TEMPLATES.has(page.templateKey)).toBe(true);
    expect(SYSTEM_PAGE_LIST.filter((p) => p.editLevel === 'locked').map((p) => p.key)).toEqual([
      'checkout',
      'order-confirmation',
      'account',
    ]);
  });
});

describe('placements of a draft', () => {
  const home = templateOf('system.home');
  const start = () => defaultPlacements(home, { title: 'Home' }, ids());
  const shelf = { module: 'product-shelf', config: { source: { kind: 'specials' } } };

  it('adds a module at the end or at a position, and only one the slot allows', () => {
    const added = addPlacement(home, start(), 'main', { ...shelf, position: 0 }, 'new');
    expect(added.ok && added.value.main![0]!.id).toBe('new');
    const wrong = addPlacement(home, start(), 'top', shelf, 'x');
    expect(wrong).toEqual({
      ok: false,
      error: {
        code: 'validation.failed',
        fields: [{ path: 'module', code: 'not-allowed-in-slot' }],
      },
    });
    expect(addPlacement(home, start(), 'header', shelf, 'x')).toEqual({
      ok: false,
      error: { code: 'storefront.slot-not-found' },
    });
    expect(addPlacement(templateOf('system.product'), {}, 'details', shelf, 'x')).toEqual({
      ok: false,
      error: { code: 'storefront.slot-not-found' },
    });
  });

  it('refuses a module beyond the slot maximum', () => {
    const one = addPlacement(
      home,
      start(),
      'categories',
      { module: 'category-circles', config: {} },
      'x',
    );
    expect(one).toEqual({ ok: false, error: { code: 'storefront.slot-full' } });
  });

  it('switches a module off, changes its settings, removes it and reorders a slot', () => {
    const placements = start();
    const [first, second] = placements.main!;
    const off = updatePlacement(home, placements, 'main', first!.id, { enabled: false });
    expect(off.ok && off.value.main![0]!.enabled).toBe(false);
    const bad = updatePlacement(home, placements, 'main', first!.id, { config: { source: {} } });
    expect(bad.ok).toBe(false);
    expect(updatePlacement(home, placements, 'main', 'ghost', { enabled: true })).toEqual({
      ok: false,
      error: { code: 'storefront.placement-not-found' },
    });
    const removed = removePlacement(home, placements, 'main', first!.id);
    expect(removed.ok && removed.value.main!.map((p) => p.id)).toEqual(
      placements.main!.slice(1).map((p) => p.id),
    );
    const ids3 = placements.main!.map((p) => p.id);
    const reordered = reorderPlacements(home, placements, 'main', [...ids3].reverse());
    expect(reordered.ok && reordered.value.main!.map((p) => p.id)).toEqual([...ids3].reverse());
    expect(reorderPlacements(home, placements, 'main', [second!.id]).ok).toBe(false);
    expect(reorderPlacements(home, placements, 'main', [...ids3.slice(1), 'ghost']).ok).toBe(false);
  });

  it('publishes only with every minimum, counting switched-on modules', () => {
    const empty: Placements = { top: [], categories: [], main: [], end: [] };
    expect(publishProblems(home, empty, null)).toEqual([
      { path: 'slots.main', code: 'too-few-modules' },
    ]);
    const brand = templateOf('brand-page');
    const draft = defaultPlacements(brand, { title: 'Acme' }, ids());
    expect(publishProblems(brand, draft, null)).toEqual([
      { path: 'slots.main[0]', code: 'needs-linked-entity' },
    ]);
    expect(publishProblems(brand, draft, 'seller')).toEqual([]);
  });

  it('keeps a bought-together shelf to pages that can pair it with a product', () => {
    const together = {
      module: 'product-shelf',
      config: { source: { kind: 'bought-together' } },
    };
    const refused = {
      ok: false,
      error: {
        code: 'validation.failed',
        fields: [{ path: 'config.source.kind', code: 'needs-product-page' }],
      },
    };
    expect(addPlacement(home, start(), 'main', together, 'x')).toEqual(refused);
    const existing = start().main![0]!;
    expect(
      updatePlacement(home, start(), 'main', existing.id, { config: together.config }),
    ).toEqual(refused);

    const withTogether = (template: ReturnType<typeof templateOf>, slot: string) => {
      const added = addPlacement(
        template,
        defaultPlacements(template, { title: 'P' }, ids()),
        slot,
        together,
        'x',
      );
      expect(added.ok).toBe(true);
      return added.ok ? added.value : {};
    };
    const product = templateOf('system.product');
    expect(publishProblems(product, withTogether(product, 'below'), null)).toEqual([]);
    const spotlight = templateOf('product-spotlight');
    const linkedPage = withTogether(spotlight, 'related');
    expect(publishProblems(spotlight, linkedPage, 'product')).toEqual([]);
    const campaign = templateOf('campaign-landing');
    const campaignSlot = campaign.slots.find(
      (s) => s.kind === 'modules' && s.modules.includes('product-shelf'),
    )!;
    const onCampaign = withTogether(campaign, campaignSlot.key);
    expect(publishProblems(campaign, onCampaign, 'product')).toEqual([]);
    expect(publishProblems(campaign, onCampaign, 'seller')).toEqual([
      {
        path: `slots.${campaignSlot.key}[${onCampaign[campaignSlot.key]!.length - 1}]`,
        code: 'needs-product-page',
      },
    ]);
    const unlinkedProblem = {
      path: `slots.${campaignSlot.key}[${onCampaign[campaignSlot.key]!.length - 1}]`,
      code: 'needs-product-page',
    };
    // A product-linkable page may hold the shelf in its draft, but publishes it only once linked.
    expect(publishProblems(campaign, onCampaign, null)).toContainEqual(unlinkedProblem);
    // A switched-off shelf does not block publishing.
    const shelfId = onCampaign[campaignSlot.key]!.at(-1)!.id;
    const switchedOff = updatePlacement(campaign, onCampaign, campaignSlot.key, shelfId, {
      enabled: false,
    });
    expect(switchedOff.ok).toBe(true);
    expect(
      publishProblems(campaign, switchedOff.ok ? switchedOff.value : {}, 'seller'),
    ).not.toContainEqual(unlinkedProblem);

    // An existing shelf may become bought-together on the product page, and switching a shelf
    // on or off on home never trips the check.
    const productDraft = addPlacement(
      product,
      defaultPlacements(product, { title: 'P' }, ids()),
      'below',
      { module: 'product-shelf', config: { source: { kind: 'bestsellers' } } },
      'x',
    );
    expect(productDraft.ok).toBe(true);
    if (productDraft.ok) {
      const shelfOnProduct = productDraft.value.below!.at(-1)!;
      const changed = updatePlacement(product, productDraft.value, 'below', shelfOnProduct.id, {
        config: together.config,
      });
      expect(changed.ok && changed.value.below!.at(-1)!.config).toEqual({
        ...together.config,
        limit: 12,
      });
    }
    expect(updatePlacement(home, start(), 'main', existing.id, { enabled: false }).ok).toBe(true);

    // Stored content is re-checked: a bought-together shelf on a template that cannot host it is
    // left out on read, and a switched-off one does not block publishing.
    const stored = storedPlacements(start()) as Record<string, unknown[]>;
    stored.main!.push({
      id: 'bt',
      module: 'product-shelf',
      enabled: true,
      config: together.config,
    });
    expect(readPlacements(home, stored).dropped).toBe(1);
    const sourceHost = storedPlacements(withTogether(product, 'below'));
    expect(readPlacements(product, sourceHost).dropped).toBe(0);
  });

  it('publishes recently-viewed and for-you shelves on any shelf page', () => {
    for (const kind of ['recently-viewed', 'for-you']) {
      const added = addPlacement(
        home,
        start(),
        'main',
        { module: 'product-shelf', config: { source: { kind } } },
        'x',
      );
      expect(added.ok).toBe(true);
      expect(publishProblems(home, added.ok ? added.value : {}, null)).toEqual([]);
    }
  });

  it('serves only switched-on modules, and re-checks stored content on read', () => {
    const placements = start();
    const off = updatePlacement(home, placements, 'main', placements.main![0]!.id, {
      enabled: false,
    });
    const served = servedSlots(home, off.ok ? off.value : placements);
    expect(served.find((s) => s.key === 'main')!.modules).toHaveLength(placements.main!.length - 1);

    const stored = storedPlacements(placements) as Record<string, unknown[]>;
    stored.main!.push({
      id: 'evil',
      module: 'banner',
      enabled: true,
      config: { title: 'x', image: IMAGE },
    });
    stored.top!.push({ id: 'bad', module: 'banner', enabled: true, config: { title: 'a\u0000' } });
    stored.ghost = [{ id: 'g', module: 'faq', enabled: true, config: {} }];
    const read = readPlacements(home, stored);
    expect(read.dropped).toBe(2);
    expect(read.placements.main!.map((p) => p.id)).toContain('evil');
    expect(read.placements.top).toEqual([]);
  });
});

describe('page settings', () => {
  it('checks slugs, reserved words, the template and its linkable entities', () => {
    expect(isSlug('eid-2026')).toBe(true);
    expect(isSlug('Eid')).toBe(false);
    const base = { templateKey: 'campaign-landing', title: 'Eid', slug: 'eid-2026' };
    expect(parseNewPage(base).ok).toBe(true);
    const fields = (body: unknown) => {
      const parsed = parseNewPage(body);
      return parsed.ok ? [] : parsed.problems.map((p) => `${p.path}:${p.code}`);
    };
    expect(fields({ ...base, slug: 'cart' })).toEqual(['slug:reserved']);
    expect(fields({ ...base, slug: '-x' })).toEqual(['slug:format']);
    expect(fields({ ...base, templateKey: 'system.home' })).toEqual(['templateKey:enum']);
    expect(
      fields({ ...base, templateKey: 'info-page', linked: { type: 'product', id: ID } }),
    ).toEqual(['linked.type:not-allowed-for-template']);
    expect(
      fields({ ...base, startsAt: '2026-11-02T00:00:00Z', endsAt: '2026-11-01T00:00:00Z' }),
    ).toEqual(['endsAt:before-start']);
    expect(parseDynamicSettings({ title: 'x', slug: 'x', extra: 1 }, 'info-page').ok).toBe(false);
  });

  it('archives with a site path to send buyers to, or none', () => {
    expect(parseArchive({})).toEqual({ ok: true, value: { redirectTo: null } });
    expect(parseArchive({ redirectTo: '/offers' })).toEqual({
      ok: true,
      value: { redirectTo: '/offers' },
    });
    expect(parseArchive({ redirectTo: 'https://evil.example' }).ok).toBe(false);
    expect(parseArchive({ redirectTo: '//evil.example' }).ok).toBe(false);
  });
  it('keeps each stored module and each version small', () => {
    const entry = (n: number) => ({
      id: `p${n}`,
      module: 'text-block' as ModuleKey,
      enabled: true,
      config: { body: 'x'.repeat(30_000) } as never,
    });
    expect(sizeProblems({ main: [entry(1)] })).toEqual([]);
    expect(sizeProblems({ main: [{ ...entry(1), config: { body: 'x'.repeat(40_000) } }] })).toEqual(
      [{ path: 'main[0]', code: 'too-large' }],
    );
    expect(sizeProblems({ main: Array.from({ length: 9 }, (_, n) => entry(n)) })).toEqual([
      { path: 'placements', code: 'too-large' },
    ]);
  });

  it('stores pending settings as a body and reads them back checked', () => {
    const page = { kind: 'dynamic' as const, templateKey: 'campaign-landing' };
    const parsed = parseDynamicSettings(
      { title: 'Eid', slug: 'eid', endsAt: '2026-11-01T00:00:00Z' },
      page.templateKey,
    );
    if (!parsed.ok) throw new Error('bad settings');
    const stored = storedSettings({ kind: 'dynamic', ...parsed.value });
    expect(stored).toMatchObject({ slug: 'eid', endsAt: '2026-11-01T00:00:00Z', startsAt: null });
    expect(parseStoredSettings(stored, page)).toMatchObject({ kind: 'dynamic', title: 'Eid' });
    expect(parseStoredSettings({ ...stored, slug: 'Bad Slug' }, page)).toBeNull();
    expect(parseStoredSettings(null, page)).toBeNull();
    expect(
      parseStoredSettings(
        { title: 'Home', seo: {} },
        { kind: 'system', templateKey: 'system.home' },
      ),
    ).toEqual({ kind: 'system', title: 'Home', seo: {} });
  });
});
