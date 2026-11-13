// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { FeatureSetEditor } from './feature-set-editor.tsx';
import type { AttributePage, FeatureSetDetail, MarketLocales } from './types.ts';

const call = vi.mocked(callApi);
const ID = '0190a000-0000-7000-8000-000000000001';

const MARKETS: readonly { readonly name: string; readonly locales: MarketLocales }[] = [
  { name: 'AU', locales: { default: 'en-AU', supported: ['en-AU'] } },
  { name: 'ZZ', locales: { default: 'ja-JP', supported: ['ja-JP', 'fa-IR'] } },
];

describe.each(MARKETS)('feature set editor in market $name', ({ locales }) => {
  const entry = (code: string, level: 'required' | 'optional', material = false) => ({
    code,
    required: level === 'required',
    level,
    isVariantOption: false,
    attributeId: null,
    names: { [locales.default]: code.toUpperCase() },
    dataType: 'text' as const,
    status: 'active',
    material,
  });
  const detail: FeatureSetDetail = {
    id: ID,
    code: 'pantry',
    status: 'active',
    revisionNo: 2,
    version: 5,
    names: { [locales.default]: 'Pantry' },
    createdAt: '2026-11-01T00:00:00Z',
    productCount: 3,
    locales,
    groups: [
      {
        groupCode: 'core',
        names: { [locales.default]: 'Core' },
        attributes: [entry('origin', 'required', true), entry('brand', 'optional')],
      },
    ],
  };
  const candidates = {
    items: [
      {
        id: 'a1',
        code: 'brand',
        names: {},
        dataType: 'text',
        isVariantOption: false,
        material: false,
      },
      {
        id: 'a2',
        code: 'size',
        names: { [locales.default]: 'Size' },
        dataType: 'text',
        isVariantOption: false,
        material: false,
      },
    ],
  } as unknown as AttributePage;
  const onSaved = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    call.mockReset();
    onSaved.mockReset();
    call.mockImplementation((method) =>
      Promise.resolve(
        method === 'GET'
          ? { ok: true, status: 200, body: candidates }
          : { ok: true, status: 200, body: {} },
      ),
    );
  });
  afterEach(cleanup);

  const show = () =>
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <FeatureSetEditor detail={detail} csrfToken="csrf" onSaved={onSaved} onCancel={onCancel} />
      </NextIntlClientProvider>,
    );

  it('saves a changed level with the version read', async () => {
    show();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save changes' }).disabled).toBe(
      true,
    );
    fireEvent.change(screen.getByLabelText('Requirement for brand'), {
      target: { value: 'required' },
    });
    expect(screen.getByText('Sellers will be asked for more')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const put = call.mock.calls.find(([method]) => method === 'PUT');
    expect(put?.[1]).toBe(`catalog/admin/feature-sets/${ID}`);
    expect(put?.[2]).toMatchObject({
      version: 5,
      groups: [
        {
          groupCode: 'core',
          attributes: [
            { code: 'origin', level: 'required' },
            { code: 'brand', level: 'required' },
          ],
        },
      ],
    });
  });

  it('reads the attribute list in pages the API accepts', async () => {
    show();
    await waitFor(() =>
      expect(call.mock.calls.some(([, path]) => path.startsWith('catalog/admin/attributes?'))).toBe(
        true,
      ),
    );
    const path = call.mock.calls
      .map(([, p]) => p)
      .find((p) => p.startsWith('catalog/admin/attributes?'));
    expect(Number(new URLSearchParams(path?.split('?')[1]).get('limit'))).toBeLessThanOrEqual(50);
  });

  it('adds an attribute the set does not hold yet', async () => {
    show();
    const select = await screen.findByLabelText('Add attribute to core');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Size (size)' })).toBeTruthy());
    expect(screen.queryByRole('option', { name: /\(brand\)/ })).toBeNull();
    fireEvent.change(select, { target: { value: 'size' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add attribute' }));
    expect(screen.getByLabelText('Requirement for size')).toBeTruthy();
  });

  it('will not save while a Material attribute is taken out', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Remove origin' }));
    expect(screen.getByText('Material attribute removed')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save changes' }).disabled).toBe(
      true,
    );
  });

  it('keeps the core group fixed and adds a new group', () => {
    show();
    expect(screen.getByText('Core group (fixed)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove group core' })).toBeNull();
    fireEvent.change(screen.getByLabelText(/^New group name/), { target: { value: 'Storage' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add group' }));
    expect(screen.getByRole('button', { name: 'Remove group storage' })).toBeTruthy();
  });

  it('shows a stale save as a message and keeps the edit', async () => {
    call.mockImplementation((method) =>
      Promise.resolve(
        method === 'GET'
          ? { ok: true, status: 200, body: candidates }
          : { ok: false, failure: { status: 409, code: 'feature-set.stale' } },
      ),
    );
    show();
    fireEvent.change(screen.getByLabelText('Requirement for brand'), {
      target: { value: 'required' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Someone else changed this feature set/)).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('shows a missing default-language name before saving', () => {
    show();
    fireEvent.change(screen.getByLabelText(/^Name in/), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByText(/Add a name in the Market's default language/)).toBeTruthy();
    expect(call.mock.calls.some(([method]) => method === 'PUT')).toBe(false);
  });
});
