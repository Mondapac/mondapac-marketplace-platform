// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

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
    expect(screen.getByRole('button', { name: 'Attributes 2' })).toBeTruthy();
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
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'boolean' } });
    await waitFor(() =>
      expect(calls('catalog/admin/attributes?').at(-1)).toContain('type=boolean'),
    );
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'archived' } });
    await waitFor(() =>
      expect(calls('catalog/admin/attributes?').at(-1)).toContain('status=archived'),
    );
    const missing = screen.queryByRole('combobox', { name: 'Language' });
    if (other === null) {
      expect(missing).toBeNull();
    } else {
      fireEvent.change(missing as HTMLElement, { target: { value: other } });
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
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'archived' } });
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
    const table = within(panel).getByRole('table');
    expect(within(table).getByText('Mild')).toBeTruthy();
    expect(within(table).getByText('Inactive')).toBeTruthy();
    expect(within(table).getByText('4')).toBeTruthy();
    if (other !== null) {
      fireEvent.change(within(panel).getByLabelText(/^Show next to/), {
        target: { value: other },
      });
      expect(within(panel).getByText('ملایم').getAttribute('dir')).toBe('rtl');
      expect(within(panel).getByText(/^Missing: /)).toBeTruthy();
    } else {
      expect(within(panel).queryByLabelText(/^Show next to/)).toBeNull();
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
    expect(changes).toContain('Value hot active: Yes to No');
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
      }),
      'GET catalog/admin/attributes?': ok(page(locales, [row(locales, 1)])),
      [`GET catalog/admin/attributes/${id(1)}`]: ok(detail(locales, 1)),
    });
    mount({ initialTab: 'feature-sets' });
    const list = await screen.findByRole('list', { name: 'Feature sets' });
    expect(within(list).getByText('Archived')).toBeTruthy();
    expect(within(list).getAllByText('1 group, 2 attributes')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Feature sets 2' })).toBeTruthy();

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
    expect(line('name.fa-IR')).toEqual({ key: 'name', language: 'Persian (Iran)' });
    expect(line('material')).toEqual({ key: 'material' });
    expect(line('isVariantOption')).toEqual({ key: 'variant' });
    expect(line('bounds.maxLength')).toEqual({ key: 'bound', bound: 'maxLength' });
    expect(line('option.extra.hot.added')).toEqual({ key: 'option-added', code: 'extra.hot' });
    expect(line('option.hot.label.ja-JP')).toEqual({
      key: 'option-label',
      code: 'hot',
      language: 'Japanese (Japan)',
    });
    expect(line('option.hot.active')).toEqual({ key: 'option-active', code: 'hot' });
    expect(line('option.hot.position')).toEqual({ key: 'option-position', code: 'hot' });
    expect(line('weird')).toEqual({ key: 'other', field: 'weird' });
  });
});
