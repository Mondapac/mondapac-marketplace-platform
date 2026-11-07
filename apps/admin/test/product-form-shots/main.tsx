import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { ProductEdit } from '../../src/catalog/product-form/edit-form.tsx';
import type { ProductView } from '../../src/catalog/product-form/types.ts';

const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const PRODUCT = id(1);
const names = (en: string) => ({ en });
const field = (
  code: string,
  name: string,
  dataType: string,
  required: boolean,
  options: [string, string][] = [],
  isVariantOption = false,
) => ({
  code,
  dataType,
  localizable: false,
  required,
  isVariantOption,
  bounds: {},
  names: names(name),
  options: options.map(([c, label]) => ({ code: c, labels: names(label) })),
});
const fields = [
  field('brand', 'Brand', 'select', false, [
    ['tilda', 'Tilda'],
    ['laila', 'Laila'],
  ]),
  field('origin', 'Country of origin', 'select', false, [
    ['in', 'India'],
    ['pk', 'Pakistan'],
  ]),
  field('grain', 'Grain length', 'select', true, [
    ['long', 'Long'],
    ['xl', 'Extra long'],
  ]),
  field('variety', 'Variety', 'text', false),
  field(
    'size',
    'Size',
    'select',
    true,
    [
      ['1kg', '1 kg'],
      ['5kg', '5 kg'],
    ],
    true,
  ),
];
const categories = [
  { categoryId: id(10), parentId: null, names: names('Pantry') },
  { categoryId: id(11), parentId: id(10), names: names('Rice and grains') },
  { categoryId: id(12), parentId: id(11), names: names('Rice') },
  { categoryId: id(13), parentId: id(12), names: names('Basmati rice') },
];
const base: ProductView = {
  productId: PRODUCT,
  productCode: 'MP-004127',
  typeCode: 'grocery',
  familyCode: 'pantry',
  variantModel: 'configurable',
  status: 'draft',
  pausedAt: null,
  offers: { sellerCount: 0, offerCount: 0 },
  variants: [],
  maxVariants: 100,
  lastChangedAt: '2026-11-05T01:00:00.000Z',
  createdAt: '2026-11-05T01:00:00.000Z',
  form: { taxCategoryCodes: ['gst-free-food', 'gst'], fields, categories },
  locales: { default: 'en', supported: ['en'] },
  workingCopy: null,
  published: null,
};
const description =
  'Tilda Sella basmati is an extra-long grain rice, parboiled and aged for two years.\nThe grains stay firm and separate after cooking. Good for biryani and pilaf.';
const filled = {
  texts: { en: { name: 'Sella basmati rice', description } },
  categoryIds: [id(13)],
  taxCategoryCode: 'gst-free-food',
  attributeValues: { brand: 'tilda', origin: 'in', grain: 'xl', variety: 'Sella (parboiled)' },
  variants: [
    { variantId: id(21), optionValues: { size: '1kg' } },
    { variantId: id(22), optionValues: { size: '5kg' } },
  ],
};
const live: ProductView = {
  ...base,
  status: 'published',
  offers: { sellerCount: 3, offerCount: 7 },
  variants: [
    { variantId: id(21), state: 'published' },
    { variantId: id(22), state: 'published' },
  ],
  workingCopy: {
    content: filled,
    lastSavedAt: '2026-11-06T01:00:00.000Z',
    baseRevisionId: id(30),
  },
  published: {
    revisionId: id(30),
    revisionNo: 1,
    submittedAt: '2026-11-03T01:00:00.000Z',
    content: {},
  },
};
const scenarios: Record<string, ProductView> = {
  add: base,
  published: live,
  inactive: { ...live, pausedAt: '2026-10-31T01:00:00.000Z' },
  dialog: live,
  sellers: live,
};

window.fetch = ((input: string, init?: RequestInit) => {
  const path = input.replace(/^\/api\//, '').split('?')[0]!;
  let body: unknown;
  if (path === `catalog/admin/platform-products/${PRODUCT}` && init?.method === 'GET') {
    body = scenarios[scenario];
  } else body = { variantIds: [], refusedFields: [] };
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}) as typeof fetch;

const scenario = new URLSearchParams(location.search).get('s') ?? 'add';
createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <main className="mx-auto max-w-7xl p-4 md:p-6">
      <ProductEdit
        productId={PRODUCT}
        csrfToken="tok"
        marketName="Australia"
        timeZone="Australia/Brisbane"
        canPause
        canReadTags
      />
    </main>
  </NextIntlClientProvider>,
);
