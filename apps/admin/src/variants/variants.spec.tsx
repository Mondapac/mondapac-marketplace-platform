// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi, type ApiResult } from '../api/client.ts';
import type { VariantPage, VariantTypeDetail, VariantTypeSummary } from './types.ts';
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
  const page: VariantPage = {
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
      },
    ],
    nextAfter: id(20),
  };
  return { summary, detail, page };
}

function route(locales: readonly string[], overrides: Record<string, ApiResult<unknown>> = {}) {
  const { summary, detail, page } = fixtures(locales);
  call.mockImplementation((method, path) => {
    const key = `${method} ${path.split('?')[0]}`;
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

function mount(props: { canEdit?: boolean; tab?: 'types' | 'variants'; id?: string | null } = {}) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <VariantsView
        canEdit={props.canEdit ?? true}
        canOpenAttributes
        csrfToken="csrf-1"
        initialTab={props.tab ?? 'types'}
        initialId={props.id === undefined ? TYPE : props.id}
      />
    </NextIntlClientProvider>,
  );
}

afterEach(() => cleanup());

describe.each(MARKETS)('admin Variants page ($name)', ({ locales }) => {
  beforeEach(() => {
    call.mockReset();
    window.history.replaceState(null, '', '/catalog/variants');
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
    await screen.findByRole('region', { name: 'Variant type details' });
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /Swatches/ }).disabled).toBe(true);
  });

  it('saves the whole settings with the version read, swatches only for Swatches', async () => {
    route(locales);
    mount();
    await screen.findByRole('region', { name: 'Variant type details' });
    fireEvent.click(screen.getByRole('radio', { name: /Swatches/ }));
    fireEvent.change(screen.getByLabelText('Colour for 250 g'), { target: { value: GREEN } });
    fireEvent.change(screen.getByLabelText('Option order'), { target: { value: 'by-size' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
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

  it('refuses a colour that is not #RRGGBB before sending', async () => {
    route(locales);
    mount();
    await screen.findByRole('region', { name: 'Variant type details' });
    fireEvent.click(screen.getByRole('radio', { name: /Swatches/ }));
    fireEvent.change(screen.getByLabelText('Colour for 250 g'), { target: { value: 'red' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(messages.variants.types.swatch.format)).toBeTruthy();
    expect(call.mock.calls.some(([method]) => method === 'PUT')).toBe(false);
  });

  it('says so when someone else changed the type first', async () => {
    route(locales, {
      [`PUT catalog/admin/variant-types/${TYPE}/settings`]: fail(409, 'variant-type.stale'),
    });
    mount();
    await screen.findByRole('region', { name: 'Variant type details' });
    fireEvent.click(screen.getByRole('radio', { name: /Dropdown/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(
        'Someone else changed this variant type. Reload it and make your change again.',
      ),
    ).toBeTruthy();
  });

  it('lists the variants with their issues and filters by an issue chip', async () => {
    route(locales);
    mount({ tab: 'variants', id: null });
    expect(await screen.findByText('MP-004127-02')).toBeTruthy();
    expect(screen.getByText('9 300633 01234 5')).toBeTruthy();
    const issues = screen.getByRole('group', { name: 'Issues' });
    const chip = await within(issues).findByRole('button', { name: 'Missing GTIN · 388' });
    fireEvent.click(chip);
    await waitFor(() =>
      expect(
        call.mock.calls.some(
          ([method, path]) =>
            method === 'GET' &&
            path.startsWith('catalog/admin/variants?') &&
            path.includes('issue=missing-gtin'),
        ),
      ).toBe(true),
    );
    expect(chip.getAttribute('aria-pressed')).toBe('true');
  });

  it('asks for the next page after the last variant id', async () => {
    route(locales);
    mount({ tab: 'variants', id: null });
    fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));
    await waitFor(() =>
      expect(call.mock.calls.some(([, path]) => path.includes(`after=${id(20)}`))).toBe(true),
    );
  });

  it('offers a retry when the list cannot load', async () => {
    route(locales, { 'GET catalog/admin/variants': fail(503, 'access.unavailable') });
    mount({ tab: 'variants', id: null });
    expect(await screen.findByText('The variants could not be loaded.')).toBeTruthy();
  });
});
