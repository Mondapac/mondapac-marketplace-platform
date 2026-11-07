import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { EditForm } from '../../src/catalog/edit-form.tsx';
import type { ProductView } from '../../src/catalog/types.ts';

const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const names = (en: string) => ({ 'en-AU': en });
const field = (
  code: string,
  name: string,
  dataType: string,
  required: boolean,
  options: [string, string][] = [],
) => ({
  code,
  dataType,
  localizable: false,
  required,
  isVariantOption: false,
  bounds: {},
  names: names(name),
  options: options.map(([c, label]) => ({ code: c, labels: names(label) })),
});
const product: ProductView = {
  productId: id(1),
  productCode: 'MP-004127',
  typeCode: 'grocery',
  familyCode: 'pantry',
  variantModel: 'single',
  status: 'draft',
  pausedAt: null,
  variants: [{ variantId: id(21), state: 'proposed' }],
  maxVariants: 100,
  sensitiveFields: [],
  lastChangedAt: '2026-11-05T01:00:00.000Z',
  createdAt: '2026-11-05T01:00:00.000Z',
  pendingSubmittedAt: null,
  form: {
    taxCategoryCodes: ['gst-free-food', 'gst'],
    units: [],
    fields: [
      field('origin', 'Country of origin', 'select', false, [
        ['in', 'India'],
        ['pk', 'Pakistan'],
      ]),
      field('grain', 'Grain length', 'select', true, [
        ['long', 'Long'],
        ['xl', 'Extra long'],
      ]),
    ],
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
        ar: { name: 'أرز' },
      },
      categoryIds: [id(11)],
      taxCategoryCode: 'gst-free-food',
      attributeValues: { origin: 'in' },
    },
    lastSavedAt: '2026-11-05T01:00:00.000Z',
    baseRevisionId: null,
  },
  published: null,
  pending: null,
};
window.fetch = () => Promise.resolve(new Response(JSON.stringify({ images: [] }), { status: 200 }));
const scenario = new URLSearchParams(location.search).get('s') ?? 'edit';
const shown: ProductView =
  scenario === 'paused'
    ? {
        ...product,
        status: 'published',
        pausedAt: '2026-11-01T01:00:00.000Z',
        published: {
          revisionId: id(90),
          revisionNo: 1,
          submittedAt: '2026-11-04T01:00:00.000Z',
          authorKind: 'seller',
          sensitive: false,
          sensitiveReasons: [],
          content: product.workingCopy?.content ?? {},
        },
      }
    : product;
createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <main className="mx-auto max-w-7xl p-4 md:p-6">
      <EditForm
        product={shown}
        photos={[]}
        locales={['en-AU', 'ar']}
        defaultLocale="en-AU"
        marketName="Australia"
        csrfToken="tok"
      />
    </main>
  </NextIntlClientProvider>,
);
