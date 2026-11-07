// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { CertificationsSection } from './certifications-section.tsx';
import { ProductEdit } from './edit-form.tsx';
import {
  daysUntil,
  publishedVariants,
  reasonKey,
  statusOf,
  type CertListItem,
} from './certificate-types.ts';
import type { ProductView } from './types.ts';

const call = vi.mocked(callApi);
const PRODUCT = '0190a000-0000-7000-8000-0000000000c1';
const CERT_BASE = 'certification/admin/product-certificates';
const TYPE_HALAL = '0190a000-0000-7000-8000-0000000000a1';
const TYPE_VEGAN = '0190a000-0000-7000-8000-0000000000a2';
const TYPE_KOSHER = '0190a000-0000-7000-8000-0000000000a3';
const ISSUER = '0190a000-0000-7000-8000-0000000000b1';
const NEW_CERT = '0190a000-0000-7000-8000-0000000000f1';
const DRAFT_CERT = '0190a000-0000-7000-8000-0000000000f2';
const V = (n: number) => `0190a000-0000-7000-8000-0000000000e${n}`;
const VIEW = 'certification.product-certificate.view';
const EDIT = 'certification.product-certificate.edit';
const TYPES = 'certification.type.view';

const ok = <T,>(body: T) => ({ ok: true as const, status: 200, body });
const fail = (status: number, code: string) => ({
  ok: false as const,
  failure: { status, code },
});

/** A local date `days` from today, as YYYY-MM-DD (what the API sends for a date). */
function dayFromNow(days: number): string {
  const at = new Date();
  at.setDate(at.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

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

/** A published two-axis product: Grain (White, Brown) x Pack (1 kg, 5 kg), four variants. */
const product = (over: Partial<ProductView> = {}): ProductView => ({
  productId: PRODUCT,
  productCode: 'P00000001',
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
  workingCopy: null,
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
  ...over,
});

/** The same product with another published content (the view is read-only). */
const withContent = (view: ProductView, content: Record<string, unknown>): ProductView => ({
  ...view,
  published: { ...view.published!, content },
});

const item = (over: Partial<CertListItem> = {}): CertListItem => ({
  id: NEW_CERT,
  typeId: TYPE_HALAL,
  typeCode: 'halal',
  typeName: 'Halal',
  typeNamesMissing: [],
  status: 'approved',
  issuerName: 'Halal Australia',
  expiryDate: dayFromNow(400),
  coverage: { whole: true, variantIds: [] },
  rejectionReasonCode: null,
  lastChangedAt: '2026-11-05T01:00:00.000Z',
  version: 3,
  ...over,
});

const OPTIONS = {
  types: [
    {
      typeId: TYPE_HALAL,
      code: 'halal',
      name: 'Halal',
      requiresDocument: true,
      requiresExpiry: true,
      requiresIssuerRegistry: false,
      issuers: [{ issuerId: ISSUER, displayName: 'Halal Australia' }],
    },
    {
      typeId: TYPE_VEGAN,
      code: 'vegan',
      name: 'Vegan',
      requiresDocument: true,
      requiresExpiry: false,
      requiresIssuerRegistry: false,
      issuers: [],
    },
  ],
};

interface Setup {
  list?: CertListItem[];
  listAfterSend?: CertListItem[];
  options?: typeof OPTIONS;
  record?: unknown;
  history?: unknown;
  /** Per route, results in order; the last one repeats. */
  routes?: Record<string, ReturnType<typeof ok | typeof fail>[]>;
}

/** Answers the certificate routes from a table; every call is kept in `call.mock.calls`. */
function serve(setup: Setup = {}) {
  const used: Record<string, number> = {};
  // The record version the server holds: each write moves it on by one.
  let version = 0;
  call.mockImplementation((async (method: string, path: string) => {
    await Promise.resolve();
    const key = `${method} ${path}`;
    const scripted = setup.routes?.[key];
    if (scripted !== undefined) {
      const at = Math.min(used[key] ?? 0, scripted.length - 1);
      used[key] = (used[key] ?? 0) + 1;
      return scripted[at];
    }
    if (key === `GET ${CERT_BASE}/for-product/${PRODUCT}`) {
      const sent = call.mock.calls.some(([m, p]) => p.endsWith('/submit') && m === 'POST');
      return ok({ items: sent ? (setup.listAfterSend ?? setup.list ?? []) : (setup.list ?? []) });
    }
    if (key === `GET ${CERT_BASE}/options`) return ok(setup.options ?? OPTIONS);
    if (key.startsWith('GET') && key.endsWith('/history'))
      return ok(setup.history ?? { entries: [] });
    if (key.startsWith(`GET ${CERT_BASE}/`)) return ok(setup.record);
    if (key === `POST ${CERT_BASE}`) {
      version = 1;
      return ok({ certificateId: NEW_CERT, version });
    }
    if (method !== 'GET' && key.startsWith(`${method} ${CERT_BASE}/`)) {
      version += 1;
      return ok({ certificateId: NEW_CERT, documentId: 'doc-1', coverageEntries: 1, version });
    }
    return fail(404, 'not-found');
  }) as unknown as typeof callApi);
}

function mount(
  keys: readonly string[] = [VIEW, EDIT],
  view: ProductView = product(),
  extra: Partial<React.ComponentProps<typeof CertificationsSection>> = {},
) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <CertificationsSection
        product={view}
        csrfToken="csrf-1"
        permissionKeys={keys}
        marketName="Australia"
        justPublished={false}
        onReload={vi.fn()}
        {...extra}
      />
    </NextIntlClientProvider>,
  );
}

const sent = (suffix: string) =>
  call.mock.calls.filter(([, path]) => typeof path === 'string' && path.endsWith(suffix));
/** The certificate dialog: the first <dialog> in the page (the details drawer comes after it). */
/** Whether the certificate dialog is open (it is removed from the page once closed). */
const dialogOpen = (): boolean =>
  document.body.querySelectorAll('dialog')[0]?.hasAttribute('open') === true;
const dialog = (): HTMLElement => document.body.querySelectorAll('dialog')[0] as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  call.mockReset();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe('who sees the card', () => {
  it('is absent without the view key and makes no call', () => {
    serve();
    const view = mount([EDIT]);
    expect(view.container.textContent).toBe('');
    expect(call).not.toHaveBeenCalled();
  });

  it('says to publish first when the product has no published revision, without an Add button', () => {
    serve();
    mount([VIEW, EDIT], product({ published: null, status: 'draft' }));
    expect(screen.getByRole('heading', { name: 'Product certifications' })).toBeTruthy();
    expect(screen.getByText('Publish the product first, then add its certificates.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Add certificate/ })).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('hides Add and Finish and send (not disables) without the edit key', async () => {
    serve({ list: [item({ id: DRAFT_CERT, status: 'draft' })] });
    mount([VIEW]);
    await screen.findByRole('table', { name: 'Product certificates' });
    expect(screen.queryByRole('button', { name: /Add certificate/ })).toBeNull();
    expect(screen.queryByText('Finish and send')).toBeNull();
    expect(screen.getByText('Draft')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Halal certificate' }));
    expect(screen.getAllByRole('menuitem').map((entry) => entry.textContent)).toEqual([
      'View details',
    ]);
  });
});

describe('the list', () => {
  it('shows the empty state with the helper text, Add, and the info banner', async () => {
    serve({ list: [] });
    mount();
    expect(await screen.findByText('No product certificates yet')).toBeTruthy();
    expect(screen.getByText('Add one if the manufacturer certified this product.')).toBeTruthy();
    expect(
      screen.getByText(
        'Certificates the manufacturer holds for this exact product, e.g. Halal, Vegan or Kosher. Each one is checked by a certification reviewer before sellers can use it.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /Add certificate/ })).toBeTruthy();
    expect(screen.getByText('Badges stay on seller offers')).toBeTruthy();
    expect(
      screen.getByText(/only where Basmati rice allows a manufacturer certificate/),
    ).toBeTruthy();
    expect(call.mock.calls[0]?.slice(0, 2)).toEqual(['GET', `${CERT_BASE}/for-product/${PRODUCT}`]);
  });

  it('words every status and never shows a number, an id or a raw reason code', async () => {
    serve({
      list: [
        item({ id: 'c1', typeCode: 'halal', typeName: 'Halal' }),
        item({
          id: 'c2',
          typeId: TYPE_VEGAN,
          typeName: 'Vegan',
          status: 'in-review',
          issuerName: 'Vegan Australia',
          coverage: { whole: false, variantIds: [V(1), V(2)] },
        }),
        item({ id: 'c3', typeId: TYPE_KOSHER, typeName: 'Kosher', status: 'draft' }),
        item({ id: 'c4', typeName: 'Soy free', typeId: 'x4', expiryDate: dayFromNow(5) }),
        item({ id: 'c5', typeName: 'Gluten free', typeId: 'x5', expiryDate: dayFromNow(30) }),
        item({ id: 'c6', typeName: 'Organic', typeId: 'x6', expiryDate: dayFromNow(1) }),
        item({ id: 'c7', typeName: 'Fair trade', typeId: 'x7', expiryDate: dayFromNow(0) }),
        item({ id: 'c8', typeName: 'Nut free', typeId: 'x8', status: 'suspended' }),
        item({ id: 'c9', typeName: 'Dairy free', typeId: 'x9', status: 'revoked' }),
        item({
          id: 'ca',
          typeName: 'Egg free',
          typeId: 'xa',
          status: 'expired',
          expiryDate: dayFromNow(-3),
        }),
        item({
          id: 'cb',
          typeName: 'Lupin free',
          typeId: 'xb',
          status: 'rejected',
          rejectionReasonCode: 'secret-internal-code',
        }),
      ],
    });
    mount();
    const table = await screen.findByRole('table', { name: 'Product certificates' });
    const body = within(table);
    expect(body.getByText('Approved')).toBeTruthy();
    expect(body.getByText('Waiting for review')).toBeTruthy();
    expect(body.getByText('Draft')).toBeTruthy();
    expect(body.getByText('Expires in 5 days')).toBeTruthy();
    expect(body.getByText('Expires in 30 days')).toBeTruthy();
    expect(body.getByText('Expires tomorrow')).toBeTruthy();
    expect(body.getByText('Expires today')).toBeTruthy();
    expect(body.getByText('Suspended')).toBeTruthy();
    expect(body.getByText('Revoked')).toBeTruthy();
    expect(body.getByText('Expired')).toBeTruthy();
    expect(body.getByText('Rejected')).toBeTruthy();
    // Covers: whole, some of the four, the table header names.
    expect(body.getAllByText('All variants').length).toBeGreaterThan(0);
    expect(body.getByText('2 of 4 variants')).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Certificate',
      'Expires',
      'Covers',
      'Status',
      'Actions',
    ]);
    // Never the raw code, an id, or a "Number" column.
    expect(document.body.textContent).not.toContain('secret-internal-code');
    expect(document.body.textContent).not.toContain(NEW_CERT);
    expect(screen.queryByRole('columnheader', { name: 'Number' })).toBeNull();
  });

  it('tints and words an expiring row; the date text carries the attention colour', async () => {
    serve({ list: [item({ expiryDate: dayFromNow(2) })] });
    mount();
    expect(await screen.findByText('Expires in 2 days')).toBeTruthy();
    const row = screen.getByText('Expires in 2 days').closest('tr');
    expect(row?.className).toContain('bg-attention-bg');
  });

  it('shows a Draft badge and a Finish and send link, also in the row menu', async () => {
    serve({ list: [item({ id: DRAFT_CERT, status: 'draft' })] });
    mount();
    const link = await screen.findByRole('button', { name: 'Finish and send' });
    expect(link).toBeTruthy();
    expect(screen.getByText('Draft')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Halal certificate' }));
    expect(screen.getAllByRole('menuitem').map((entry) => entry.textContent)).toEqual([
      'Finish and send',
      'View details',
    ]);
  });

  it('shows "Whole product" for a one-size product', async () => {
    serve({ list: [item()] });
    let one = product({
      variantModel: 'single',
      variants: [{ variantId: V(1), state: 'published' }],
    });
    one = withContent(one, { texts: { en: { name: 'Salt' } } });
    mount([VIEW, EDIT], one);
    expect(await screen.findByText('Whole product')).toBeTruthy();
    expect(screen.queryByText('All variants')).toBeNull();
  });

  it('captions a full page of 100 and offers a retry when the list fails', async () => {
    serve({
      list: Array.from({ length: 100 }, (_, n) => item({ id: `c${n}`, typeId: `t${n}` })),
    });
    mount();
    expect(await screen.findByText('Showing the latest 100')).toBeTruthy();
    cleanup();
    call.mockReset();
    serve({
      routes: { [`GET ${CERT_BASE}/for-product/${PRODUCT}`]: [fail(500, 'x'), ok({ items: [] })] },
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No product certificates yet')).toBeTruthy();
  });
});

describe('banners', () => {
  it('shows rejected (with a sentence), expired and missing-names banners inside the card, Critical first', async () => {
    serve({
      list: [
        item({
          id: 'r1',
          typeId: TYPE_VEGAN,
          typeName: 'Vegan',
          status: 'rejected',
          rejectionReasonCode: 'number-mismatch',
        }),
        item({
          id: 'e1',
          typeId: TYPE_KOSHER,
          typeName: 'Kosher',
          status: 'expired',
          expiryDate: '2026-11-02',
        }),
        item({ id: 'a1', typeNamesMissing: ['fa-AU', 'ar-AU'] }),
      ],
    });
    mount([VIEW, EDIT, TYPES]);
    const rejected = await screen.findByText('The Vegan certificate was rejected.');
    expect(
      screen.getByText('Reason from the reviewer: the number doesn’t match the issuer’s register.'),
    ).toBeTruthy();
    expect(screen.getByText('The Kosher certificate expired on 2 Nov.')).toBeTruthy();
    expect(
      screen.getByText(
        'Offers that used it lost the Kosher badge. Add the new certificate to restore it.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Persian and Arabic names are missing for Halal.')).toBeTruthy();
    expect(
      screen.getByText(
        'Ask a certification admin to add them before Persian or Arabic is published.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Open types/)).toBeNull();
    // The rejected (Critical) banner comes before the Attention ones.
    const alert = rejected.closest('[role="alert"]');
    expect(alert).toBeTruthy();
    expect(
      alert!.compareDocumentPosition(
        screen.getByText('The Kosher certificate expired on 2 Nov.').closest('div')!,
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The three are inside the card, above the table.
    const table = screen.getByRole('table');
    expect(rejected.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('words an unknown reason code as the generic sentence', async () => {
    serve({
      list: [
        item({ status: 'rejected', typeName: 'Vegan', rejectionReasonCode: 'brand-new-code' }),
      ],
    });
    mount();
    expect(await screen.findByText('Reason from the reviewer: see the details.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('brand-new-code');
  });

  it('leaves out stale banners: another approved certificate of the type, or a newer draft', async () => {
    serve({
      list: [
        item({
          id: 'old',
          status: 'expired',
          expiryDate: '2026-01-02',
          typeId: TYPE_KOSHER,
          typeName: 'Kosher',
        }),
        item({ id: 'new', status: 'approved', typeId: TYPE_KOSHER, typeName: 'Kosher' }),
        item({
          id: 'rej',
          status: 'rejected',
          typeId: TYPE_VEGAN,
          typeName: 'Vegan',
          lastChangedAt: '2026-11-01T00:00:00.000Z',
        }),
        item({
          id: 'draft',
          status: 'draft',
          typeId: TYPE_VEGAN,
          typeName: 'Vegan',
          lastChangedAt: '2026-11-04T00:00:00.000Z',
        }),
      ],
    });
    mount();
    await screen.findByRole('table');
    expect(screen.queryByText(/expired on/)).toBeNull();
    expect(screen.queryByText(/was rejected/)).toBeNull();
  });

  it('hides banner actions by permission and words the names banner for a role without type.view', async () => {
    serve({
      list: [
        item({
          id: 'e1',
          status: 'expired',
          expiryDate: '2026-11-02',
          typeName: 'Kosher',
          typeNamesMissing: ['fa-AU'],
        }),
      ],
    });
    mount([VIEW]);
    await screen.findByText('The Kosher certificate expired on 2 Nov.');
    expect(screen.queryByRole('button', { name: 'Add certificate' })).toBeNull();
    expect(
      screen.getByText('Ask a certification admin to add them before Persian is published.'),
    ).toBeTruthy();
    cleanup();
    serve({
      list: [item({ id: 'e1', status: 'expired', expiryDate: '2026-11-02', typeName: 'Kosher' })],
    });
    mount([VIEW, EDIT]);
    await screen.findByText('The Kosher certificate expired on 2 Nov.');
    expect(screen.getAllByRole('button', { name: /Add certificate/ }).length).toBe(2);
  });
});

describe('the status rules', () => {
  const today = new Date(2026, 10, 7);
  it('counts calendar days and applies the 30 day window', () => {
    expect(daysUntil('2026-11-07', today)).toBe(0);
    expect(daysUntil('2026-12-07', today)).toBe(30);
    expect(daysUntil('2026-12-08', today)).toBe(31);
    expect(statusOf(item({ expiryDate: '2026-12-07' }), today).kind).toBe('expiring');
    expect(statusOf(item({ expiryDate: '2026-12-08' }), today).kind).toBe('approved');
    expect(statusOf(item({ expiryDate: '2026-11-06' }), today).kind).toBe('expired');
    expect(statusOf(item({ status: 'rejected' }), today).tone).toBe('critical');
    expect(statusOf(item({ status: 'revoked' }), today).tone).toBe('critical');
    expect(statusOf(item({ status: 'suspended' }), today).tone).toBe('attention');
    expect(statusOf(item({ status: 'draft' }), today).tone).toBe('neutral');
  });

  it('knows its reason codes and falls back for the rest', () => {
    expect(reasonKey('unreadable')).toBe('unreadable');
    expect(reasonKey('whatever')).toBe('unknown');
    expect(reasonKey(null)).toBe('unknown');
  });

  it('labels the published variants "White · 1 kg", grouped by the first type, and ignores unsaved ones', () => {
    const base = product();
    const view: ProductView = {
      ...base,
      variants: [...base.variants, { variantId: V(9), state: 'proposed' }],
    };
    expect(publishedVariants(view).map((variant) => variant.label)).toEqual([
      'White · 1 kg',
      'White · 5 kg',
      'Brown · 1 kg',
      'Brown · 5 kg',
    ]);
    expect(publishedVariants(view)[0]?.group).toBe('White');
  });
});

/** Fills the dialog: type Halal, the issuer, text fields and dates. */
function fillDialog(over: { number?: string; file?: File | null; skipFile?: boolean } = {}) {
  const box = within(dialog());
  fireEvent.change(box.getByLabelText('Certification type'), { target: { value: TYPE_HALAL } });
  fireEvent.change(box.getByLabelText('Issuer'), { target: { value: ISSUER } });
  fireEvent.change(box.getByLabelText('Manufacturer · required'), {
    target: { value: 'Tilda Ltd' },
  });
  if (over.number !== '') {
    fireEvent.change(box.getByLabelText('Certificate number · required'), {
      target: { value: over.number ?? 'HA-2025-11873' },
    });
  }
  fireEvent.change(box.getByLabelText('Issue date · optional'), {
    target: { value: '2026-01-15' },
  });
  fireEvent.change(box.getByLabelText('Expires · required'), { target: { value: '2027-06-30' } });
  if (over.skipFile !== true) {
    const file =
      over.file ?? new File(['%PDF-1.4 test'], 'HA-2025.pdf', { type: 'application/pdf' });
    const input = dialog().querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [file] } });
  }
}

// The send flows run several awaited steps in jsdom; give a busy runner room.
vi.setConfig({ testTimeout: 20_000 });

describe('the dialog', () => {
  async function open() {
    fireEvent.click(await screen.findByRole('button', { name: /Add certificate/ }));
    await within(dialog()).findByLabelText('Certification type');
  }

  it('lists the fields in Reza’s order with the approved hints and labels', async () => {
    serve({ list: [] });
    mount();
    await open();
    const box = within(dialog());
    fireEvent.change(box.getByLabelText('Certification type'), { target: { value: TYPE_HALAL } });
    expect(box.getByText('Add product certificate')).toBeTruthy();
    expect(
      box.getByText('Sella basmati rice · checked by a certification reviewer before use.'),
    ).toBeTruthy();
    const labels = Array.from(dialog().querySelectorAll('label, legend, p#cert-file-label')).map(
      (node) => node.textContent?.replace(/\s+/g, ' ').trim(),
    );
    expect(labels.slice(0, 6)).toEqual([
      'Certification type',
      'Issuer',
      'Manufacturer · required',
      'Certificate number · required',
      'Issue date · optional',
      'Expires · required',
    ]);
    expect(box.getByText('The company named on the certificate.')).toBeTruthy();
    expect(box.getByText('PDF or image, up to 10 MB. Only reviewers can open it.')).toBeTruthy();
    // No silent prefill of the manufacturer, no number in any field.
    expect(box.getByLabelText<HTMLInputElement>('Manufacturer · required').value).toBe('');
    expect(box.getByLabelText<HTMLInputElement>('Certificate number · required').autocomplete).toBe(
      'off',
    );
    // The issuer hint names the type and the Market once a type is chosen.
    fireEvent.change(box.getByLabelText('Certification type'), { target: { value: TYPE_HALAL } });
    expect(box.getByText('Only approved issuers for Halal in Australia.')).toBeTruthy();
    fireEvent.change(box.getByLabelText('Certification type'), { target: { value: TYPE_VEGAN } });
    expect(box.getByText('No approved issuers for Vegan in Australia yet.')).toBeTruthy();
    expect(box.getByLabelText<HTMLSelectElement>('Issuer').disabled).toBe(true);
    expect(box.getByLabelText('Expires · optional')).toBeTruthy();
  });

  it('shows a loading state with Send disabled, then the no-types message with Send hidden', async () => {
    let release: (value: unknown) => void = () => undefined;
    serve({ list: [] });
    const base = call.getMockImplementation()!;
    call.mockImplementation(((method: string, path: string, ...rest: unknown[]) =>
      path === `${CERT_BASE}/options`
        ? new Promise<unknown>((resolve) => {
            release = resolve;
          })
        : (base as (...args: unknown[]) => unknown)(method, path, ...rest)) as typeof callApi);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Add certificate/ }));
    expect(within(dialog()).getByText('Loading the certification types')).toBeTruthy();
    expect(
      within(dialog()).getByRole<HTMLButtonElement>('button', { name: 'Send for review' }).disabled,
    ).toBe(true);
    release(ok({ types: [] }));
    expect(
      await within(dialog()).findByText(
        'No certification types are available for Australia yet. Ask a certification admin to add one.',
      ),
    ).toBeTruthy();
    expect(within(dialog()).queryByRole('button', { name: 'Send for review' })).toBeNull();
  });

  it('checks the fields: errors, a summary for three or more, the focus on the first, the date order', async () => {
    serve({ list: [] });
    mount();
    await open();
    const box = within(dialog());
    fireEvent.click(box.getByRole('button', { name: 'Send for review' }));
    expect(await box.findByText('5 fields need fixing.')).toBeTruthy();
    expect(box.getAllByText('Choose a certification type.').length).toBeGreaterThan(0);
    expect(box.getAllByText('Enter the manufacturer.').length).toBeGreaterThan(0);
    expect(box.getAllByText('Add the certificate document.').length).toBeGreaterThan(0);
    expect(document.activeElement).toBe(box.getByLabelText('Certification type'));
    expect(call.mock.calls.some(([method]) => method === 'POST')).toBe(false);
    // Two errors do not make a summary; the dates must be in order.
    fillDialog({ skipFile: true });
    fireEvent.change(box.getByLabelText('Expires · required'), { target: { value: '2025-01-01' } });
    fireEvent.click(box.getByRole('button', { name: 'Send for review' }));
    expect(await box.findByText('Expires must be after the issue date.')).toBeTruthy();
    expect(box.queryByText(/fields need fixing/)).toBeNull();
  });

  it('refuses a wrong file type and an oversize file with the approved wording', async () => {
    serve({ list: [] });
    mount();
    await open();
    const input = dialog().querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'a.txt', { type: 'text/plain' })] },
    });
    expect(await within(dialog()).findByText('Use a PDF, JPEG or PNG.')).toBeTruthy();
    const big = new File(['x'], 'big.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [big] } });
    expect(await within(dialog()).findByText('This file is over 10 MB.')).toBeTruthy();
  });

  it('runs create, save draft, upload, submit in order with the versions read, then closes and announces', async () => {
    serve({ list: [], listAfterSend: [item({ id: NEW_CERT, status: 'in-review' })] });
    mount();
    await open();
    fillDialog();
    // Whole product by default; the covers select is there for a product with variants.
    expect(within(dialog()).getByLabelText<HTMLSelectElement>('Covers').value).toBe('all');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Send for review' }));
    await waitFor(() => expect(sent('/submit')).toHaveLength(1));

    const writes = call.mock.calls.filter(([method]) => method !== 'GET');
    expect(writes.map(([method, path]) => `${method} ${path}`)).toEqual([
      `POST ${CERT_BASE}`,
      `PUT ${CERT_BASE}/${NEW_CERT}/draft`,
      `POST ${CERT_BASE}/${NEW_CERT}/documents`,
      `POST ${CERT_BASE}/${NEW_CERT}/submit`,
    ]);
    expect(writes[0]?.[2]).toEqual({ typeId: TYPE_HALAL });
    expect(writes[1]?.[2]).toEqual({
      version: 1,
      manufacturerName: 'Tilda Ltd',
      issuerId: ISSUER,
      certificateNumber: 'HA-2025-11873',
      issueDate: '2026-01-15',
      expiryDate: '2027-06-30',
      coverage: [{ productId: PRODUCT, variantIds: null }],
    });
    const upload = writes[2]?.[2] as { version: number; data: string };
    expect(upload.version).toBe(2);
    expect(atob(upload.data)).toBe('%PDF-1.4 test');
    expect(writes[3]?.[2]).toEqual({ version: 3 });
    expect(writes.every(([, , , csrf]) => csrf === 'csrf-1')).toBe(true);

    await waitFor(() => expect(dialogOpen()).toBe(false));
    expect(await screen.findByText('Waiting for review')).toBeTruthy();
    expect(
      screen.getAllByRole('status').some((node) => node.textContent === 'Sent for review'),
    ).toBe(true);
  });

  it('sends only the chosen variants, listed by the published revision as "White · 1 kg"', async () => {
    serve({ list: [] });
    mount();
    await open();
    const box = within(dialog());
    fireEvent.change(box.getByLabelText('Covers'), { target: { value: 'some' } });
    expect(box.getByText('Variants covered')).toBeTruthy();
    expect(box.getByText('Only variants in the published revision are listed.')).toBeTruthy();
    expect(box.getAllByRole('checkbox').map((cb) => cb.parentElement?.textContent)).toEqual([
      'White · 1 kg',
      'White · 5 kg',
      'Brown · 1 kg',
      'Brown · 5 kg',
    ]);
    // None chosen is an error.
    fillDialog();
    fireEvent.click(box.getByRole('button', { name: 'Send for review' }));
    expect(await box.findByText('Choose at least one variant.')).toBeTruthy();
    expect(sent('/draft')).toHaveLength(0);
    fireEvent.click(box.getByLabelText('White · 5 kg'));
    fireEvent.click(box.getByLabelText('Brown · 1 kg'));
    fireEvent.click(box.getByRole('button', { name: 'Send for review' }));
    await waitFor(() => expect(sent('/submit')).toHaveLength(1));
    expect((sent('/draft')[0]?.[2] as { coverage: unknown }).coverage).toEqual([
      { productId: PRODUCT, variantIds: [V(2), V(3)] },
    ]);
  });

  it('offers Select all and Clear over eight variants, and hides the select for a one-size product', async () => {
    let many = product();
    const ids = Array.from(
      { length: 9 },
      (_, n) => `0190a000-0000-7000-8000-00000000${String(n).padStart(4, '0')}`,
    );
    many = withContent(many, {
      ...many.published!.content,
      variants: ids.map((id, n) => ({
        variantId: id,
        optionValues: { grain: n % 2 === 0 ? 'white' : 'brown', pack: n % 3 === 0 ? 'kg1' : 'kg5' },
      })),
    });
    serve({ list: [] });
    mount([VIEW, EDIT], many);
    await open();
    const box = within(dialog());
    fireEvent.change(box.getByLabelText('Covers'), { target: { value: 'some' } });
    fireEvent.click(box.getByRole('button', { name: 'Select all' }));
    expect(box.getAllByRole('checkbox').every((cb) => (cb as HTMLInputElement).checked)).toBe(true);
    fireEvent.click(box.getByRole('button', { name: 'Clear' }));
    expect(box.getAllByRole('checkbox').some((cb) => (cb as HTMLInputElement).checked)).toBe(false);
    cleanup();

    let one = product({
      variantModel: 'single',
      variants: [{ variantId: V(1), state: 'published' }],
    });
    one = withContent(one, { texts: { en: { name: 'Salt' } } });
    serve({ list: [] });
    mount([VIEW, EDIT], one);
    await open();
    expect(within(dialog()).queryByLabelText('Covers')).toBeNull();
    expect(within(dialog()).getByText('Whole product')).toBeTruthy();
    fillDialog();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Send for review' }));
    await waitFor(() => expect(sent('/draft')).toHaveLength(1));
    expect((sent('/draft')[0]?.[2] as { coverage: unknown }).coverage).toEqual([
      { productId: PRODUCT, variantIds: null },
    ]);
  });

  it('keeps a draft when the submit fails: says so, offers Try again, and resumes without a second record or upload', async () => {
    serve({
      list: [],
      listAfterSend: [item({ id: NEW_CERT, status: 'in-review' })],
      routes: {
        [`POST ${CERT_BASE}/${NEW_CERT}/submit`]: [
          fail(503, 'access.unavailable'),
          ok({ version: 4 }),
        ],
      },
    });
    mount();
    await open();
    fillDialog();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Send for review' }));
    const alert = await within(dialog()).findByText(
      'Saved as a draft. We couldn’t send it for review. Try again.',
      {},
      { timeout: 5000 },
    );
    expect(alert.closest('[role="alert"]')).toBeTruthy();
    expect(dialogOpen()).toBe(true);
    // The draft is on the list behind the dialog.
    await waitFor(() =>
      expect(sent('').filter(([method]) => method === 'GET').length).toBeGreaterThan(2),
    );

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(dialogOpen()).toBe(false));
    expect(call.mock.calls.filter(([m, p]) => m === 'POST' && p === CERT_BASE)).toHaveLength(1);
    expect(sent('/documents')).toHaveLength(1);
    expect(sent('/draft')).toHaveLength(2);
    expect(sent('/submit')).toHaveLength(2);
    // The second submit carries the version after the second save of the draft.
    expect(sent('/submit')[1]?.[2]).toEqual({ version: 4 });
  });

  it('shows the failure of an upload on the file field, keeps the draft, and sends again with another file', async () => {
    serve({
      list: [],
      routes: {
        [`POST ${CERT_BASE}/${NEW_CERT}/documents`]: [
          fail(422, 'file.encrypted'),
          ok({ version: 3 }),
        ],
      },
    });
    mount();
    await open();
    fillDialog();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Send for review' }));
    expect(
      await within(dialog()).findByText(
        'We couldn’t use this file. Choose another one.',
        {},
        { timeout: 5000 },
      ),
    ).toBeTruthy();
    expect(within(dialog()).getByText(/Saved as a draft/)).toBeTruthy();
    expect(sent('/submit')).toHaveLength(0);
    const input = dialog().querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, {
      target: { files: [new File(['%PDF-1.7'], 'second.pdf', { type: 'application/pdf' })] },
    });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(sent('/submit')).toHaveLength(1));
    expect(call.mock.calls.filter(([m, p]) => m === 'POST' && p === CERT_BASE)).toHaveLength(1);
  });

  it('says nothing was saved when the create itself fails, and keeps what was typed', async () => {
    serve({ list: [], routes: { [`POST ${CERT_BASE}`]: [fail(403, 'access.denied')] } });
    mount();
    await open();
    fillDialog();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Send for review' }));
    expect(
      await within(dialog()).findByText(
        'We couldn’t save the certificate. Try again.',
        {},
        { timeout: 5000 },
      ),
    ).toBeTruthy();
    expect(
      within(dialog()).getByText('You don’t have permission to add certificates.'),
    ).toBeTruthy();
    expect(within(dialog()).queryByText(/Saved as a draft/)).toBeNull();
    expect(within(dialog()).getByLabelText<HTMLInputElement>('Manufacturer · required').value).toBe(
      'Tilda Ltd',
    );
    expect(within(dialog()).getByRole('button', { name: 'Send for review' })).toBeTruthy();
  });

  it('asks before closing while a step is in flight', async () => {
    let release: (value: unknown) => void = () => undefined;
    serve({ list: [] });
    const base = call.getMockImplementation()!;
    call.mockImplementation(((method: string, path: string, ...rest: unknown[]) =>
      method === 'POST' && path === CERT_BASE
        ? new Promise<unknown>((resolve) => {
            release = resolve;
          })
        : (base as (...args: unknown[]) => unknown)(method, path, ...rest)) as typeof callApi);
    mount();
    await open();
    fillDialog();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Send for review' }));
    expect(await within(dialog()).findByRole('button', { name: 'Sending…' })).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(within(dialog()).getByText(/Sending is still in progress/)).toBeTruthy();
    expect(dialogOpen()).toBe(true);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Keep waiting' }));
    release(ok({ certificateId: NEW_CERT, version: 1 }));
    await waitFor(() => expect(sent('/submit')).toHaveLength(1));
  });

  it('reopens a draft as "Finish product certificate": number saved and not required, no number sent', async () => {
    serve({
      list: [
        item({ id: DRAFT_CERT, status: 'draft', coverage: { whole: false, variantIds: [V(3)] } }),
      ],
      record: {
        id: DRAFT_CERT,
        typeId: TYPE_HALAL,
        status: 'draft',
        version: 7,
        author: { accountId: 'acc-1' },
        draft: {
          manufacturerName: 'Tilda Ltd',
          issuerId: ISSUER,
          certificateNumberSet: true,
          issueDate: null,
          expiryDate: '2027-06-30',
          coverage: [
            { productId: PRODUCT, productRevisionId: 'rev-1', variantId: V(3) },
            { productId: 'other-product', productRevisionId: 'rev-9', variantId: null },
          ],
          documents: [{ documentId: 'd1', mediaType: 'application/pdf', byteSize: 421888 }],
        },
        pending: null,
        approved: null,
      },
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Finish and send' }));
    const box = within(dialog());
    expect(await box.findByText('Finish product certificate')).toBeTruthy();
    const number = await box.findByLabelText<HTMLInputElement>(
      'Certificate number · already saved',
    );
    expect(number.value).toBe('');
    expect(number.placeholder).toBe('Number saved. Type to replace it.');
    expect(box.getByLabelText<HTMLSelectElement>('Certification type').disabled).toBe(true);
    expect(box.getByLabelText<HTMLInputElement>('Manufacturer · required').value).toBe('Tilda Ltd');
    expect(box.getByLabelText<HTMLSelectElement>('Covers').value).toBe('some');
    expect(box.getByLabelText<HTMLInputElement>('White · 1 kg').checked).toBe(false);
    expect(box.getByLabelText<HTMLInputElement>('Brown · 1 kg').checked).toBe(true);
    expect(box.getByText('Attached · PDF · 412 KB')).toBeTruthy();
    fireEvent.click(box.getByRole('button', { name: 'Send for review' }));
    await waitFor(() => expect(sent('/submit')).toHaveLength(1));
    expect(call.mock.calls.filter(([m, p]) => m === 'POST' && p === CERT_BASE)).toHaveLength(0);
    const draft = sent('/draft')[0]?.[2] as Record<string, unknown>;
    expect(draft).not.toHaveProperty('certificateNumber');
    expect(draft['version']).toBe(7);
    // Coverage of another product on the same record is kept.
    expect(draft['coverage']).toEqual([
      { productId: PRODUCT, variantIds: [V(3)] },
      { productId: 'other-product', variantIds: null },
    ]);
    expect(sent('/documents')).toHaveLength(0);
  });

  it('says to reload on a version conflict and reads the record again', async () => {
    serve({
      list: [],
      routes: { [`PUT ${CERT_BASE}/${NEW_CERT}/draft`]: [fail(409, 'conflict.stale')] },
      record: {
        id: NEW_CERT,
        typeId: TYPE_HALAL,
        status: 'draft',
        version: 9,
        author: { accountId: 'a' },
        draft: {
          manufacturerName: 'Other Ltd',
          issuerId: ISSUER,
          certificateNumberSet: true,
          issueDate: null,
          expiryDate: null,
          coverage: [],
          documents: [],
        },
        pending: null,
        approved: null,
      },
    });
    mount();
    await open();
    fillDialog();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Send for review' }));
    expect(
      await within(dialog()).findByText(
        'Someone changed this certificate. Reload to see it.',
        {},
        { timeout: 5000 },
      ),
    ).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Reload' }));
    await waitFor(() =>
      expect(
        within(dialog()).getByLabelText<HTMLInputElement>('Manufacturer · required').value,
      ).toBe('Other Ltd'),
    );
  });
});

describe('the details drawer', () => {
  it('opens from the row menu, shows "Number recorded" and no link to the document, with the history in role words', async () => {
    serve({
      list: [
        item({
          id: NEW_CERT,
          status: 'rejected',
          typeName: 'Vegan',
          coverage: { whole: false, variantIds: [V(1), V(4)] },
          rejectionReasonCode: 'dates-unclear',
        }),
      ],
      record: {
        id: NEW_CERT,
        typeId: TYPE_VEGAN,
        status: 'rejected',
        version: 5,
        author: { accountId: 'acc-author' },
        draft: {
          manufacturerName: 'Tilda Ltd',
          issuerId: ISSUER,
          certificateNumberSet: true,
          issueDate: '2026-01-15',
          expiryDate: '2027-06-30',
          coverage: [],
          documents: [],
        },
        pending: null,
        approved: {
          manufacturerName: 'Tilda Ltd',
          issuerId: ISSUER,
          issueDate: '2026-01-15',
          expiryDate: '2027-06-30',
          coverage: [],
          documents: [{ documentId: 'd1', mediaType: 'application/pdf', byteSize: 421888 }],
        },
      },
      history: {
        entries: [
          {
            id: 'h2',
            fromStatus: 'in-review',
            toStatus: 'rejected',
            actor: { accountId: 'acc-reviewer' },
            reasonCode: 'dates-unclear',
            occurredAt: '2026-11-06T01:00:00.000Z',
          },
          {
            id: 'h1',
            fromStatus: null,
            toStatus: 'draft',
            actor: { accountId: 'acc-author' },
            reasonCode: null,
            occurredAt: '2026-11-05T01:00:00.000Z',
          },
        ],
      },
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Vegan certificate' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'View details' }));
    const drawer = await screen.findByRole('dialog', { name: 'Certificate details', hidden: true });
    const box = within(drawer);
    expect(await box.findByText('Number recorded')).toBeTruthy();
    expect(box.getByText('Tilda Ltd')).toBeTruthy();
    expect(box.getByText('Attached · PDF · 412 KB')).toBeTruthy();
    expect(box.getByText('White · 1 kg')).toBeTruthy();
    expect(box.getByText('Brown · 5 kg')).toBeTruthy();
    expect(box.getByText('The dates do not match the certificate.')).toBeTruthy();
    expect(await box.findByText('Reviewer')).toBeTruthy();
    expect(box.getByText('Author')).toBeTruthy();
    expect(box.getByText(/In review to Rejected|Waiting for review to Rejected/)).toBeTruthy();
    expect(drawer.querySelector('a')).toBeNull();
    expect(drawer.textContent).not.toContain('acc-');
    expect(call.mock.calls.map(([m, p]) => `${m} ${p}`)).toEqual(
      expect.arrayContaining([
        `GET ${CERT_BASE}/${NEW_CERT}`,
        `GET ${CERT_BASE}/${NEW_CERT}/history`,
      ]),
    );
  });
});

describe('inside the product form', () => {
  const edit = (view: ProductView, keys: readonly string[]) =>
    render(
      <NextIntlClientProvider locale="en-AU" messages={messages}>
        <ProductEdit
          productId={PRODUCT}
          csrfToken="csrf-1"
          permissionKeys={keys}
          marketName="Australia"
        />
      </NextIntlClientProvider>,
    );

  it('mounts after Variants, last in the main column, and saves no form changes', async () => {
    serve({ list: [item()] });
    call.mockImplementation((method: string, path: string) => {
      if (method === 'GET' && path === `catalog/admin/platform-products/${PRODUCT}`) {
        return Promise.resolve(
          ok(
            product({
              workingCopy: {
                content: { texts: { en: { name: 'Sella' } } },
                lastSavedAt: '2026-11-05T01:00:00.000Z',
                baseRevisionId: 'rev-1',
              },
            }),
          ),
        );
      }
      if (path.startsWith('certification/')) {
        if (path.endsWith('/for-product/' + PRODUCT))
          return Promise.resolve(ok({ items: [item()] }));
        if (path.endsWith('/options')) return Promise.resolve(ok(OPTIONS));
        return Promise.resolve(fail(404, 'x'));
      }
      return Promise.resolve(fail(404, 'x'));
    });
    edit(product(), [VIEW, EDIT]);
    const card = await screen.findByRole('heading', { name: 'Product certifications' });
    const variants = screen.getByRole('heading', { name: 'Variants' });
    expect(variants.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(await screen.findByText('Approved')).toBeTruthy();
    // A certificate action is not an unsaved change: "Save draft" stays disabled.
    fireEvent.click(screen.getByRole('button', { name: /Add certificate/ }));
    const box = within(screen.getByRole('dialog', { name: 'Add product certificate' }));
    fireEvent.change(await box.findByLabelText('Manufacturer · required'), {
      target: { value: 'Tilda' },
    });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save draft' }).disabled).toBe(
      true,
    );
  });

  it('has no card at all for a role without the view key', async () => {
    call.mockImplementation((method: string, path: string) =>
      Promise.resolve(
        method === 'GET' && path === `catalog/admin/platform-products/${PRODUCT}`
          ? ok(product())
          : fail(404, 'x'),
      ),
    );
    edit(product(), []);
    await screen.findByRole('heading', { name: 'Variants' });
    expect(screen.queryByRole('heading', { name: 'Product certifications' })).toBeNull();
    expect(call.mock.calls.some(([, path]) => String(path).startsWith('certification/'))).toBe(
      false,
    );
  });
});

describe('focus and what a closed dialog keeps', () => {
  it('returns focus to the row menu button after Cancel from Finish and send, and after closing the drawer', async () => {
    serve({
      list: [item({ id: DRAFT_CERT, status: 'draft' })],
      record: {
        id: DRAFT_CERT,
        typeId: TYPE_HALAL,
        status: 'draft',
        version: 2,
        author: { accountId: 'a' },
        draft: {
          manufacturerName: null,
          issuerId: null,
          certificateNumberSet: false,
          issueDate: null,
          expiryDate: null,
          coverage: [],
          documents: [],
        },
        pending: null,
        approved: null,
      },
    });
    mount();
    const menu = await screen.findByRole('button', { name: 'Actions for Halal certificate' });
    fireEvent.click(menu);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Finish and send' }));
    await within(dialog()).findByLabelText('Manufacturer · required');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(menu));
    // The drawer, opened from the same menu.
    fireEvent.click(menu);
    fireEvent.click(screen.getByRole('menuitem', { name: 'View details' }));
    const drawer = await screen.findByRole('dialog', { name: 'Certificate details' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(document.activeElement).toBe(menu));
  });

  it('falls back to the Add button when the opener is gone', async () => {
    serve({
      list: [item({ status: 'expired', expiryDate: '2026-11-02' })],
    });
    mount();
    const banner = await screen.findByRole('button', { name: 'Add certificate', hidden: false });
    const add = screen.getAllByRole('button', { name: /Add certificate/ })[0]!;
    expect(banner).toBeTruthy();
    const link = screen.getAllByRole('button', { name: /Add certificate/ })[1]!;
    link.focus();
    fireEvent.click(link);
    await within(dialog()).findByLabelText('Certification type');
    link.remove();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.activeElement).toBe(add));
  });

  it('drops the typed number and the file when the dialog closes: reopening is empty', async () => {
    serve({ list: [] });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Add certificate/ }));
    await within(dialog()).findByLabelText('Certification type');
    fillDialog();
    expect(
      within(dialog()).getByLabelText<HTMLInputElement>('Certificate number · required').value,
    ).toBe('HA-2025-11873');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(document.body.querySelectorAll('dialog')[0]?.textContent).toBe(''));
    fireEvent.click(screen.getByRole('button', { name: /Add certificate/ }));
    const box = within(dialog());
    expect(
      (await box.findByLabelText<HTMLInputElement>('Certificate number · required')).value,
    ).toBe('');
    expect(box.queryByText(/HA-2025/)).toBeNull();
  });
});
