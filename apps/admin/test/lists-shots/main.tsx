import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { BusinessActivitiesView } from '../../src/business-activities/business-activities-view.tsx';
import { ProposalsTab } from '../../src/categories/proposals/proposals-tab.tsx';
import { SuggestionsView } from '../../src/tags/suggestions-view.tsx';
import { TagsView } from '../../src/tags/tags-view.tsx';

const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const q = new URLSearchParams(location.search);
const list = q.get('list') ?? 'tags';
const paged = (items: unknown[], total: number, extra: object = {}) => ({
  items,
  total,
  page: 1,
  pageSize: 25,
  paging: 'pages',
  hasNext: total > items.length,
  ...extra,
});

// Business activities
const activity = (n: number, code: string, name: string, status = 'active') => ({
  id: id(n),
  code,
  status,
  names: { en: name },
  description: n % 2 ? 'Dry goods, rice, oil and spices.' : null,
  categoryIds: Array.from({ length: n }, (_, i) => id(900 + i)),
  createdAt: '2026-10-01T01:00:00.000Z',
  updatedAt: '2026-10-14T01:00:00.000Z',
  version: 3,
  actions: status === 'active' ? ['edit', 'deactivate'] : ['edit'],
});
const activities = paged(
  [
    activity(1, 'grocery', 'Grocery'),
    activity(2, 'butcher', 'Butcher'),
    activity(3, 'bakery', 'Bakery'),
    activity(4, 'cafe', 'Café', 'inactive'),
  ],
  4,
  { locales: { default: 'en', supported: ['en', 'ar'] } },
);

// Tags
const topic = (
  n: number,
  slug: string,
  group: string,
  name: string,
  synonyms: string[],
  status = 'active',
) => ({
  id: id(n),
  slug,
  group,
  status,
  names: { 'en-AU': name },
  synonyms: { 'en-AU': synonyms },
  intro: null,
  createdAt: '2026-11-01T01:00:00.000Z',
  updatedAt: '2026-11-07T01:00:00.000Z',
  version: 2,
  actions: ['edit'],
});
const tags = paged(
  [
    topic(1, 'bbq', 'use', 'BBQ', ['Barbecue', 'Grill', 'Smoker', 'Braai']),
    topic(2, 'ramadan', 'occasion', 'Ramadan', ['Ramazan']),
    topic(3, 'persian-food', 'cuisine', 'Persian food', ['Iranian food', 'Persian cuisine']),
    topic(4, 'eid-al-fitr', 'occasion', 'Eid al-Fitr', [], 'archived'),
    topic(5, 'lunch-box', 'use', 'Lunch box', ['School lunch', 'Packed lunch', 'Bento']),
  ],
  61,
  {
    nextAfterId: null,
    locales: { default: 'en-AU', supported: ['en-AU', 'ar-AU'] },
    groups: ['occasion', 'cuisine', 'use'],
    maxSynonyms: 10,
  },
);

// Tag suggestions
const suggestion = (n: number, label: string, product: string | null) => ({
  id: id(100 + n),
  version: 3,
  label,
  createdAt: `2026-11-0${n}T10:00:00.000Z`,
  sellerId: id(400 + n),
  productId: id(500 + n),
  productCode: product,
  suggestedSlug: label.toLowerCase().replace(/[^a-z]+/g, '-'),
  actions: ['approve', 'map', 'reject'],
});
const suggestions = paged(
  [
    suggestion(1, 'Eid gifts', 'MP-004127'),
    suggestion(2, 'Gluten free', 'MP-003310'),
    suggestion(3, 'Hampers', null),
  ],
  3,
  { requiredLocales: ['en-AU'], locales: { default: 'en-AU', supported: ['en-AU'] } },
);

// Category proposals
const row = (n: number, parent: number | null, depth: number, name: string) => ({
  id: id(n),
  parentId: parent === null ? null : id(parent),
  slug: `c-${n}`,
  status: 'active',
  mergedIntoId: null,
  names: [{ locale: 'en', name }],
  depth,
  position: 0,
  version: 1,
  counts: { liveProducts: 0, liveProductsDirect: 0, offers: 0 },
  featureSetId: null,
  featureSetCode: null,
  featureSetFromCategoryId: null,
  inherited: false,
});
const tree = {
  treeVersion: 7,
  defaultLocale: 'en',
  supportedLocales: ['en', 'fa'],
  requiredLocales: ['en'],
  complete: true,
  categories: [row(1, null, 0, 'Pantry'), row(2, 1, 1, 'Rice'), row(3, 1, 1, 'Spices')],
  actions: {},
};
const proposal = (n: number, store: string, en: string, fa: string, parent: number) => ({
  id: id(200 + n),
  sellerId: id(300 + n),
  platformParentId: id(parent),
  texts: [
    { locale: 'en', name: en, description: n === 1 ? 'Saffron, turmeric and sumac.' : null },
    { locale: 'fa', name: fa, description: null },
  ],
  status: 'pending',
  reasonCode: null,
  sellerCategoryId: null,
  decidedAt: null,
  createdAt: `2026-11-0${n}T01:00:00.000Z`,
  version: 3,
  storeName: store,
  actions: ['approve', 'reject'],
});
const proposals = paged(
  [
    proposal(1, 'Al Noor Grocers', 'Persian spices', 'ادویه ایرانی', 3),
    proposal(2, 'Sunrise Dates', 'Medjool dates', 'خرمای مجول', 1),
    proposal(3, 'Brisbane Halal Meats', 'Lamb cuts', 'برش‌های بره', 1),
  ],
  3,
  { nextAfterId: null },
);

window.fetch = ((input: string) => {
  const path = input.replace(/^\/api\//, '').split('?')[0]!;
  let body: unknown = { code: 'not-found' };
  if (path === 'catalog/admin/business-activities') body = activities;
  else if (path === 'catalog/categories') body = { categories: [] };
  else if (path === 'catalog/admin/topics') body = tags;
  else if (path === 'catalog/admin/topic-suggestions') body = suggestions;
  else if (path === 'catalog/admin/categories') body = tree;
  else if (path === 'catalog/admin/category-proposals') body = proposals;
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}) as typeof fetch;

const where = { paging: 'pages', accountId: id(99), marketId: 'AU' } as const;
const zoned = { ...where, zone: 'Australia/Brisbane' } as const;
const view =
  list === 'activities' ? (
    <BusinessActivitiesView canEdit csrfToken="tok" {...zoned} />
  ) : list === 'suggestions' ? (
    <SuggestionsView csrfToken="tok" {...where} />
  ) : list === 'proposals' ? (
    <ProposalsTab csrfToken="tok" canPromote {...where} />
  ) : (
    <TagsView canManage csrfToken="tok" {...zoned} />
  );
const title =
  list === 'activities'
    ? messages['business-activities'].title
    : list === 'proposals'
      ? messages.categories.proposals.list.title
      : list === 'suggestions'
        ? null
        : messages.tags.title;
createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <main className="mx-auto max-w-7xl p-4 md:p-6">
      {title === null ? null : <h1 className="mb-4 text-2xl font-semibold">{title}</h1>}
      {view}
    </main>
  </NextIntlClientProvider>,
);
