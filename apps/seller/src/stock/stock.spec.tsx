// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { sellerNav } from '../nav.ts';
import { visibleNavItems } from '@mondapac/ui';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { problemOf } from './errors.ts';
import { addressOf } from './stock-form.tsx';
import { StockLocations } from './stock-locations.tsx';
import type { SourcesView, StockFormOptions } from './types.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);

const A = '0190a000-0000-7000-8000-0000000000a1';
const B = '0190a000-0000-7000-8000-0000000000b2';
const view = (over: Partial<SourcesView> = {}): SourcesView => ({
  version: 4,
  max: 3,
  sources: [
    {
      id: A,
      name: 'Default',
      isDefault: true,
      position: 1,
      address: null,
      timeZone: null,
      createdAt: '2026-10-01T00:00:00.000Z',
    },
    {
      id: B,
      name: 'Garage',
      isDefault: false,
      position: 2,
      address: { line1: '1 Test St', suburb: 'Sunnybank' },
      timeZone: 'Australia/Brisbane',
      createdAt: '2026-10-02T00:00:00.000Z',
    },
  ],
  ...over,
});
const options: StockFormOptions = {
  fields: [
    { key: 'line1', labelKey: 'sellers.address.field.line1', required: true, maxLength: 120 },
    { key: 'suburb', labelKey: 'sellers.address.field.suburb', required: true, maxLength: 120 },
  ],
  regionField: null,
  regions: [],
  zones: ['Australia/Brisbane', 'Australia/Sydney'],
};

const mount = (initial = view(), canEdit = true) =>
  render(
    wrap(<StockLocations initial={initial} options={options} csrfToken="csrf" canEdit={canEdit} />),
  );

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('StockLocations', () => {
  it('lists the locations in order with the Default badge, address and zone', () => {
    mount();
    expect(screen.getByText('Default', { selector: 'span' })).toBeTruthy();
    expect(screen.getByText('1 Test St, Sunnybank')).toBeTruthy();
    expect(screen.getByText('Australia/Brisbane')).toBeTruthy();
    expect(screen.getByText('No address')).toBeTruthy();
  });

  it('hides every action without the edit permission', () => {
    mount(view(), false);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('adds a location with the version the screen read and shows the new list', async () => {
    call.mockResolvedValue({ ok: true, status: 201, body: view({ version: 5 }) });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add a location' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Shed' } });
    fireEvent.change(screen.getByLabelText(/^Address line 1|^line1/), {
      target: { value: '2 Test St' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'POST',
      'inventory/seller/sources',
      { expectedVersion: 4, name: 'Shed', address: { line1: '2 Test St' }, timeZone: null },
      'csrf',
    );
    expect(await screen.findByText('Saved.')).toBeTruthy();
  });

  it('edits a location through its own path', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: view({ version: 5 }) });
    mount();
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1] as HTMLElement);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Garage 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]?.[0]).toBe('PUT');
    expect(call.mock.calls[0]?.[1]).toBe(`inventory/seller/sources/${B}`);
    expect(call.mock.calls[0]?.[2]).toMatchObject({ expectedVersion: 4, name: 'Garage 2' });
  });

  it('moves a location up by sending the whole new order', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: view({ version: 5 }) });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Move Garage up' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'inventory/seller/sources-order',
      { expectedVersion: 4, orderedSourceIds: [B, A] },
      'csrf',
    );
  });

  it('disables the first up and the last down button', () => {
    mount();
    expect(screen.getByRole('button', { name: 'Move Default up' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.getByRole('button', { name: 'Move Garage down' }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it('turns off Add at the limit', () => {
    mount(view({ max: 2 }));
    expect(screen.getByRole('button', { name: 'Add a location' }).hasAttribute('disabled')).toBe(
      true,
    );
    expect(screen.getByText('You have reached the limit of 2 locations.')).toBeTruthy();
  });

  it('keeps the form open and names the field when the API refuses a value', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'name', code: 'length' }] },
      },
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add a location' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Check the fields marked below.')).toBeTruthy();
    expect(screen.getByText('This value is too short or too long.')).toBeTruthy();
    expect(screen.getByLabelText('Name')).toBeTruthy();
  });

  it('tells the seller to reload after a stale write', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 409, code: 'conflict.stale' } });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Move Garage up' }));
    expect(await screen.findByRole('button', { name: 'Reload the page' })).toBeTruthy();
  });
});

describe('helpers', () => {
  it('drops empty address fields and sends null for an empty address', () => {
    expect(addressOf({ line1: ' 1 St ', line2: '' })).toEqual({ line1: '1 St' });
    expect(addressOf({ line1: '', line2: '  ' })).toBeNull();
  });

  it('maps the limit refusal with its maximum', () => {
    expect(
      problemOf({
        status: 422,
        code: 'inventory.sources.limit-reached',
        details: { max: 5 } as never,
      }),
    ).toEqual({ form: { key: 'stock.error.limit', values: { max: 5 } }, fields: {} });
  });

  it('shows the stock page in the nav only with the view permission', () => {
    const ids = (keys: string[]) => visibleNavItems(sellerNav, new Set(keys)).map((i) => i.id);
    expect(ids([])).not.toContain('s_stock');
    expect(ids(['inventory.stock.view'])).toContain('s_stock');
  });
});
