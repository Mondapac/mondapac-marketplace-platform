import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { EditForm } from '../../src/catalog/edit-form.tsx';
import type { ProductView, TopicChoice, TopicRef } from '../../src/catalog/types.ts';

const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const names = (en: string) => ({ 'en-AU': en });
const ref = (n: number, name: string, status: TopicRef['status'] = 'active'): TopicRef => ({
  id: id(100 + n),
  slug: `tag-${n}`,
  status,
  name,
  names: names(name),
});
const choice = (n: number, name: string, group: TopicChoice['group']): TopicChoice => ({
  id: id(100 + n),
  slug: `tag-${n}`,
  group,
  name,
  names: names(name),
});
// The active tags the picker offers.
const CHOICES: TopicChoice[] = [
  choice(1, 'Eid', 'occasion'),
  choice(2, 'Barbecue', 'cuisine'),
  choice(3, 'Picnic', 'use'),
  choice(4, 'Ramadan gifts', 'occasion'),
  choice(5, 'Lunch box', 'use'),
  choice(6, 'Middle Eastern', 'cuisine'),
  choice(7, 'Breakfast', 'use'),
  choice(8, 'Weekend feast', 'occasion'),
];
const product: ProductView = {
  productId: id(1),
  productCode: 'MP-004127',
  typeCode: 'grocery',
  familyCode: 'pantry',
  variantModel: 'single',
  status: 'published',
  pausedAt: null,
  variants: [{ variantId: id(21), state: 'published' }],
  maxVariants: 100,
  sensitiveFields: ['platform-categories', 'tax-category', 'name', 'topics', 'images'],
  lastChangedAt: '2026-11-05T01:00:00.000Z',
  createdAt: '2026-11-05T01:00:00.000Z',
  pendingSubmittedAt: null,
  form: {
    taxCategoryCodes: ['gst-free-food', 'gst'],
    units: [],
    fields: [],
    categories: [
      { categoryId: id(10), parentId: null, names: names('Pantry') },
      { categoryId: id(11), parentId: id(10), names: names('Rice') },
    ],
  },
  workingCopy: {
    content: {
      texts: {
        'en-AU': {
          name: 'Sella basmati rice',
          description: 'Extra-long grain rice, parboiled and aged for two years.',
        },
      },
      categoryIds: [id(11)],
      taxCategoryCode: 'gst-free-food',
      topicIds: [id(101), id(102), id(150), id(199)],
    },
    lastSavedAt: '2026-11-05T01:00:00.000Z',
    baseRevisionId: null,
  },
  published: {
    revisionId: id(90),
    revisionNo: 1,
    submittedAt: '2026-11-04T01:00:00.000Z',
    authorKind: 'seller',
    sensitive: false,
    sensitiveReasons: [],
    content: {},
  },
  pending: null,
  topicRefs: [ref(1, 'Eid'), ref(2, 'Barbecue'), ref(50, 'Ramadan special offers', 'archived')],
};

const scenario = new URLSearchParams(location.search).get('s') ?? 'form';
window.fetch = ((input: string) => {
  const url = new URL(input, 'http://x');
  const path = url.pathname.replace(/^\/api\//, '');
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));
  if (path === 'catalog/seller/topics') {
    const term = (url.searchParams.get('search') ?? '').toLowerCase();
    const items = CHOICES.filter((item) => item.name!.toLowerCase().includes(term));
    return json({ items, nextAfterId: null, maxPerProduct: 10 });
  }
  if (path.endsWith('/submit') && scenario === 'error') {
    return json(
      {
        statusCode: 422,
        code: 'revision.not-ready',
        details: {
          issues: [
            { path: 'topicIds.2', code: 'archived' },
            { path: 'topicIds.3', code: 'unknown' },
          ],
        },
      },
      422,
    );
  }
  return json({ variantIds: [id(21)], refusedFields: [] });
}) as typeof fetch;

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <main className="mx-auto max-w-7xl p-4 md:p-6">
      <EditForm
        product={product}
        photos={[]}
        locales={['en-AU']}
        defaultLocale="en-AU"
        marketName="Australia"
        csrfToken="tok"
      />
    </main>
  </NextIntlClientProvider>,
);
