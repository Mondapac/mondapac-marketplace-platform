import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { CategoryPageView } from '../../src/categories/category-page-view.tsx';

const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number, parent: number | null, depth: number, name: string, status = 'active') => ({
  id: id(n),
  parentId: parent === null ? null : id(parent),
  slug: `c-${n}`,
  status,
  mergedIntoId: null,
  names: [{ locale: 'en', name }],
  depth,
  position: n,
  version: 3,
  counts: { liveProducts: 0, liveProductsDirect: 0, offers: 0 },
});
const rows = [
  row(1, null, 0, 'Pantry'),
  row(2, 1, 1, 'Rice'),
  row(3, 1, 1, 'Oils', 'hidden'),
  row(5, 2, 2, 'Basmati'),
  row(4, null, 0, 'Drinks'),
];
const tree = {
  treeVersion: 7,
  defaultLocale: 'en',
  supportedLocales: ['en', 'fa'],
  requiredLocales: ['en'],
  complete: true,
  categories: rows,
  actions: {},
};
const detail = (r: (typeof rows)[number]) => ({
  category: r,
  path: [{ id: r.id, slug: r.slug, name: r.names[0]!.name }],
  requiredLocales: ['en'],
  missingLocales: [],
  revisions: [],
  complete: true,
  actions: {},
  details: {
    texts: [{ locale: 'en', name: r.names[0]!.name, shortDescription: null, keywords: [] }],
    seo: { title: null, description: null, noindex: false },
    showInMenu: true,
    imageId: null,
    hiddenById: null,
  },
  treeVersion: 7,
});
window.fetch = ((input: string) => {
  const url = input;
  const hit = rows.find((r) => url.endsWith(r.id));
  const body = hit ? detail(hit) : tree;
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}) as typeof fetch;

const target = Number(new URLSearchParams(location.search).get('n') ?? '2');
createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en" messages={messages}>
    <div className="mx-auto max-w-3xl p-4">
      <CategoryPageView id={id(target)} canEdit csrfToken="tok" />
    </div>
  </NextIntlClientProvider>,
);
