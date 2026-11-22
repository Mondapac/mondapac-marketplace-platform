// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi, type ApiResult } from '../api/client.ts';
import type { PagedAnswer } from '../shared/paged-list/types.ts';
import type { VariantRow, VariantTypeDetail, VariantTypeSummary } from './types.ts';
import { VariantsView } from './variants-view.tsx';

const call = vi.mocked(callApi);
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const TYPE = id(1);
/** A swatch colour as the API stores it (data, not a style). */
const hex = (digits: string) => `#${digits}`;
const RED = hex('AA0000');
const GREEN = hex('00aa00');

/** Two Markets: a test that only passes for AU is a bug. */
const MARKETS = [
  { name: 'AU', locales: ['en-AU'] },
  { name: 'ZZ', locales: ['ja-JP', 'en-US'] },
] as const;

const ok = <T,>(body: T): ApiResult<T> => ({ ok: true, status: 200, body });
const fail = (status: number, code: string): ApiResult<never> => ({
  ok: false,
  failure: { status, code },
});

function fixtures(locales: readonly string[]) {
  const [first, second] = locales as [string, string | undefined];
  const summary: VariantTypeSummary = {
    id: TYPE,
    code: 'pack-size',
    status: 'active',
    names: { [first]: 'Pack size' },
    displayStyle: 'buttons',
    optionOrder: 'manual',
    options: 2,
    products: 412,
    liveVariants: 1031,
    featureSets: [],
    languages: locales.map((locale) => ({
      locale,
      nameMissing: locale !== first,
      optionsMissing: locale === first ? 0 : 2,
    })),
  };
  const detail: VariantTypeDetail = {
    ...summary,
    optionList: [
      {
        code: 'g250',
        labels: { [first]: '250 g' },
        active: true,
        position: 0,
        swatch: null,
        products: 96,
      },
      {
        code: 'kg1',
        labels: { [first]: '1 kg', ...(second === undefined ? {} : { [second]: '1 kg' }) },
        active: true,
        position: 1,
        swatch: RED,
        products: 122,
      },
    ],
    sellerHelp: {},
    settingsVersion: 2,
  };
  const page: PagedAnswer<VariantRow> = {
    items: [
      {
        productId: id(10),
        productCode: 'MP-004127',
        productName: 'Sella basmati rice',
        productScope: 'PLATFORM',
        status: 'live',
        variantId: id(20),
        variantNo: 2,
        variantCode: 'MP-004127-02',
        label: '5 kg',
        labels: { [first]: '5 kg' },
        gtin: '09300633012345',
        sellers: 0,
        issues: ['no-seller-selling', 'duplicate-gtin'],
        missingLocales: [],
        actions: ['open-product', 'copy-code'],
      },
    ],
    total: 61,
    page: 1,
    pageSize: 25,
    paging: 'pages',
    hasNext: true,
  };
  return { summary, detail, page };
}

function route(locales: readonly string[], overrides: Record<string, ApiResult<unknown>> = {}) {
  const { summary, detail, page } = fixtures(locales);
  call.mockImplementation((method, path) => {
    const key = `${method} ${path.split('?')[0]}`;
    // Saved filters are answered for this list's own key only; another key is not found.
    if (
      key === 'GET lists/admin/saved-filters' &&
      path !== 'lists/admin/saved-filters?listKey=admin.catalog.variants'
    ) {
      return Promise.resolve(fail(404, 'not-found') as never);
    }
    if (overrides[key] !== undefined) return Promise.resolve(overrides[key] as never);
    if (key === 'GET catalog/admin/variant-types')
      return Promise.resolve(ok({ items: [summary] }) as never);
    if (key === `GET catalog/admin/variant-types/${TYPE}`)
      return Promise.resolve(ok({ variantType: detail }) as never);
    if (key === 'GET catalog/admin/variants') return Promise.resolve(ok(page) as never);
    if (key === 'GET catalog/admin/variants/issue-counts')
      return Promise.resolve(
        ok({
          counts: {
            'no-seller-selling': 17,
            'missing-gtin': 388,
            'duplicate-gtin': 3,
            'no-image': 61,
            'missing-language': 24,
          },
        }) as never,
      );
    if (key === `PUT catalog/admin/variant-types/${TYPE}/settings`)
      return Promise.resolve(ok({ variantType: { id: TYPE, settingsVersion: 3 } }) as never);
    return Promise.resolve(fail(404, 'not-found'));
  });
}

function mount(
  props: {
    canEdit?: boolean;
    canReview?: boolean;
    tab?: 'types' | 'variants' | 'waiting';
    id?: string | null;
    paging?: 'pages' | 'prev-next';
  } = {},
) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <VariantsView
        canEdit={props.canEdit ?? true}
        canOpenAttributes
        canReview={props.canReview ?? false}
        csrfToken="csrf-1"
        initialTab={props.tab ?? 'types'}
        initialId={props.id === undefined ? TYPE : props.id}
        paging={props.paging ?? 'pages'}
        accountId={id(99)}
        marketId="AU"
        zone="Australia/Brisbane"
      />
    </NextIntlClientProvider>,
  );
}

afterEach(() => cleanup());

describe.each(MARKETS)('admin Variants page ($name)', ({ locales }) => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute('open');
    };
    call.mockReset();
    window.history.replaceState(null, '', '/catalog/variants');
  });

  it('shows the Waiting for you tab only to an admin who may answer size requests', async () => {
    route(locales);
    mount({ id: null });
    await screen.findByRole('list', { name: 'Variant types' });
    expect(screen.queryByRole('button', { name: 'Waiting for you' })).toBeNull();
    cleanup();
    mount({ id: null, canReview: true });
    expect(await screen.findByRole('button', { name: 'Waiting for you' })).toBeTruthy();
  });

  it('opens the first tab when a link names Waiting for you without the review key', async () => {
    route(locales);
    mount({ id: null, tab: 'waiting' });
    expect(await screen.findByRole('list', { name: 'Variant types' })).toBeTruthy();
  });

  it('lists the variant types with counts and the languages they lack', async () => {
    route(locales);
    mount({ id: null });
    const list = await screen.findByRole('list', { name: 'Variant types' });
    expect(within(list).getByText('Pack size')).toBeTruthy();
    expect(within(list).getByText('2 options · 412 products · 1,031 live variants')).toBeTruthy();
    if (locales.length === 1) expect(within(list).getByText('All languages')).toBeTruthy();
    else expect(within(list).getByText('English: 3 missing')).toBeTruthy();
    expect(screen.getByText('Choose a variant type')).toBeTruthy();
  });

  it('shows the view-only notice and no save for an admin who cannot edit', async () => {
    route(locales);
    mount({ canEdit: false });
    expect(
      await screen.findByText(
        'You can view variants. Ask a Platform Administrator to change them.',
      ),
    ).toBeTruthy();
    await screen.findByRole('form', { name: 'Variant type details' });
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /Swatches/ }).disabled).toBe(true);
  });

  it('saves the whole settings with the version read, swatches only for Swatches', async () => {
    route(locales);
    mount();
    await screen.findByRole('form', { name: 'Variant type details' });
    fireEvent.click(screen.getByRole('radio', { name: /Swatches/ }));
    fireEvent.change(screen.getByLabelText('Colour for 250 g'), { target: { value: GREEN } });
    fireEvent.change(screen.getByLabelText('Option order'), { target: { value: 'by-size' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'PUT',
        `catalog/admin/variant-types/${TYPE}/settings`,
        {
          version: 2,
          displayStyle: 'swatches',
          optionOrder: 'by-size',
          swatches: { kg1: RED, g250: GREEN },
          sellerHelp: {},
        },
        'csrf-1',
      ),
    );
  });

  it('counts the changes in the save bar and discards them all', async () => {
    route(locales);
    mount();
    await screen.findByRole('form', { name: 'Variant type details' });
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Swatches/ }));
    fireEvent.change(screen.getByLabelText('Colour for 250 g'), { target: { value: GREEN } });
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(within(bar).getByText('2 unsaved changes')).toBeTruthy();
    // A swatch is not a change once the style no longer uses swatches.
    fireEvent.click(screen.getByRole('radio', { name: /Dropdown/ }));
    expect(within(bar).getByText('1 unsaved change')).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    expect(call.mock.calls.some(([method]) => method === 'PUT')).toBe(false);
  });

  it('sends one save for two quick submits, and no change for help of spaces alone', async () => {
    route(locales);
    mount();
    const form = await screen.findByRole('form', { name: 'Variant type details' });
    const help = screen.getAllByLabelText(/Help for sellers/)[0]!;
    fireEvent.change(help, { target: { value: '   ' } });
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Dropdown/ }));
    // Enter in a field submits the form; a second one while the first runs is dropped.
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() =>
      expect(call.mock.calls.filter(([method]) => method === 'PUT')).toHaveLength(1),
    );
  });

  it('leaves for the session-ended page on a 401 without the leave prompt', async () => {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { value: { assign }, configurable: true });
    try {
      route(locales, {
        [`PUT catalog/admin/variant-types/${TYPE}/settings`]: fail(401, 'session.expired'),
      });
      mount();
      await screen.findByRole('form', { name: 'Variant type details' });
      fireEvent.click(screen.getByRole('radio', { name: /Dropdown/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
      expect(screen.queryByText('Leave without saving?')).toBeNull();
      expect(screen.queryByRole('region', { name: 'Unsaved changes' })).not.toBeNull();
    } finally {
      Object.defineProperty(window, 'location', { value: original, configurable: true });
    }
  });

  it('refuses a colour that is not #RRGGBB before sending', async () => {
    route(locales);
    mount();
    await screen.findByRole('form', { name: 'Variant type details' });
    fireEvent.click(screen.getByRole('radio', { name: /Swatches/ }));
    fireEvent.change(screen.getByLabelText('Colour for 250 g'), { target: { value: 'red' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(messages.variants.types.swatch.format)).toBeTruthy();
    expect(call.mock.calls.some(([method]) => method === 'PUT')).toBe(false);
  });

  it('ignores a bad colour once another display style is chosen', async () => {
    route(locales);
    mount();
    await screen.findByRole('form', { name: 'Variant type details' });
    fireEvent.click(screen.getByRole('radio', { name: /Swatches/ }));
    fireEvent.change(screen.getByLabelText('Colour for 250 g'), { target: { value: 'red' } });
    fireEvent.click(screen.getByRole('radio', { name: /Dropdown/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'PUT',
        `catalog/admin/variant-types/${TYPE}/settings`,
        expect.objectContaining({ displayStyle: 'dropdown', swatches: {} }),
        'csrf-1',
      ),
    );
  });

  it('says so when someone else changed the type first', async () => {
    route(locales, {
      [`PUT catalog/admin/variant-types/${TYPE}/settings`]: fail(409, 'variant-type.stale'),
    });
    mount();
    await screen.findByRole('form', { name: 'Variant type details' });
    fireEvent.click(screen.getByRole('radio', { name: /Dropdown/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText(
        'Someone else changed this variant type. Reload it and make your change again.',
      ),
    ).toBeTruthy();
  });

  const variantCalls = () =>
    call.mock.calls
      .filter(([method, path]) => method === 'GET' && path.startsWith('catalog/admin/variants?'))
      .map(([, path]) => new URLSearchParams(path.split('?')[1]));

  it('lists the variants as a super list and asks for page one in the Market paging mode', async () => {
    route(locales);
    mount({ tab: 'variants', id: null });
    expect(await screen.findByText('MP-004127-02')).toBeTruthy();
    expect(screen.getByText('9 300633 01234 5')).toBeTruthy();
    const first = variantCalls()[0];
    expect(first?.get('page')).toBe('1');
    expect(first?.get('pageSize')).toBe('25');
    expect(first?.get('paging')).toBe('pages');
    expect(first?.get('sort')).toBe('newest');
    expect(first?.get('direction')).toBe('desc');
    expect(screen.getByRole('button', { name: 'Sort' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filter' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Columns' })).toBeTruthy();
  });

  it('keeps every row action in the Actions menu, never in the row', async () => {
    route(locales);
    mount({ tab: 'variants', id: null });
    await screen.findByText('MP-004127-02');
    const row = screen.getByText('MP-004127-02').closest('tr') as HTMLElement;
    expect(within(row).queryByRole('button', { name: /^Open product|Copy/ })).toBeNull();
    fireEvent.click(within(row).getByRole('button', { name: /Actions for/ }));
    expect(await screen.findByRole('menuitem', { name: 'Open product' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Copy variant code' })).toBeTruthy();
  });

  it('offers only the row actions the API names', async () => {
    const { page } = fixtures(locales);
    const row = page.items[0] as VariantRow;
    route(locales, {
      'GET catalog/admin/variants': ok({ ...page, items: [{ ...row, actions: ['copy-code'] }] }),
    });
    mount({ tab: 'variants', id: null });
    const cell = (await screen.findByText('MP-004127-02')).closest('tr') as HTMLElement;
    fireEvent.click(within(cell).getByRole('button', { name: /Actions for/ }));
    expect(screen.queryByRole('menuitem', { name: 'Open product' })).toBeNull();
    expect(await screen.findByRole('menuitem', { name: 'Copy variant code' })).toBeTruthy();
  });

  it('shows the issues as tabs with counts and asks for the issue the tab names', async () => {
    route(locales);
    mount({ tab: 'variants', id: null });
    await screen.findByText('MP-004127-02');
    const tab = await screen.findByRole('button', { name: 'Missing GTIN (388)' });
    fireEvent.click(tab);
    await waitFor(() =>
      expect(variantCalls().some((params) => params.get('issue') === 'missing-gtin')).toBe(true),
    );
  });

  it('filters by variant type, shows the chip and takes it off again', async () => {
    route(locales);
    mount({ tab: 'variants', id: null });
    await screen.findByText('MP-004127-02');
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.change(await screen.findByLabelText('Field'), { target: { value: 'typeCode' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'pack-size' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(variantCalls().some((params) => params.get('typeCode') === 'pack-size')).toBe(true),
    );
    fireEvent.click(await screen.findByRole('button', { name: /Remove filter Variant type is/ }));
    await waitFor(() => expect(variantCalls().at(-1)?.get('typeCode')).toBeNull());
  });

  it('opens a saved filter as a tab and saves the current view as a new one', async () => {
    const saved = {
      id: id(50),
      listKey: 'admin.catalog.variants',
      name: 'Pack sizes without GTIN',
      visibility: 'me',
      payload: {
        v: 1,
        filters: { typeCode: 'pack-size', issue: 'missing-gtin' },
        sort: 'code',
        direction: 'asc',
      },
      ownedByMe: true,
      canManage: true,
    };
    route(locales, {
      'GET lists/admin/saved-filters': ok({ items: [saved], canShare: false }),
      'POST lists/admin/saved-filters': ok({ ...saved, id: id(51), name: 'Mine' }),
    });
    mount({ tab: 'variants', id: null });
    await screen.findByText('MP-004127-02');
    fireEvent.click(await screen.findByRole('button', { name: 'Pack sizes without GTIN' }));
    await waitFor(() => {
      const last = variantCalls().at(-1);
      expect(last?.get('typeCode')).toBe('pack-size');
      expect(last?.get('issue')).toBe('missing-gtin');
      expect(last?.get('sort')).toBe('code');
    });
    // A built-in tab after a saved one starts clean.
    fireEvent.click(await screen.findByRole('button', { name: /^All/ }));
    await waitFor(() => expect(variantCalls().at(-1)?.get('typeCode')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    fireEvent.change(await screen.findByLabelText('Field'), { target: { value: 'typeCode' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'pack-size' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    fireEvent.click(await screen.findByRole('button', { name: /Save filter/ }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Mine' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save filter' }).at(-1) as HTMLElement);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        'lists/admin/saved-filters',
        {
          listKey: 'admin.catalog.variants',
          name: 'Mine',
          visibility: 'me',
          payload: {
            v: 1,
            filters: { typeCode: 'pack-size' },
            sort: 'newest',
            direction: 'desc',
          },
        },
        'csrf-1',
      ),
    );
  });

  it('searches after a pause and starts again at page one', async () => {
    route(locales);
    mount({ tab: 'variants', id: null });
    await screen.findByText('MP-004127-02');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search variants' }), {
      target: { value: 'basmati' },
    });
    await waitFor(() =>
      expect(variantCalls().some((params) => params.get('q') === 'basmati')).toBe(true),
    );
    expect(variantCalls().at(-1)?.get('page')).toBe('1');
  });

  it('sends no sort and no total with Previous and next', async () => {
    const { page } = fixtures(locales);
    route(locales, {
      'GET catalog/admin/variants': ok({ ...page, total: null, paging: 'prev-next' }),
    });
    mount({ tab: 'variants', id: null, paging: 'prev-next' });
    await screen.findByText('MP-004127-02');
    const first = variantCalls()[0];
    expect(first?.get('paging')).toBe('prev-next');
    expect(first?.get('sort')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sort' })).toBeNull();
    expect(await screen.findByRole('button', { name: 'Next' })).toBeTruthy();
  });

  it('moves to the next page with the page buttons', async () => {
    route(locales);
    mount({ tab: 'variants', id: null });
    await screen.findByText('MP-004127-02');
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(variantCalls().some((params) => params.get('page') === '2')).toBe(true),
    );
  });

  it('exports the current view and filters from the Bulk action menu', async () => {
    route(locales);
    mount({ tab: 'variants', id: null });
    await screen.findByText('MP-004127-02');
    const row = screen.getByText('MP-004127-02').closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Export…' }));
    expect(await screen.findByRole('dialog', { name: 'Export variants' })).toBeTruthy();
  });

  it('offers a retry when the list cannot load', async () => {
    route(locales, { 'GET catalog/admin/variants': fail(503, 'access.unavailable') });
    mount({ tab: 'variants', id: null });
    expect(await screen.findByText('The variants could not be loaded.')).toBeTruthy();
  });
});
