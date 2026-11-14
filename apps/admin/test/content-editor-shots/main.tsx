import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { PageContent } from '../../src/content/pages/page-content.tsx';
import { PageSettings } from '../../src/content/pages/page-settings.tsx';
import { PageVersions } from '../../src/content/pages/page-versions.tsx';
import type { PageDetail, Placement } from '../../src/content/pages/page-types.ts';

const at = (
  id: string,
  module: string,
  config: Record<string, unknown>,
  enabled = true,
): Placement => ({
  id,
  module,
  enabled,
  config,
});

const landing: PageDetail = {
  id: 'p1',
  kind: 'dynamic',
  systemKey: null,
  slug: 'ramadan-specials',
  path: '/l/ramadan-specials',
  templateKey: 'campaign-landing',
  title: 'Ramadan specials',
  editLevel: 'full',
  status: 'published',
  hasDraft: true,
  publishedVersionNo: 2,
  publishedAt: '2026-11-01T01:00:00Z',
  updatedAt: '2026-11-02T01:00:00Z',
  seo: { title: 'Ramadan specials | MondaPac', description: 'Dates, meat and sweets for Ramadan.' },
  linked: { type: 'category', id: 'c1' },
  startsAt: '2026-11-20T00:00:00Z',
  endsAt: null,
  archivedRedirect: null,
  slots: [
    { key: 'hero', kind: 'modules', modules: ['banner'], min: 1, max: 1, width: 'full' },
    { key: 'benefits', kind: 'modules', modules: ['info-strip'], min: 0, max: 1, width: 'full' },
    {
      key: 'main',
      kind: 'modules',
      modules: ['product-shelf', 'banner', 'image-text', 'text-block'],
      min: 1,
      max: 8,
      width: 'full',
    },
    {
      key: 'bottom',
      kind: 'modules',
      modules: ['faq', 'text-block'],
      min: 0,
      max: 2,
      width: 'column',
    },
  ],
  draft: {
    versionNo: 3,
    updatedAt: '2026-11-02T01:00:00Z',
    settings: null,
    placements: {
      hero: [
        at('b1', 'banner', {
          title: 'Ramadan specials',
          subtitle: 'Everything for iftar',
          image: { ref: 'fruits', alt: 'A basket of fruit' },
          href: '/offers',
          ctaLabel: 'Shop now',
        }),
      ],
      benefits: [at('i1', 'info-strip', { items: [{ icon: 'delivery' }, { icon: 'tax' }] })],
      main: [
        at('s1', 'product-shelf', { title: 'Dates', source: { kind: 'specials' }, limit: 12 }),
        at('s2', 'product-shelf', { source: { kind: 'bestsellers' }, limit: 8 }, false),
        at('t1', 'text-block', {
          blocks: [{ type: 'heading', level: 2, text: 'Opening hours' }],
        }),
      ],
      bottom: [],
    },
  },
  published: null,
  versions: [
    {
      id: 'v1',
      versionNo: 1,
      state: 'retired',
      createdAt: '2026-10-01T01:00:00Z',
      publishedAt: '2026-10-02T01:00:00Z',
    },
    {
      id: 'v2',
      versionNo: 2,
      state: 'published',
      createdAt: '2026-11-01T00:00:00Z',
      publishedAt: '2026-11-01T01:00:00Z',
    },
    {
      id: 'v3',
      versionNo: 3,
      state: 'draft',
      createdAt: '2026-11-02T01:00:00Z',
      publishedAt: null,
    },
  ],
};

const system: PageDetail = {
  ...landing,
  id: null,
  kind: 'system',
  systemKey: 'search',
  slug: null,
  path: '/search',
  templateKey: 'system.search',
  title: 'Search',
  editLevel: 'limited',
  status: 'default',
  hasDraft: false,
  publishedVersionNo: null,
  publishedAt: null,
  updatedAt: null,
  linked: null,
  startsAt: null,
  endsAt: null,
  slots: [
    { key: 'top', kind: 'modules', modules: ['banner'], min: 0, max: 1, width: 'full' },
    { key: 'results', kind: 'fixed', modules: [], min: 0, max: 0, width: 'full' },
    {
      key: 'no-results',
      kind: 'modules',
      modules: ['product-shelf', 'text-block'],
      min: 0,
      max: 2,
      width: 'full',
    },
  ],
  draft: {
    versionNo: null,
    updatedAt: null,
    settings: null,
    placements: {
      top: [],
      results: [],
      'no-results': [at('n1', 'product-shelf', { source: { kind: 'bestsellers' }, limit: 12 })],
    },
  },
};

const catalogue = {
  templates: [{ key: 'campaign-landing', scope: 'dynamic', linkable: ['category'] }],
};
const tree = {
  defaultLocale: 'en-AU',
  categories: [
    { id: 'c1', status: 'active', depth: 0, names: [{ locale: 'en-AU', name: 'Meat' }] },
    { id: 'c2', status: 'active', depth: 1, names: [{ locale: 'en-AU', name: 'Lamb' }] },
  ],
};

const view = window.location.hash.slice(1);
const refuse = (code: string, status: number, fields?: unknown) =>
  Promise.resolve(
    new Response(
      JSON.stringify({ code, ...(fields === undefined ? {} : { details: { fields } }) }),
      {
        status,
      },
    ),
  );
window.fetch = ((input: string, init?: RequestInit) => {
  const path = input.replace(/^\/api\//, '').split('?')[0]!;
  if (init?.method !== undefined && init.method !== 'GET') {
    if (view === 'edit-errors') {
      return refuse('validation.failed', 400, [
        { path: 'config.title', code: 'required' },
        { path: 'config.href', code: 'format' },
      ]);
    }
    if (view === 'content-stale') return refuse('storefront.placement-not-found', 404);
    if (view === 'versions-gone') return refuse('storefront.version-not-found', 404);
    if (view === 'publish-errors') {
      return refuse('validation.failed', 400, [{ path: 'slots.main', code: 'too-few-modules' }]);
    }
    if (view === 'publish-changed') return refuse('storefront.draft-changed', 409);
    if (view === 'settings-errors') {
      return refuse('validation.failed', 400, [
        { path: 'slug', code: 'reserved' },
        { path: 'seo.description', code: 'length' },
      ]);
    }
    return Promise.resolve(new Response(JSON.stringify(landing), { status: 200 }));
  }
  const body =
    path === 'storefront/admin/catalogue'
      ? catalogue
      : path === 'catalog/admin/categories'
        ? tree
        : { code: 'not-found' };
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}) as typeof fetch;

const zone = 'Australia/Brisbane';
const screen = view.startsWith('settings')
  ? 'settings'
  : view.startsWith('versions')
    ? 'versions'
    : 'content';
const admin = view.startsWith('publish') || view.startsWith('admin') || screen === 'versions';
const detail = view.endsWith('system')
  ? system
  : view === 'admin-nodraft'
    ? { ...landing, hasDraft: false }
    : view === 'versions-empty'
      ? { ...landing, versions: [] }
      : landing;
const canEdit = !view.includes('readonly');
const withPending: PageDetail =
  view === 'settings-pending'
    ? {
        ...landing,
        draft: {
          ...landing.draft,
          settings: {
            title: 'Ramadan and Eid specials',
            slug: 'ramadan-eid',
            seo: landing.seo,
            linked: landing.linked,
            startsAt: landing.startsAt,
            endsAt: '2026-12-20T00:00:00Z',
          },
        },
      }
    : detail;
createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <main className="mx-auto max-w-7xl p-4 md:p-6">
      {screen === 'content' ? (
        <PageContent
          page={withPending}
          canEdit={canEdit}
          canPublish={admin}
          canArchive={admin}
          csrfToken="tok"
          zone={zone}
        />
      ) : screen === 'versions' ? (
        <PageVersions
          page={withPending}
          canEdit={canEdit}
          canPublish={admin}
          canArchive={admin}
          csrfToken="tok"
          zone={zone}
        />
      ) : (
        <PageSettings page={withPending} canEdit={canEdit} csrfToken="tok" zone={zone} />
      )}
    </main>
  </NextIntlClientProvider>,
);
