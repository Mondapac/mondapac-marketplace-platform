import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { VariantsView } from '../../src/variants/variants-view.tsx';

const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const hex = (d: string) => `#${d}`;
const langs = (missingName: boolean, missing: number) => [
  { locale: 'en-AU', nameMissing: false, optionsMissing: 0 },
  { locale: 'ar-AU', nameMissing: missingName, optionsMissing: missing },
];
const type = (
  n: number,
  code: string,
  name: string,
  style: string,
  opts: number,
  products: number,
  live: number,
  lang: ReturnType<typeof langs>,
) => ({
  id: id(n),
  code,
  status: 'active',
  names: { 'en-AU': name, ...(lang[1]!.nameMissing ? {} : { 'ar-AU': name }) },
  displayStyle: style,
  optionOrder: 'manual',
  options: opts,
  products,
  liveVariants: live,
  featureSets: [{ id: id(90 + n), code: 'pantry', names: { 'en-AU': 'Pantry staples' } }],
  languages: lang,
});
const types = [
  type(1, 'pack-size', 'Pack size', 'buttons', 4, 412, 1031, langs(false, 0)),
  type(2, 'colour', 'Colour', 'swatches', 3, 58, 140, langs(false, 2)),
  type(3, 'flavour', 'Flavour', 'dropdown', 6, 33, 71, langs(true, 6)),
];
const opt = (
  code: string,
  label: string,
  pos: number,
  swatch: string | null,
  products: number,
  active = true,
) => ({
  code,
  labels: { 'en-AU': label, 'ar-AU': label },
  active,
  position: pos,
  swatch,
  products,
});
const details: Record<string, unknown> = {
  [id(1)]: {
    ...types[0],
    optionList: [
      opt('g250', '250 g', 0, null, 96),
      opt('g500', '500 g', 1, null, 140),
      opt('kg1', '1 kg', 2, null, 122),
      opt('kg5', '5 kg', 3, null, 54, false),
    ],
    sellerHelp: { 'en-AU': 'Choose the net weight printed on the pack.' },
    settingsVersion: 2,
  },
  [id(2)]: {
    ...types[1],
    optionList: [
      opt('red', 'Red', 0, hex('B42318'), 20),
      opt('green', 'Green', 1, hex('067647'), 22),
      opt('navy', 'Navy', 2, null, 16),
    ],
    sellerHelp: {},
    settingsVersion: 5,
  },
};
const row = (
  n: number,
  code: string,
  name: string,
  label: string,
  gtin: string | null,
  sellers: number,
  issues: string[],
  status = 'live',
) => ({
  productId: id(100 + n),
  productCode: code,
  productName: name,
  productScope: 'PLATFORM',
  status,
  variantId: id(200 + n),
  variantNo: 2,
  variantCode: `${code}-0${(n % 9) + 1}`,
  label,
  labels: { 'en-AU': label },
  gtin,
  sellers,
  issues,
  missingLocales: [],
});
const page = {
  items: [
    row(1, 'MP-004127', 'Sella basmati rice', '5 kg', '09300633012345', 0, [
      'no-seller-selling',
      'duplicate-gtin',
    ]),
    row(2, 'MP-004127', 'Sella basmati rice', '1 kg', '09300633012352', 3, []),
    row(3, 'MP-003310', 'Extra virgin olive oil', '750 ml', null, 2, ['missing-gtin', 'no-image']),
    row(4, 'MP-002208', 'Medjool dates', '500 g', '09312345678904', 1, ['missing-language']),
    row(5, 'MP-001954', 'Chickpeas, dried', '2 kg', '09300633099995', 4, [], 'paused'),
    row(6, 'MP-001020', 'Saffron threads', '1 g', null, 0, ['no-seller-selling', 'missing-gtin']),
  ],
  nextAfter: id(206),
};
const counts = {
  counts: {
    'no-seller-selling': 17,
    'missing-gtin': 388,
    'duplicate-gtin': 3,
    'no-image': 61,
    'missing-language': 24,
  },
};
window.fetch = ((input: string) => {
  const path = input.replace(/^\/api\//, '').split('?')[0]!;
  let body: unknown = { code: 'not-found' };
  if (path === 'catalog/admin/variant-types') body = { items: types };
  else if (path.startsWith('catalog/admin/variant-types/'))
    body = { variantType: details[path.split('/').pop()!] };
  else if (path === 'catalog/admin/variants') body = page;
  else if (path === 'catalog/admin/variants/issue-counts') body = counts;
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}) as typeof fetch;

const q = new URLSearchParams(location.search);
const tab = q.get('tab') === 'variants' ? 'variants' : 'types';
createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <main className="mx-auto max-w-7xl p-4 md:p-6">
      <h1 className="text-2xl font-semibold">{messages.variants.title}</h1>
      <VariantsView
        canEdit={q.get('edit') !== '0'}
        canOpenAttributes
        csrfToken="tok"
        initialTab={tab}
        initialId={tab === 'types' ? id(Number(q.get('id') ?? '1')) : null}
      />
    </main>
  </NextIntlClientProvider>,
);
