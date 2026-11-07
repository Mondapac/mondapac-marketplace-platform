import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { ProductEdit } from '../../src/catalog/product-form/edit-form.tsx';

const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const PRODUCT = id(1);
const q = new URLSearchParams(location.search);
const count = Number(q.get('images') ?? '0');
const library = Array.from({ length: count }, (_, n) => ({
  imageId: id(100 + n),
  width: 1600,
  height: 1200,
  createdAt: '2026-11-07T10:00:00Z',
}));
// The last photo stays out of the draft when asked, to show "Not in product".
const inDraft = q.get('outside') === '1' ? library.slice(0, -1) : library;
const view = {
  productId: PRODUCT,
  productCode: 'P00000001',
  typeCode: 'simple',
  familyCode: 'default',
  variantModel: 'single',
  status: 'draft',
  variants: [{ variantId: id(9), state: 'proposed' }],
  maxVariants: 100,
  lastChangedAt: '2026-11-05T01:00:00.000Z',
  createdAt: '2026-11-05T01:00:00.000Z',
  form: {
    taxCategoryCodes: ['gst-free', 'gst'],
    fields: [],
    categories: [{ categoryId: id(50), parentId: null, names: { en: 'Pantry' } }],
  },
  locales: { default: 'en', supported: ['en'] },
  workingCopy: {
    content: {
      texts: {
        en: {
          name: 'Sella basmati rice 5 kg',
          description: 'Long grain rice, parboiled so the grains stay separate.',
        },
      },
      categoryIds: [id(50)],
      taxCategoryCode: 'gst-free',
      imageIds: inDraft.map((image) => image.imageId),
    },
    lastSavedAt: '2026-11-05T01:00:00.000Z',
    baseRevisionId: null,
  },
  published: null,
};

window.fetch = ((input: string, init?: RequestInit) => {
  const path = input.replace(/^\/api\//, '').split('?')[0]!;
  if (init?.method === 'POST' && path.endsWith('/images')) {
    // `post=hang` keeps the upload in flight; `post=fail` refuses it as not an image.
    if (q.get('post') === 'hang') return new Promise<Response>(() => undefined);
    return Promise.resolve(
      new Response(JSON.stringify({ statusCode: 415, code: 'file.unsupported-type' }), {
        status: 415,
      }),
    );
  }
  let body: unknown = { code: 'not-found' };
  if (path === `catalog/admin/platform-products/${PRODUCT}`) body = view;
  else if (path === `catalog/admin/platform-products/${PRODUCT}/images`) body = { images: library };
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}) as typeof fetch;

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <main className="mx-auto max-w-7xl p-4 md:p-6">
      <ProductEdit
        productId={PRODUCT}
        csrfToken="tok"
        marketName="Australia"
        timeZone="Australia/Brisbane"
        canPause
      />
    </main>
  </NextIntlClientProvider>,
);
