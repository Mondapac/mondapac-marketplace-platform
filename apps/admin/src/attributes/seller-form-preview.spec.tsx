// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi, type ApiResult } from '../api/client.ts';
import type { EditorEntry, EditorState } from './feature-set-editor-model.ts';
import { MAX_PARALLEL } from './preview-options.ts';
import { SellerFormPreview } from './seller-form-preview.tsx';
import type { MarketLocales } from './types.ts';

const call = vi.mocked(callApi);
const FS = '0190a000-0000-7000-8000-00000000f001';
const aid = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ok = (body: unknown): ApiResult<unknown> => ({ ok: true, status: 200, body });
const fail: ApiResult<unknown> = { ok: false, failure: { status: 500, code: 'x' } } as never;

const entry = (
  code: string,
  dataType: string,
  level: EditorEntry['level'],
  n: number | null,
  name = code,
): EditorEntry => ({
  code,
  attributeId: n === null ? null : aid(n),
  level,
  names: { 'en-AU': name },
  dataType,
  isVariantOption: false,
  material: false,
});

const state = (entries: readonly EditorEntry[]): EditorState => ({
  names: { 'en-AU': 'Sauces' },
  groups: [
    {
      groupCode: 'core',
      names: { 'en-AU': 'Core' },
      entries: [entry('origin', 'text', 'required', null, 'Country of origin')],
    },
    { groupCode: 'details', names: { 'en-AU': 'Details' }, entries },
  ],
});

const MARKETS: readonly { readonly name: string; readonly locales: MarketLocales }[] = [
  { name: 'AU', locales: { default: 'en-AU', supported: ['en-AU'] } },
  { name: 'ZZ', locales: { default: 'ja-JP', supported: ['ja-JP'] } },
];

const detailOf = (n: number, labels: readonly string[], locale: string, help = '') => ({
  options: labels.map((label, i) => ({
    code: `o${i}`,
    labels: { [locale]: label },
    active: i !== 1 || labels.length < 3 ? true : true,
    position: i,
    productCount: 0,
  })),
  display: { helpText: help === '' ? {} : { [locale]: help } },
  id: aid(n),
});

function view(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  call.mockReset();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe.each(MARKETS)('seller form preview in market $name', ({ locales }) => {
  const L = locales.default;
  const mount = (entries: readonly EditorEntry[], open = true) =>
    view(
      <SellerFormPreview
        open={open}
        onClose={() => {}}
        featureSetId={FS}
        featureSetCode="sauces"
        state={{
          ...state(entries),
          groups: state(entries).groups.map((g) => ({
            ...g,
            names: { [L]: g.groupCode === 'core' ? 'Core' : 'Details' },
            entries: g.entries.map((e) => ({ ...e, names: { [L]: e.names?.['en-AU'] ?? e.code } })),
          })),
        }}
        locales={locales}
      />,
    );

  it('marks requirements and picks the control by data type, reading choices only for select types', async () => {
    call.mockImplementation((_m: string, path: string) => {
      if (path.startsWith('catalog/admin/categories'))
        return Promise.resolve(ok({ categories: [], defaultLocale: L }));
      if (path.includes(aid(1)))
        return Promise.resolve(ok(detailOf(1, ['Milk', 'Egg'], L, 'Choose all that apply.')));
      if (path.includes(aid(2))) return Promise.resolve(ok(detailOf(2, ['Cold', 'Dry'], L)));
      return Promise.resolve(fail);
    });
    mount([
      entry('allergens', 'multi-select', 'required', 1, 'Allergens'),
      entry('storage', 'select', 'recommended', 2, 'Storage'),
      entry('gluten-free', 'boolean', 'optional', 3, 'Gluten free'),
      entry('shelf', 'integer', 'optional', 4, 'Shelf life'),
      entry('notes', 'long-text', 'optional', 5, 'Notes'),
      entry('best-before', 'date', 'recommended', 6, 'Best before'),
    ]);
    expect(screen.getByRole('heading', { name: 'Core' })).toBeTruthy();
    expect(screen.getByLabelText('Country of origin *')).toBeTruthy();
    expect(await screen.findByText('Milk')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Allergens *' })).toBeTruthy();
    expect(await screen.findByLabelText('Storage (Recommended)')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Gluten free (Optional)' })).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Shelf life (Optional)').type).toBe('number');
    expect(screen.getByLabelText('Notes (Optional)').tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText<HTMLInputElement>('Best before (Recommended)').type).toBe('date');
    const reads = call.mock.calls
      .map((c) => c[1])
      .filter((p) => p.startsWith('catalog/admin/attributes/'));
    expect(reads.sort()).toEqual([
      `catalog/admin/attributes/${aid(1)}`,
      `catalog/admin/attributes/${aid(2)}`,
    ]);
    expect(screen.getByText('Choose all that apply.')).toBeTruthy();
  });

  it('lists only the categories whose feature set is the previewed one', async () => {
    call.mockImplementation((_m: string, path: string) =>
      Promise.resolve(
        path.startsWith('catalog/admin/categories')
          ? ok({
              defaultLocale: L,
              categories: [
                {
                  id: aid(90),
                  slug: 'a',
                  names: [{ locale: L, name: 'Sauces' }],
                  featureSetId: FS,
                },
                {
                  id: aid(91),
                  slug: 'b',
                  names: [{ locale: L, name: 'Pasta sauces' }],
                  featureSetId: FS,
                },
                {
                  id: aid(92),
                  slug: 'c',
                  names: [{ locale: L, name: 'Drinks' }],
                  featureSetId: 'other',
                },
              ],
            })
          : fail,
      ),
    );
    mount([]);
    // The core group of the helper has one entry; the empty-set message is tested below.
    const select = await screen.findByLabelText('Preview as');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Sauces', 'Pasta sauces']);
  });

  it('says so when no category uses the set, and still shows the form when categories fail', async () => {
    call.mockResolvedValue(ok({ categories: [], defaultLocale: L }));
    const { unmount } = mount([]);
    expect(await screen.findByText('No category uses this feature set yet.')).toBeTruthy();
    unmount();
    call.mockResolvedValue(fail);
    mount([entry('notes', 'text', 'optional', null, 'Notes')]);
    expect(await screen.findByText(/couldn't load the categories/)).toBeTruthy();
    expect(screen.getByLabelText('Notes (Optional)')).toBeTruthy();
  });

  it('shows loading, then an error with a retry for one attribute only', async () => {
    let storageTries = 0;
    call.mockImplementation((_m: string, path: string) => {
      if (path.startsWith('catalog/admin/categories'))
        return Promise.resolve(ok({ categories: [], defaultLocale: L }));
      if (path.includes(aid(1))) return Promise.resolve(ok(detailOf(1, ['Cold'], L)));
      storageTries += 1;
      return Promise.resolve(storageTries === 1 ? fail : ok(detailOf(2, ['Warm'], L)));
    });
    mount([
      entry('storage', 'select', 'optional', 1, 'Storage'),
      entry('heat', 'select', 'optional', 2, 'Heat'),
    ]);
    expect(
      await screen.findByText("We couldn't load the choices for this attribute."),
    ).toBeTruthy();
    expect(await screen.findByLabelText('Storage (Optional)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText('Heat (Optional)')).toBeTruthy();
    expect(screen.queryByText("We couldn't load the choices for this attribute.")).toBeNull();
  });

  it('reads at most MAX_PARALLEL attributes at once and folds long chip lists into "+ N more"', async () => {
    let inflight = 0;
    let peak = 0;
    call.mockImplementation(((_m: string, path: string) => {
      if (path.startsWith('catalog/admin/categories'))
        return Promise.resolve(ok({ categories: [], defaultLocale: L }));
      inflight += 1;
      peak = Math.max(peak, inflight);
      const n = Number(path.slice(-12));
      return new Promise((resolve) =>
        setTimeout(() => {
          inflight -= 1;
          resolve(ok(detailOf(n, ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'], L)));
        }, 5),
      );
    }) as never);
    mount(
      Array.from({ length: 8 }, (_v, i) =>
        entry(`m${i + 1}`, 'multi-select', 'optional', i + 1, `Multi ${i + 1}`),
      ),
    );
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: '+ 2 more' })).toHaveLength(8),
    );
    expect(peak).toBeLessThanOrEqual(MAX_PARALLEL);
    expect(peak).toBeGreaterThan(1);
    fireEvent.click(screen.getAllByRole('button', { name: '+ 2 more' })[0]!);
    expect(screen.getAllByText('H').length).toBe(1);
  });

  it('says a set with no attributes shows the core details only', () => {
    call.mockResolvedValue(ok({ categories: [], defaultLocale: L }));
    view(
      <SellerFormPreview
        open
        onClose={() => {}}
        featureSetId={FS}
        featureSetCode="sauces"
        state={{ names: {}, groups: [] }}
        locales={locales}
      />,
    );
    expect(
      screen.getByText('This feature set has no attributes. Sellers only see the core details.'),
    ).toBeTruthy();
  });

  it('reads nothing while closed', () => {
    mount([entry('storage', 'select', 'optional', 1)], false);
    expect(call).not.toHaveBeenCalled();
  });
});
