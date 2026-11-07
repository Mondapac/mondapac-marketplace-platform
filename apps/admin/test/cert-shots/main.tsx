import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { ProductEdit } from '../../src/catalog/product-form/edit-form.tsx';

const P = '0190a000-0000-7000-8000-0000000000c1';
const T = (n: number) => `0190a000-0000-7000-8000-0000000000a${n}`;
const V = (n: number) => `0190a000-0000-7000-8000-0000000000e${n}`;
const day = (offset: number) => {
  const at = new Date();
  at.setDate(at.getDate() + offset);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
};
const axis = (code: string, name: string, options: [string, string][]) => ({
  code,
  dataType: 'select',
  localizable: false,
  required: true,
  isVariantOption: true,
  bounds: {},
  names: { en: name },
  options: options.map(([option, label]) => ({ code: option, labels: { en: label } })),
});
const product = {
  productId: P,
  productCode: 'MP-004127',
  typeCode: 'configurable',
  familyCode: 'default',
  variantModel: 'configurable',
  status: 'published',
  variants: [1, 2, 3, 4].map((n) => ({ variantId: V(n), state: 'published' })),
  maxVariants: 100,
  lastChangedAt: '2026-11-05T01:00:00.000Z',
  createdAt: '2026-11-05T01:00:00.000Z',
  form: {
    taxCategoryCodes: ['gst'],
    fields: [
      axis('grain', 'Grain', [
        ['white', 'White'],
        ['brown', 'Brown'],
      ]),
      axis('pack', 'Pack size', [
        ['kg1', '1 kg'],
        ['kg5', '5 kg'],
      ]),
    ],
    categories: [{ categoryId: 'cat-1', parentId: null, names: { en: 'Basmati rice' } }],
  },
  locales: { default: 'en', supported: ['en'] },
  workingCopy: {
    content: { texts: { en: { name: 'Sella basmati rice', description: 'Extra long grain.' } } },
    lastSavedAt: '2026-11-05T01:00:00.000Z',
    baseRevisionId: 'rev-1',
  },
  published: {
    revisionId: 'rev-1',
    revisionNo: 1,
    submittedAt: '2026-11-05T01:00:00.000Z',
    content: {
      texts: { en: { name: 'Sella basmati rice' } },
      categoryIds: ['cat-1'],
      variants: [
        { variantId: V(1), optionValues: { grain: 'white', pack: 'kg1' } },
        { variantId: V(2), optionValues: { grain: 'white', pack: 'kg5' } },
        { variantId: V(3), optionValues: { grain: 'brown', pack: 'kg1' } },
        { variantId: V(4), optionValues: { grain: 'brown', pack: 'kg5' } },
      ],
    },
  },
};
const item = (n: number, over: Record<string, unknown>) => ({
  id: `0190a000-0000-7000-8000-0000000000f${n}`,
  typeId: T(n),
  typeCode: 'x',
  typeName: 'Halal',
  typeNamesMissing: [],
  status: 'approved',
  issuerName: 'Halal Australia',
  expiryDate: day(400),
  coverage: { whole: true, variantIds: [] },
  rejectionReasonCode: null,
  lastChangedAt: '2026-11-05T01:00:00.000Z',
  version: 3,
  ...over,
});
const mixed = [
  item(1, { typeNamesMissing: ['fa-AU', 'ar-AU'] }),
  item(2, {
    typeName: 'Vegan',
    issuerName: 'Vegan Australia',
    status: 'in-review',
    expiryDate: '2027-01-12',
    coverage: { whole: false, variantIds: [V(1), V(3)] },
  }),
  item(3, { typeName: 'Kosher', issuerName: 'Kashrut Authority', expiryDate: day(2) }),
  item(4, { typeName: 'Organic', issuerName: 'Australian Certified Organic', status: 'draft' }),
  item(5, {
    typeName: 'Gluten free',
    issuerName: 'Coeliac Australia',
    status: 'rejected',
    rejectionReasonCode: 'number-mismatch',
  }),
  item(6, {
    typeName: 'Fair trade',
    issuerName: 'Fairtrade ANZ',
    status: 'expired',
    expiryDate: day(-5),
  }),
];
const options = {
  types: [
    {
      typeId: T(1),
      code: 'halal',
      name: 'Halal',
      requiresDocument: true,
      requiresExpiry: true,
      requiresIssuerRegistry: false,
      issuers: [
        { issuerId: 'i1', displayName: 'Halal Australia' },
        { issuerId: 'i2', displayName: 'Australian Halal Authority' },
      ],
    },
    {
      typeId: T(2),
      code: 'vegan',
      name: 'Vegan',
      requiresDocument: true,
      requiresExpiry: false,
      requiresIssuerRegistry: false,
      issuers: [],
    },
  ],
};
const record = {
  id: mixed[4]!.id,
  typeId: T(5),
  status: 'rejected',
  version: 5,
  author: { accountId: 'a-1' },
  draft: {
    manufacturerName: 'Tilda Ltd',
    issuerId: 'i1',
    certificateNumberSet: true,
    issueDate: '2026-01-15',
    expiryDate: '2027-06-30',
    coverage: [],
    documents: [],
  },
  pending: null,
  approved: {
    manufacturerName: 'Tilda Ltd',
    issuerId: 'i1',
    issueDate: '2026-01-15',
    expiryDate: '2027-06-30',
    coverage: [],
    documents: [{ documentId: 'd1', mediaType: 'application/pdf', byteSize: 421888 }],
  },
};
const history = {
  entries: [
    {
      id: 'h3',
      fromStatus: 'in-review',
      toStatus: 'rejected',
      actor: { accountId: 'r-1' },
      reasonCode: 'number-mismatch',
      occurredAt: new Date(Date.now() - 86_400_000).toISOString(),
    },
    {
      id: 'h2',
      fromStatus: 'draft',
      toStatus: 'in-review',
      actor: { accountId: 'a-1' },
      reasonCode: null,
      occurredAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    },
    {
      id: 'h1',
      fromStatus: null,
      toStatus: 'draft',
      actor: { accountId: 'a-1' },
      reasonCode: null,
      occurredAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    },
  ],
};

const q = new URLSearchParams(location.search);
const scene = q.get('scene') ?? 'list';
const keys = ['certification.product-certificate.view', 'certification.product-certificate.edit'];
window.fetch = ((input: string) => {
  const path = input.replace(/^\/api\//, '').split('?')[0]!;
  let body: unknown = { code: 'not-found' };
  let status = 404;
  const set = (value: unknown) => {
    body = value;
    status = 200;
  };
  if (path === `catalog/admin/platform-products/${P}`) set(product);
  else if (path === `certification/admin/product-certificates/for-product/${P}`)
    set({ items: scene === 'empty' ? [] : mixed });
  else if (path.endsWith('/options')) set(options);
  else if (path.endsWith('/history')) set(history);
  else if (path.startsWith('certification/admin/product-certificates/')) set(record);
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}) as typeof fetch;

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <main className="mx-auto max-w-7xl p-4 md:p-6">
      <ProductEdit productId={P} csrfToken="tok" permissionKeys={keys} marketName="Australia" />
    </main>
  </NextIntlClientProvider>,
);
