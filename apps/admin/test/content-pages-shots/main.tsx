import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { Tabs } from '@mondapac/ui';
import { NewPageFormView } from '../../src/content/pages/new-page-form.tsx';
import { PagesList } from '../../src/content/pages/pages-list.tsx';

const page = (patch: Record<string, unknown>) => ({
  id: null,
  kind: 'system',
  systemKey: 'home',
  slug: null,
  path: '/',
  templateKey: 'system.home',
  title: 'Home',
  editLevel: 'full',
  status: 'default',
  hasDraft: false,
  publishedVersionNo: null,
  publishedAt: null,
  updatedAt: null,
  ...patch,
});
const pages = [
  page({}),
  page({ systemKey: 'offers', path: '/offers', title: 'Offers', templateKey: 'system.offers', status: 'published', hasDraft: true, publishedVersionNo: 3, publishedAt: '2026-11-08T01:00:00Z' }),
  page({ systemKey: 'cart', path: '/cart', title: 'Cart', templateKey: 'system.cart', editLevel: 'limited' }),
  page({ systemKey: 'checkout', path: '/checkout', title: 'Checkout', templateKey: 'system.locked', editLevel: 'locked' }),
  page({ id: 'p1', kind: 'dynamic', systemKey: null, slug: 'ramadan-specials', path: '/l/ramadan-specials', templateKey: 'campaign-landing', title: 'Ramadan specials', status: 'published', publishedVersionNo: 2, publishedAt: '2026-11-01T01:00:00Z' }),
  page({ id: 'p2', kind: 'dynamic', systemKey: null, slug: 'eid-hours', path: '/l/eid-hours', templateKey: 'info-page', title: 'Eid opening hours', status: 'draft', hasDraft: true }),
  page({ id: 'p3', kind: 'dynamic', systemKey: null, slug: 'summer-sale', path: '/l/summer-sale', templateKey: 'campaign-landing', title: 'Summer sale', status: 'scheduled', hasDraft: true, publishedVersionNo: 1, publishedAt: '2026-11-02T01:00:00Z' }),
  page({ id: 'p4', kind: 'dynamic', systemKey: null, slug: 'halal-bakery', path: '/l/halal-bakery', templateKey: 'brand-page', title: 'Halal bakery', status: 'archived', publishedVersionNo: 1, publishedAt: '2026-10-01T01:00:00Z' }),
  page({ systemKey: 'navigation', path: '/', title: 'Navigation', editLevel: 'navigation' }),
];
const catalogue = {
  templates: [
    { key: 'campaign-landing', scope: 'dynamic', linkable: ['category', 'seller', 'product'] },
    { key: 'brand-page', scope: 'dynamic', linkable: ['seller', 'category'] },
    { key: 'product-spotlight', scope: 'dynamic', linkable: ['product'] },
    { key: 'info-page', scope: 'dynamic', linkable: [] },
  ],
};
const tree = {
  defaultLocale: 'en-AU',
  categories: [
    { id: 'c1', status: 'active', depth: 0, names: [{ locale: 'en-AU', name: 'Meat' }] },
    { id: 'c2', status: 'active', depth: 1, names: [{ locale: 'en-AU', name: 'Lamb' }] },
  ],
};
const view = window.location.hash.slice(1);
window.fetch = ((input: string) => {
  const path = input.replace(/^\/api\//, '').split('?')[0]!;
  if (view === 'loading') return new Promise<Response>(() => undefined);
  if (view === 'failed') return Promise.resolve(new Response('{}', { status: 500 }));
  const body =
    path === 'storefront/admin/pages'
      ? { pages: view === 'empty' ? [] : pages }
      : path === 'storefront/admin/catalogue'
        ? catalogue
        : path === 'catalog/admin/categories'
          ? tree
          : { code: 'not-found' };
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}) as typeof fetch;

const isNew = view.startsWith('new');
createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <main className="mx-auto max-w-7xl p-4 md:p-6">
      {isNew ? (
        <NewPageFormView csrfToken="tok" zone="Australia/Brisbane" />
      ) : (
        <>
          <h1 className="text-2xl font-semibold">{messages.content.title}</h1>
          <p className="mb-4 text-fg-muted">{messages.content.intro}</p>
          <div className="mb-4">
            <Tabs
              label="Content sections"
              activeId="pages"
              items={[
                { id: 'pages', href: '/content', label: 'Pages' },
                { id: 'slides', href: '/content/slides', label: 'Slides' },
              ]}
            />
          </div>
          <PagesList canEdit={view !== 'readonly'} canCreate zone="Australia/Brisbane" />
        </>
      )}
    </main>
  </NextIntlClientProvider>,
);
