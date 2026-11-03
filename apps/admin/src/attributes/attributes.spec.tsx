// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { expectToast } from '../../test/toast-spy.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi, type ApiResult } from '../api/client.ts';
import { AttributesView } from './attributes-view.tsx';
import { changeLineOf } from './history.ts';
import type {
  AttributeDetail,
  AttributePage,
  AttributeRow,
  FeatureSetDetail,
  FeatureSetRow,
  MarketLocales,
  Tab,
} from './types.ts';

const call = vi.mocked(callApi);
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

/** Two Markets (rule: a test that only passes for AU is a bug). */
const MARKETS: readonly { readonly name: string; readonly locales: MarketLocales }[] = [
  { name: 'AU', locales: { default: 'en-AU', supported: ['en-AU'] } },
  { name: 'ZZ', locales: { default: 'ja-JP', supported: ['ja-JP', 'fa-IR'] } },
];

const row = (
  locales: MarketLocales,
  n: number,
  over: Partial<AttributeRow> = {},
): AttributeRow => ({
  id: id(n),
  code: `attr-${n}`,
  dataType: 'select',
  localizable: true,
  status: 'active',
  names: { [locales.default]: `Attribute ${n}` },
  material: false,
  isVariantOption: false,
  revisionNo: 1,
  missingLocales: [],
  productCount: 0,
  featureSetCount: 0,
  ...over,
});
const page = (
  locales: MarketLocales,
  items: AttributeRow[],
  over: Partial<AttributePage> = {},
): AttributePage => ({
  items,
  nextAfterId: null,
  total: items.length,
  totalAll: items.length,
  locales,
  featureSets: [{ id: id(50), code: 'grocery-sauces' }],
  truncated: false,
  ...over,
});
const detail = (
  locales: MarketLocales,
  n: number,
  over: Partial<AttributeDetail> = {},
): AttributeDetail => ({
  ...row(locales, n),
  createdByKind: 'seed',
  createdAt: '2026-10-01T01:00:00.000Z',
  version: 1,
  bounds: {},
  display: {
    helpText: {},
    showOnProductPage: true,
    searchable: false,
    canBeFilter: false,
    internalNote: null,
    position: 0,
  },
  options: [
    {
      code: 'mild',
      labels: { [locales.default]: 'Mild' },
      active: true,
      position: 0,
      productCount: 4,
    },
    {
      code: 'hot',
      labels: { [locales.default]: 'Hot' },
      active: false,
      position: 1,
      productCount: 0,
    },
  ],
  productCount: 4,
  usedIn: [
    {
      featureSetId: id(50),
      featureSetCode: 'grocery-sauces',
      featureSetStatus: 'active',
      groupCode: 'taste',
      required: true,
      isVariantOption: false,
    },
  ],
  history: [
    {
      revisionNo: 2,
      createdAt: '2026-10-02T01:00:00.000Z',
      authorKind: 'admin',
      authorAccountId: id(77),
      changes: [
        { field: `name.${locales.default}`, before: 'Heat', after: `Attribute ${n}` },
        { field: 'option.hot.active', before: true, after: false },
      ],
    },
    {
      revisionNo: 1,
      createdAt: '2026-10-01T01:00:00.000Z',
      authorKind: 'seed',
      authorAccountId: null,
      changes: [],
    },
  ],
  historyTruncated: false,
  locales,
  ...over,
});
const featureSet = (n: number, over: Partial<FeatureSetRow> = {}): FeatureSetRow => ({
  id: id(n),
  code: `set-${n}`,
  status: 'active',
  revisionNo: 1,
  groupCount: 1,
  attributeCount: 2,
  productCount: 3,
  ...over,
});
const featureSetDetail = (locales: MarketLocales, n: number): FeatureSetDetail => ({
  id: id(n),
  code: `set-${n}`,
  status: 'active',
  revisionNo: 1,
  createdAt: '2026-10-01T01:00:00.000Z',
  groups: [
    {
      groupCode: 'taste',
      attributes: [
        {
          code: 'attr-1',
          required: true,
          isVariantOption: true,
          attributeId: id(1),
          names: { [locales.default]: 'Attribute 1' },
          dataType: 'select',
          status: 'active',
          material: true,
        },
        {
          code: 'gone',
          required: false,
          isVariantOption: false,
          attributeId: null,
          names: null,
          dataType: null,
          status: null,
          material: null,
        },
      ],
    },
  ],
  productCount: 3,
  locales,
});

type Handler = ApiResult<unknown> | (() => ApiResult<unknown>);
const ok = (body: unknown): ApiResult<unknown> => ({ ok: true, status: 200, body });
const refuse = (status: number, code: string): ApiResult<unknown> => ({
  ok: false,
  failure: { status, code },
});

/** Answers by `METHOD path`: the longest registered prefix of the call wins. */
function serve(routes: Record<string, Handler>) {
  call.mockImplementation((method, path) => {
    const key = `${method} ${path}`;
    const hit = Object.keys(routes)
      .filter((route) => key.startsWith(route))
      .sort((a, b) => b.length - a.length)[0];
    const handler = hit === undefined ? undefined : routes[hit];
    if (handler === undefined) throw new Error(`unexpected call ${key}`);
    return Promise.resolve((typeof handler === 'function' ? handler() : handler) as never);
  });
}
/** Picks an option of a searchable dropdown by the dropdown's label. */
async function choose(
  scope: Pick<typeof screen, 'getByRole'>,
  label: string | RegExp,
  option: string | RegExp,
) {
  fireEvent.click(scope.getByRole('combobox', { name: label }));
  const list = await screen.findByRole('listbox', { name: label });
  fireEvent.click(within(list).getByRole('option', { name: option }));
}
const calls = (prefix: string) =>
  call.mock.calls.filter(([m, path]) => m === 'GET' && path.startsWith(prefix)).map(([, p]) => p);

function mount(
  options: {
    canEdit?: boolean;
    canSeeBrands?: boolean;
    initialTab?: Tab;
    initialId?: string | null;
  } = {},
) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <AttributesView
        canEdit={options.canEdit ?? false}
        csrfToken="csrf-1"
        canSeeBrands={options.canSeeBrands ?? true}
        initialTab={options.initialTab ?? 'attributes'}
        initialId={options.initialId ?? null}
      />
    </NextIntlClientProvider>,
  );
}

describe.each(MARKETS)('admin attributes ($name)', ({ locales }) => {
  const other = locales.supported.find((locale) => locale !== locales.default) ?? null;

  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', '/catalog/attributes');
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

  it('lists attributes with their badges and counts, and the total on the tab', async () => {
    serve({
      'GET catalog/admin/attributes?': ok(
        page(locales, [
          row(locales, 1, { material: true, productCount: 12, featureSetCount: 2 }),
          row(locales, 2, {
            isVariantOption: true,
            status: 'draft',
            missingLocales: other === null ? [] : [other],
          }),
        ]),
      ),
    });
    mount();
    const list = await screen.findByRole('list', { name: 'Attributes' });
    const first = within(list).getByRole('button', { name: /Attribute 1/ });
    expect(within(first).getByText('Material')).toBeTruthy();
    expect(within(first).getByText('12 products')).toBeTruthy();
    expect(within(first).getByText(/2 feature sets/)).toBeTruthy();
    const second = within(list).getByRole('button', { name: /Attribute 2/ });
    expect(within(second).getByText('Variant')).toBeTruthy();
    expect(within(second).getByText('Draft')).toBeTruthy();
    if (other !== null) {
      expect(within(second).getByText(/^Missing: /)).toBeTruthy();
    }
    expect(screen.getByText('2 attributes')).toBeTruthy();
    expect(calls('catalog/admin/attributes?')[0]).toBe('catalog/admin/attributes?limit=50');
  });

  it('shows the view-only notice without catalog.attribute.edit, and not with it', async () => {
    serve({ 'GET catalog/admin/attributes?': ok(page(locales, [])) });
    mount({ canEdit: false });
    expect(
      await screen.findByText(
        'You can view attributes. Ask a Platform Administrator to change them.',
      ),
    ).toBeTruthy();
    cleanup();
    mount({ canEdit: true });
    await screen.findByText('No attributes yet.');
    expect(screen.queryByText(/You can view attributes/)).toBeNull();
  });

  it('sends the filters, offers the missing-language filter only for a second language', async () => {
    serve({ 'GET catalog/admin/attributes?': ok(page(locales, [row(locales, 1)])) });
    mount();
    await screen.findByRole('button', { name: /Attribute 1/ });
    fireEvent.change(screen.getByLabelText('Search by name or code'), {
      target: { value: '  Spicy ' },
    });
    await waitFor(() =>
      expect(calls('catalog/admin/attributes?').at(-1)).toContain('search=Spicy'),
    );
    await choose(screen, 'Type', 'Yes or no');
    await waitFor(() =>
      expect(calls('catalog/admin/attributes?').at(-1)).toContain('type=boolean'),
    );
    await choose(screen, 'Status', 'Archived');
    await waitFor(() =>
      expect(calls('catalog/admin/attributes?').at(-1)).toContain('status=archived'),
    );
    const missing = screen.queryByRole('combobox', { name: 'Language' });
    if (other === null) {
      expect(missing).toBeNull();
    } else {
      await choose(screen, 'Language', 'Missing: Persian');
      await waitFor(() =>
        expect(calls('catalog/admin/attributes?').at(-1)).toContain(`missing=${other}`),
      );
    }
  });

  it('says when filters find nothing, and clears them', async () => {
    serve({
      'GET catalog/admin/attributes?limit=50&status=archived': ok(
        page(locales, [], { totalAll: 3 }),
      ),
      'GET catalog/admin/attributes?': ok(page(locales, [row(locales, 1)])),
    });
    mount();
    await screen.findByRole('button', { name: /Attribute 1/ });
    await choose(screen, 'Status', 'Archived');
    expect(await screen.findByText('No attributes match these filters.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByRole('button', { name: /Attribute 1/ })).toBeTruthy();
  });

  it('reads the next page on Show more', async () => {
    serve({
      [`GET catalog/admin/attributes?limit=50&afterId=${id(1)}`]: ok(
        page(locales, [row(locales, 2)], { totalAll: 2 }),
      ),
      'GET catalog/admin/attributes?': ok(
        page(locales, [row(locales, 1)], { nextAfterId: id(1), totalAll: 2 }),
      ),
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(await screen.findByRole('button', { name: /Attribute 2/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Attribute 1/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
  });

  it('shows a retry on a failed list', async () => {
    let fail = true;
    serve({
      'GET catalog/admin/attributes?': () =>
        fail ? refuse(503, 'access.unavailable') : ok(page(locales, [row(locales, 1)])),
    });
    mount();
    expect(await screen.findByText('We could not load the attributes. Try again.')).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /Attribute 1/ })).toBeTruthy();
  });

  it('opens an attribute: details, values, used in and history', async () => {
    const withSecond = detail(locales, 1, {
      ...(other === null
        ? {}
        : {
            names: { [locales.default]: 'Attribute 1', [other]: 'ویژگی یک' },
            options: [
              {
                code: 'mild',
                labels: { [locales.default]: 'Mild', [other]: 'ملایم' },
                active: true,
                position: 0,
                productCount: 4,
              },
              {
                code: 'hot',
                labels: { [locales.default]: 'Hot' },
                active: false,
                position: 1,
                productCount: 0,
              },
            ],
          }),
    });
    serve({
      'GET catalog/admin/attributes?': ok(page(locales, [row(locales, 1)])),
      [`GET catalog/admin/attributes/${id(1)}`]: ok(withSecond),
    });
    mount();
    expect(await screen.findByText('Choose an attribute')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: /Attribute 1/ }));
    const panel = await screen.findByRole('region', { name: 'Attribute details' });
    await within(panel).findByRole('heading', { name: 'Attribute 1' });
    expect(window.location.search).toBe(`?id=${id(1)}`);
    expect(within(panel).getByText('attr-1 · One choice')).toBeTruthy();
    expect(within(panel).getByText('Added by the platform')).toBeTruthy();

    if (other !== null) {
      fireEvent.click(within(panel).getByRole('combobox', { name: 'Language' }));
      const choices = await screen.findByRole('listbox', { name: 'Language' });
      fireEvent.click(within(choices).getByRole('option', { name: /Persian/ }));
      const name = await within(panel).findByText('ویژگی یک');
      expect(name.getAttribute('dir')).toBe('rtl');
      expect(name.getAttribute('lang')).toBe(other);
    }

    fireEvent.click(within(panel).getByRole('button', { name: 'Values' }));
    const values = within(panel).getByRole('list', { name: 'Values' });
    expect(within(values).getByText('Mild')).toBeTruthy();
    expect(within(values).getByText('Inactive')).toBeTruthy();
    expect(within(values).getByText('4 products')).toBeTruthy();
    if (other !== null) {
      await choose(within(panel), /^Show next to/, 'Persian');
      expect(within(panel).getByText('ملایم').getAttribute('dir')).toBe('rtl');
      expect(within(panel).getByText('Missing')).toBeTruthy();
    } else {
      expect(within(panel).queryByRole('combobox', { name: /^Show next to/ })).toBeNull();
    }

    fireEvent.click(within(panel).getByRole('button', { name: 'Used in' }));
    expect(within(panel).getByText('grocery-sauces')).toBeTruthy();
    expect(within(panel).getByText('Group: taste')).toBeTruthy();
    expect(within(panel).getByText('Required')).toBeTruthy();

    fireEvent.click(within(panel).getByRole('button', { name: 'History' }));
    expect(within(panel).getByText('Revision 2')).toBeTruthy();
    expect(
      within(panel).getByText(`By administrator ${id(77).slice(-8).toUpperCase()}`),
    ).toBeTruthy();
    const changes = within(panel)
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(changes).toContain('Value Hot: Active to Inactive');
    expect(changes.some((text) => /: Heat to Attribute 1$/.test(text ?? ''))).toBe(true);
    expect(within(panel).getByText('Created')).toBeTruthy();

    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(await screen.findByText('Choose an attribute')).toBeTruthy();
    expect(window.location.search).toBe('');
  });

  it('says a non-choice attribute has no list of values', async () => {
    serve({
      'GET catalog/admin/attributes?': ok(page(locales, [row(locales, 1)])),
      [`GET catalog/admin/attributes/${id(1)}`]: ok(
        detail(locales, 1, { dataType: 'boolean', options: [] }),
      ),
    });
    mount({ initialId: id(1) });
    const panel = await screen.findByRole('region', { name: 'Attribute details' });
    fireEvent.click(await within(panel).findByRole('button', { name: 'Values' }));
    expect(within(panel).getByText(/has no list of values/)).toBeTruthy();
  });

  it('says when the attribute is gone, and retries a failed read', async () => {
    let answer: ApiResult<unknown> = refuse(404, 'attribute.not-found');
    serve({
      'GET catalog/admin/attributes?': ok(page(locales, [row(locales, 1)])),
      [`GET catalog/admin/attributes/${id(1)}`]: () => answer,
    });
    mount({ initialId: id(1) });
    expect(await screen.findByText('This attribute no longer exists.')).toBeTruthy();
    cleanup();
    answer = refuse(503, 'access.unavailable');
    mount({ initialId: id(1) });
    expect(await screen.findByText('We could not load this attribute. Try again.')).toBeTruthy();
    answer = ok(detail(locales, 1));
    const panel = screen.getByRole('region', { name: 'Attribute details' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Try again' }));
    expect(await within(panel).findByRole('heading', { name: 'Attribute 1' })).toBeTruthy();
  });

  it('lists feature sets, opens one, and opens its attribute on the Attributes tab', async () => {
    serve({
      'GET catalog/admin/feature-sets/': ok(featureSetDetail(locales, 50)),
      'GET catalog/admin/feature-sets': ok({
        items: [featureSet(50), featureSet(51, { status: 'archived' })],
        truncated: false,
      }),
      'GET catalog/admin/attributes?': ok(page(locales, [row(locales, 1)])),
      [`GET catalog/admin/attributes/${id(1)}`]: ok(detail(locales, 1)),
    });
    mount({ initialTab: 'feature-sets' });
    const list = await screen.findByRole('list', { name: 'Feature sets' });
    expect(within(list).getByText('Archived')).toBeTruthy();
    expect(within(list).getAllByText('1 group, 2 attributes')).toHaveLength(2);

    fireEvent.change(screen.getByLabelText('Search by code'), { target: { value: 'nothing' } });
    expect(screen.getByText('No feature sets match this search.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));

    const again = screen.getByRole('list', { name: 'Feature sets' });
    fireEvent.click(within(again).getByRole('button', { name: /set-50/ }));
    const panel = await screen.findByRole('region', { name: 'Feature set details' });
    await within(panel).findByRole('heading', { name: 'set-50' });
    expect(within(panel).getByText('Group: taste', { selector: 'h3' })).toBeTruthy();
    expect(within(panel).getByText('gone · not found in this Market')).toBeTruthy();
    expect(within(panel).getByText('Material')).toBeTruthy();
    expect(window.location.search).toBe(`?tab=feature-sets&id=${id(50)}`);

    fireEvent.click(within(panel).getByRole('button', { name: 'Attribute 1' }));
    const attribute = await screen.findByRole('region', { name: 'Attribute details' });
    expect(await within(attribute).findByRole('heading', { name: 'Attribute 1' })).toBeTruthy();
    expect(window.location.search).toBe(`?id=${id(1)}`);
  });

  it('retries a failed feature-set list, and says when there is none or more than shown', async () => {
    let answer: ApiResult<unknown> = refuse(503, 'access.unavailable');
    serve({ 'GET catalog/admin/feature-sets': () => answer });
    mount({ initialTab: 'feature-sets' });
    expect(await screen.findByText('We could not load the feature sets. Try again.')).toBeTruthy();
    answer = ok({ items: [], truncated: false });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No feature sets yet.')).toBeTruthy();
    cleanup();
    answer = ok({ items: [featureSet(50)], truncated: true });
    mount({ initialTab: 'feature-sets' });
    expect(await screen.findByText('Only the first 500 feature sets are shown.')).toBeTruthy();
  });

  it('brings the details into view on a narrow screen', async () => {
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    serve({
      'GET catalog/admin/attributes?': ok(page(locales, [row(locales, 1)])),
      [`GET catalog/admin/attributes/${id(1)}`]: ok(detail(locales, 1)),
    });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /Attribute 1/ }));
    const heading = await screen.findByRole('heading', { name: 'Attribute 1' });
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(document.activeElement).toBe(heading);
  });

  it('shows the Brands tab as a link, and the empty Waiting for you tab', () => {
    serve({ 'GET catalog/admin/attributes?': ok(page(locales, [])) });
    mount({ canSeeBrands: true, initialTab: 'waiting' });
    expect(screen.getByText('Nothing is waiting for you.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Brands' }).getAttribute('href')).toBe(
      '/catalog/brands',
    );
    expect(window.location.search).toBe('?tab=waiting');
    cleanup();
    mount({ canSeeBrands: false, initialTab: 'waiting' });
    expect(screen.queryByRole('link', { name: 'Brands' })).toBeNull();
  });

  const writes = (method: string) =>
    call.mock.calls
      .filter(([m]) => m === method)
      .map(([, path, body, csrf]) => ({ path, body, csrf }));

  it('adds a draft in two steps and opens it with its Draft badge and Publish', async () => {
    const created = detail(locales, 9, {
      status: 'draft',
      code: 'pack-size',
      names: { [locales.default]: 'Pack size' },
      missingLocales: other === null ? [] : [other],
    });
    serve({
      'GET catalog/admin/attributes?': ok(page(locales, [row(locales, 1)])),
      'POST catalog/admin/attributes': {
        ok: true,
        status: 201,
        body: {
          attribute: { id: id(9), code: 'pack-size', status: 'draft', version: 1, revisionNo: 1 },
        },
      },
      [`GET catalog/admin/attributes/${id(9)}`]: ok(created),
    });
    mount({ canEdit: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Add attribute' }));
    const dialog = await screen.findByRole('dialog', { name: /^Add attribute/ });
    expect(within(dialog).getByText(/Size: Small, Medium, Large/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    const name = within(dialog).getByRole('textbox', { name: /^Name in/ });
    expect(name.getAttribute('lang')).toBe(locales.default);
    expect(within(dialog).queryByText('Fill this in.')).toBeNull();
    fireEvent.change(name, { target: { value: 'Pack size' } });
    expect(within(dialog).getByRole('textbox', { name: /^Code/ }).getAttribute('placeholder')).toBe(
      'pack-size',
    );
    fireEvent.change(within(dialog).getByRole('textbox', { name: /^Values in/ }), {
      target: { value: '500 g\n\n1 kg\n' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add as draft' }));

    const panel = await screen.findByRole('region', { name: 'Attribute details' });
    await within(panel).findByRole('heading', { name: 'Pack size' });
    expect(within(panel).getAllByText('Draft').length).toBeGreaterThan(0);
    expect(within(panel).getByRole('button', { name: 'Publish' })).toBeTruthy();
    expect(within(panel).getByText(/sellers and buyers do not see this attribute/)).toBeTruthy();
    const [post] = writes('POST');
    expect(post).toEqual({
      path: 'catalog/admin/attributes',
      csrf: 'csrf-1',
      body: {
        dataType: 'select',
        names: { [locales.default]: 'Pack size' },
        material: false,
        isVariantOption: false,
        bounds: {},
        options: [
          { labels: { [locales.default]: '500 g' }, active: true },
          { labels: { [locales.default]: '1 kg' }, active: true },
        ],
        helpText: {},
        showOnProductPage: true,
        searchable: false,
        canBeFilter: false,
        internalNote: null,
        position: 0,
      },
    });
    expect(window.location.search).toBe(`?id=${id(9)}`);
  });

  it('asks for a code when the name has no Latin letters, and shows a claim word on its field', async () => {
    serve({
      'GET catalog/admin/attributes?': ok(page(locales, [])),
      'POST catalog/admin/attributes': {
        ok: false,
        failure: {
          status: 422,
          code: 'attribute.claim-word',
          details: { fields: [{ path: `names.${locales.default}`, code: 'claim-word' }] },
        },
      },
    });
    mount({ canEdit: true });
    fireEvent.click(await screen.findByRole('button', { name: 'Add attribute' }));
    const dialog = await screen.findByRole('dialog', { name: /^Add attribute/ });
    fireEvent.click(within(dialog).getByRole('radio', { name: /Yes or no/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Next' }));
    const name = within(dialog).getByRole('textbox', { name: /^Name in/ });
    fireEvent.change(name, { target: { value: 'パック' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add as draft' }));
    expect(await within(dialog).findByText(/Use lower-case letters|Fill this in/)).toBeTruthy();
    expect(writes('POST')).toEqual([]);
    expect(within(dialog).queryByRole('textbox', { name: /^Values in/ })).toBeNull();

    fireEvent.change(within(dialog).getByRole('textbox', { name: /^Code/ }), {
      target: { value: 'halal-pack' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add as draft' }));
    expect(await within(dialog).findByText(/^A name or value names a certification/)).toBeTruthy();
    const name2 = within(dialog).getByRole('textbox', { name: /^Name in/ });
    expect(name2.getAttribute('aria-invalid')).toBe('true');
    expect(within(dialog).getByText(/^This text names a certification/)).toBeTruthy();
  });

  it('edits the whole content with the version seen; a newer version asks to reload', async () => {
    let version = 3;
    const saved = () =>
      detail(locales, 1, {
        version,
        status: 'active',
        names: { [locales.default]: 'Heat' },
      });
    let refuse409 = true;
    serve({
      'GET catalog/admin/attributes?': ok(page(locales, [row(locales, 1)])),
      [`GET catalog/admin/attributes/${id(1)}`]: () => ok(saved()),
      [`PUT catalog/admin/attributes/${id(1)}`]: () => {
        if (refuse409) {
          refuse409 = false;
          return refuse(409, 'attribute.stale');
        }
        version += 1;
        return ok({
          attribute: { id: id(1), code: 'attr-1', status: 'active', version, revisionNo: 3 },
        });
      },
    });
    mount({ canEdit: true, initialId: id(1) });
    const panel = await screen.findByRole('region', { name: 'Attribute details' });
    await within(panel).findByRole('heading', { name: 'Heat' });
    expect(within(panel).queryByRole('button', { name: 'Publish' })).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Edit' }));
    const form = within(panel).getByRole('form', { name: 'Edit attribute' });
    expect(within(form).getByRole('checkbox', { name: /Variant option/ })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(within(form).getByRole('button', { name: 'Add value' }));
    const labels = within(form).getAllByRole('textbox', { name: /^Value 3 in/ });
    fireEvent.change(labels[0]!, { target: { value: 'Extra hot' } });
    if (other !== null) {
      await choose(within(form), 'Language', /Persian/);
      fireEvent.change(within(form).getByRole('textbox', { name: /^Name in Persian/ }), {
        target: { value: 'تندی' },
      });
      expect(
        within(form)
          .getByRole('textbox', { name: /^Name in Persian/ })
          .getAttribute('dir'),
      ).toBe('rtl');
    }
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(
      await within(panel).findByText(/^This attribute changed since you opened it/),
    ).toBeTruthy();
    const [first] = writes('PUT');
    expect(first?.body).toMatchObject({
      version: 3,
      names: {
        [locales.default]: 'Heat',
        ...(other === null ? {} : { [other]: 'تندی' }),
      },
      options: [
        { code: 'mild', labels: { [locales.default]: 'Mild' }, active: true },
        { code: 'hot', labels: { [locales.default]: 'Hot' }, active: false },
        { labels: { [locales.default]: 'Extra hot' }, active: true },
      ],
    });

    fireEvent.click(within(panel).getByRole('button', { name: 'Reload' }));
    await within(panel).findByRole('button', { name: 'Edit' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Edit' }));
    fireEvent.click(
      within(within(panel).getByRole('form', { name: 'Edit attribute' })).getByRole('button', {
        name: 'Save',
      }),
    );
    await expectToast('Attribute saved.');
    expect(writes('PUT')[1]?.body).toMatchObject({ version: 3 });
  });

  it('points a refused value label at its row, and keeps a saved value from being removed', async () => {
    serve({
      'GET catalog/admin/attributes?': ok(page(locales, [row(locales, 1)])),
      [`GET catalog/admin/attributes/${id(1)}`]: ok(detail(locales, 1, { status: 'draft' })),
      [`PUT catalog/admin/attributes/${id(1)}`]: {
        ok: false,
        failure: {
          status: 422,
          code: 'attribute-definition.text-invalid',
          details: { fields: [{ path: `options.hot.labels.${locales.default}`, code: 'invalid' }] },
        },
      },
    });
    mount({ canEdit: true, initialId: id(1) });
    const panel = await screen.findByRole('region', { name: 'Attribute details' });
    fireEvent.click(await within(panel).findByRole('button', { name: 'Edit' }));
    const form = within(panel).getByRole('form', { name: 'Edit attribute' });
    expect(within(form).queryByRole('button', { name: 'Remove' })).toBeNull();
    fireEvent.click(within(form).getByRole('button', { name: 'Move value 2 up' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText(/^Use plain text only/)).toBeTruthy();
    const field = within(form).getAllByRole('textbox', { name: /^Value 1 in/ })[0]!;
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(
      (writes('PUT')[0]?.body as { options: { code: string }[] }).options.map((o) => o.code),
    ).toEqual(['hot', 'mild']);
  });

  it('publishes a draft after confirming', async () => {
    let published = false;
    serve({
      'GET catalog/admin/attributes?': ok(page(locales, [row(locales, 1, { status: 'draft' })])),
      [`GET catalog/admin/attributes/${id(1)}`]: () =>
        ok(detail(locales, 1, { status: published ? 'active' : 'draft' })),
      [`POST catalog/admin/attributes/${id(1)}/publish`]: () => {
        published = true;
        return ok({
          attribute: { id: id(1), code: 'attr-1', status: 'active', version: 2, revisionNo: 1 },
        });
      },
    });
    mount({ canEdit: true, initialId: id(1) });
    const panel = await screen.findByRole('region', { name: 'Attribute details' });
    fireEvent.click(await within(panel).findByRole('button', { name: 'Publish' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish Attribute 1?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await expectToast('Attribute published.');
    expect(writes('POST').map((w) => [w.path, w.body, w.csrf])).toEqual([
      [`catalog/admin/attributes/${id(1)}/publish`, { version: 1 }, 'csrf-1'],
    ]);
    await waitFor(() =>
      expect(within(panel).queryByRole('button', { name: 'Publish' })).toBeNull(),
    );
  });

  it('turns a claim word found on publish into the editor, on the refused language', async () => {
    const tag = other ?? locales.default;
    serve({
      'GET catalog/admin/attributes?': ok(page(locales, [row(locales, 1, { status: 'draft' })])),
      [`GET catalog/admin/attributes/${id(1)}`]: ok(
        detail(locales, 1, {
          status: 'draft',
          names: { [locales.default]: 'Attribute 1', [tag]: 'Attribute 1' },
        }),
      ),
      [`POST catalog/admin/attributes/${id(1)}/publish`]: {
        ok: false,
        failure: {
          status: 422,
          code: 'attribute.claim-word',
          details: { fields: [{ path: `names.${tag}`, code: 'claim-word' }] },
        },
      },
    });
    mount({ canEdit: true, initialId: id(1) });
    const panel = await screen.findByRole('region', { name: 'Attribute details' });
    fireEvent.click(await within(panel).findByRole('button', { name: 'Publish' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish Attribute 1?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }));
    expect(await within(dialog).findByText(/Edit it before publishing/)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Publish' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Edit attribute' }));
    const form = await within(panel).findByRole('form', { name: 'Edit attribute' });
    const name = within(form).getByRole('textbox', { name: /^Name in/ });
    expect(name.getAttribute('lang')).toBe(tag);
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(within(form).getByText(/^This text names a certification/)).toBeTruthy();
  });

  it('asks for no code on a value in another script and sends one it makes', async () => {
    serve({
      'GET catalog/admin/attributes?': ok(page(locales, [row(locales, 1)])),
      [`GET catalog/admin/attributes/${id(1)}`]: ok(detail(locales, 1, { status: 'draft' })),
      [`PUT catalog/admin/attributes/${id(1)}`]: ok({
        attribute: { id: id(1), code: 'attr-1', status: 'draft', version: 2, revisionNo: 2 },
      }),
    });
    mount({ canEdit: true, initialId: id(1) });
    const panel = await screen.findByRole('region', { name: 'Attribute details' });
    fireEvent.click(await within(panel).findByRole('button', { name: 'Edit' }));
    const form = within(panel).getByRole('form', { name: 'Edit attribute' });
    fireEvent.click(within(form).getByRole('button', { name: 'Add value' }));
    fireEvent.change(within(form).getAllByRole('textbox', { name: /^Value 3 in/ })[0]!, {
      target: { value: '小' },
    });
    expect(
      within(form)
        .getByRole('textbox', { name: /^Code of value 3/ })
        .getAttribute('placeholder'),
    ).toBe('made automatically');
    fireEvent.click(within(form).getByRole('button', { name: 'Add value' }));
    fireEvent.change(within(form).getAllByRole('textbox', { name: /^Value 4 in/ })[0]!, {
      target: { value: '中' },
    });
    fireEvent.change(within(form).getByRole('textbox', { name: /^Code of value 4/ }), {
      target: { value: 'medium' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await expectToast('Attribute saved.');
    const options = (writes('PUT')[0]?.body as { options: { code?: string }[] }).options;
    expect(options.map((o) => o.code)).toEqual(['mild', 'hot', 'value-1', 'medium']);
  });

  it('keeps a refusal on its value when the values move after it', async () => {
    serve({
      'GET catalog/admin/attributes?': ok(page(locales, [row(locales, 1)])),
      [`GET catalog/admin/attributes/${id(1)}`]: ok(detail(locales, 1, { status: 'draft' })),
      [`PUT catalog/admin/attributes/${id(1)}`]: {
        ok: false,
        failure: {
          status: 422,
          code: 'attribute.claim-word',
          details: {
            fields: [{ path: `options[1].labels.${locales.default}`, code: 'claim-word' }],
          },
        },
      },
    });
    mount({ canEdit: true, initialId: id(1) });
    const panel = await screen.findByRole('region', { name: 'Attribute details' });
    fireEvent.click(await within(panel).findByRole('button', { name: 'Edit' }));
    const form = within(panel).getByRole('form', { name: 'Edit attribute' });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await within(form).findByText(/^This text names a certification/);
    fireEvent.click(within(form).getByRole('button', { name: 'Move value 2 up' }));
    const first = within(form).getAllByRole('textbox', { name: /^Value 1 in/ })[0]!;
    expect((first as HTMLInputElement).value).toBe('Hot');
    expect(first.getAttribute('aria-invalid')).toBe('true');
    const second = within(form).getAllByRole('textbox', { name: /^Value 2 in/ })[0]!;
    expect(second.getAttribute('aria-invalid')).not.toBe('true');
  });

  it('keeps focus where the admin types or moves a value while errors show', async () => {
    serve({
      'GET catalog/admin/attributes?': ok(page(locales, [row(locales, 1)])),
      [`GET catalog/admin/attributes/${id(1)}`]: ok(detail(locales, 1, { status: 'draft' })),
    });
    mount({ canEdit: true, initialId: id(1) });
    const panel = await screen.findByRole('region', { name: 'Attribute details' });
    fireEvent.click(await within(panel).findByRole('button', { name: 'Edit' }));
    const form = within(panel).getByRole('form', { name: 'Edit attribute' });
    const name = within(form).getAllByRole('textbox', { name: /^Name in/ })[0]!;
    const label = within(form).getAllByRole('textbox', { name: /^Value 2 in/ })[0]!;
    fireEvent.change(name, { target: { value: '' } });
    fireEvent.change(label, { target: { value: '' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(document.activeElement).toBe(name));
    label.focus();
    fireEvent.change(label, { target: { value: 'H' } });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement).toBe(label);
    expect(name.getAttribute('aria-invalid')).toBe('true');
    fireEvent.click(within(form).getByRole('button', { name: 'Move value 2 up' }));
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Move value 1 down'),
    );
  });

  it('moves focus to the next value, or to Add value, after removing one', async () => {
    serve({
      'GET catalog/admin/attributes?': ok(page(locales, [row(locales, 1)])),
      [`GET catalog/admin/attributes/${id(1)}`]: ok(detail(locales, 1, { status: 'draft' })),
    });
    mount({ canEdit: true, initialId: id(1) });
    const panel = await screen.findByRole('region', { name: 'Attribute details' });
    fireEvent.click(await within(panel).findByRole('button', { name: 'Edit' }));
    const form = within(panel).getByRole('form', { name: 'Edit attribute' });
    fireEvent.click(within(form).getByRole('button', { name: 'Add value' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Add value' }));
    fireEvent.change(within(form).getAllByRole('textbox', { name: /^Value 4 in/ })[0]!, {
      target: { value: 'Last' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Remove value 3' }));
    await waitFor(() =>
      expect((document.activeElement as HTMLInputElement | null)?.value).toBe('Last'),
    );
    expect(within(form).getByText('Value removed.')).toBeTruthy();
    fireEvent.click(within(form).getByRole('button', { name: 'Remove value 3' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(within(form).getByRole('button', { name: 'Add value' })),
    );
  });

  it('discards a draft after confirming', async () => {
    serve({
      'GET catalog/admin/attributes?': ok(page(locales, [row(locales, 1, { status: 'draft' })])),
      [`GET catalog/admin/attributes/${id(1)}`]: ok(detail(locales, 1, { status: 'draft' })),
      [`POST catalog/admin/attributes/${id(1)}/discard`]: ok({
        attribute: { id: id(1), code: 'attr-1', status: 'archived', version: 2, revisionNo: 1 },
      }),
    });
    mount({ canEdit: true, initialId: id(1) });
    const panel = await screen.findByRole('region', { name: 'Attribute details' });
    fireEvent.click(await within(panel).findByRole('button', { name: 'Discard draft' }));
    const dialog = await screen.findByRole('dialog', { name: 'Discard Attribute 1?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard draft' }));
    await expectToast('Draft discarded.');
    expect(writes('POST')[0]?.path).toBe(`catalog/admin/attributes/${id(1)}/discard`);
  });

  it('offers no Add, Edit or Publish without catalog.attribute.edit', async () => {
    serve({
      'GET catalog/admin/attributes?': ok(page(locales, [row(locales, 1, { status: 'draft' })])),
      [`GET catalog/admin/attributes/${id(1)}`]: ok(detail(locales, 1, { status: 'draft' })),
    });
    mount({ initialId: id(1) });
    const panel = await screen.findByRole('region', { name: 'Attribute details' });
    await within(panel).findByRole('heading', { name: 'Attribute 1' });
    expect(screen.queryByRole('button', { name: 'Add attribute' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Publish' })).toBeNull();
  });

  it('sends a signed-out admin to the session-ended page', async () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, assign, pathname: original.pathname, search: original.search },
    });
    try {
      serve({ 'GET catalog/admin/attributes?': refuse(401, 'auth.required') });
      mount();
      await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });
});

describe('history change lines', () => {
  it('reads every field the API names, and keeps an unknown one by its name', () => {
    const line = (field: string) => changeLineOf({ field, before: null, after: null });
    expect(line('name.fa-IR')).toEqual({ key: 'name', language: 'Persian' });
    expect(
      changeLineOf({ field: 'name.en-AU', before: null, after: null }, ['en-AU', 'en-US']),
    ).toEqual({ key: 'name', language: 'English (Australia)' });
    expect(line('option.hot.removed')).toEqual({ key: 'option-removed', code: 'hot' });
    expect(line('material')).toEqual({ key: 'material' });
    expect(line('isVariantOption')).toEqual({ key: 'variant' });
    expect(line('bounds.maxLength')).toEqual({ key: 'bound', bound: 'maxLength' });
    expect(line('option.extra.hot.added')).toEqual({ key: 'option-added', code: 'extra.hot' });
    expect(line('option.hot.label.ja-JP')).toEqual({
      key: 'option-label',
      code: 'hot',
      language: 'Japanese',
    });
    expect(line('option.hot.active')).toEqual({ key: 'option-active', code: 'hot' });
    expect(line('option.hot.position')).toEqual({ key: 'option-position', code: 'hot' });
    expect(line('help.fa-IR')).toEqual({ key: 'help', language: 'Persian' });
    expect(line('showOnProductPage')).toEqual({ key: 'show-on-product-page' });
    expect(line('canBeFilter')).toEqual({ key: 'can-be-filter' });
    expect(line('internalNote')).toEqual({ key: 'internal-note' });
    expect(line('weird')).toEqual({ key: 'other', field: 'weird' });
  });
});
