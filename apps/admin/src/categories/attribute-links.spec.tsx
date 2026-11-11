// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import {
  AttributeLinksTab,
  linksErrorKey,
  shifted,
  type LinksBody,
} from './attribute-links-tab.tsx';

const call = vi.mocked(callApi);
const CAT = '0190a000-0000-7000-8000-000000000001';

describe('link helpers', () => {
  it('moves entries one place and stops at the ends', () => {
    expect(shifted(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(shifted(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(shifted(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });
  it('maps refusals to message keys', () => {
    expect(linksErrorKey('category-links.stale', 409)).toBe('stale');
    expect(linksErrorKey('category-links.feature-set-archived', 422)).toBe('feature-set');
    expect(linksErrorKey('category-links.filter-type', 422)).toBe('filter');
    expect(linksErrorKey('category-links.too-many-filters', 422)).toBe('too-many-filters');
    expect(linksErrorKey('x', 503)).toBe('unavailable');
  });
});

describe.each([
  { name: 'AU', locale: 'en-AU' },
  { name: 'ZZ', locale: 'ja-JP' },
])('attribute links tab in market $name', ({ locale }) => {
  const links = (over: Partial<LinksBody> = {}): LinksBody => ({
    own: { featureSetId: null, filters: [], version: 3 },
    effective: {
      featureSet: { id: 'fs1', code: 'pantry', fromCategoryId: 'parent', inherited: true },
      filters: [
        { code: 'colour', inherited: true, names: { [locale]: 'Colour' }, dataType: 'select' },
      ],
    },
    ...over,
  });
  const lists = {
    sets: { items: [{ id: 'fs2', code: 'dairy', status: 'active' }], truncated: false },
    attrs: {
      locales: { default: locale, supported: [locale] },
      items: [
        { code: 'size', names: { [locale]: 'Size' }, dataType: 'select' },
        { code: 'notes', names: {}, dataType: 'text' },
      ],
    },
  };

  beforeEach(() => {
    call.mockReset();
    call.mockImplementation((method, path) => {
      if (method === 'GET' && path.includes('attribute-links'))
        return Promise.resolve({ ok: true, status: 200, body: links() });
      if (method === 'GET' && path.includes('feature-sets'))
        return Promise.resolve({ ok: true, status: 200, body: lists.sets });
      if (method === 'GET') return Promise.resolve({ ok: true, status: 200, body: lists.attrs });
      return Promise.resolve({ ok: true, status: 200, body: {} });
    });
  });
  afterEach(cleanup);

  const show = (canEdit = true) =>
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AttributeLinksTab categoryId={CAT} canEdit={canEdit} csrfToken="csrf" />
      </NextIntlClientProvider>,
    );

  it('shows the inherited feature set and filters, read only without edit rights', async () => {
    show(false);
    expect(await screen.findByText('pantry')).toBeTruthy();
    expect(screen.getAllByText('Inherited').length).toBe(2);
    expect(screen.queryByRole('button', { name: 'Edit attribute links' })).toBeNull();
  });

  it('saves its own feature set and a filter with the version read', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit attribute links' }));
    fireEvent.click(screen.getByLabelText('Use its own feature set'));
    fireEvent.change(await screen.findByLabelText('Feature set', { selector: 'select' }), {
      target: { value: 'fs2' },
    });
    expect(screen.getByText('Products move at their next submit')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Inherit filters from the parent'));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Size (size)' })).toBeTruthy());
    expect(screen.queryByRole('option', { name: /notes/ })).toBeNull();
    fireEvent.change(screen.getByLabelText('Add a filter'), { target: { value: 'size' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add filter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(call.mock.calls.some(([method]) => method === 'PUT')).toBe(true));
    const put = call.mock.calls.find(([method]) => method === 'PUT');
    expect(put?.[1]).toBe(`catalog/admin/categories/${CAT}/attribute-links`);
    expect(put?.[2]).toEqual({ version: 3, featureSetId: 'fs2', filters: ['size'] });
  });

  it('shows a stale save as a message', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit attribute links' }));
    call.mockImplementation((method) =>
      Promise.resolve(
        method === 'PUT'
          ? { ok: false, failure: { status: 409, code: 'category-links.stale' } }
          : { ok: true, status: 200, body: lists.sets },
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Someone else changed these links/)).toBeTruthy();
  });
});
