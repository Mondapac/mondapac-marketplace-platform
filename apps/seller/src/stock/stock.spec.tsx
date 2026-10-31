// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { problemOf } from './errors.ts';
import { addressOf } from './stock-form.tsx';
import { StockLocations } from './stock-locations.tsx';
import type { SourcesView, StockFormOptions } from './types.ts';
import { expectToast } from '../../test/toast-spy.ts';

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
    { key: 'line1', labelKey: 'sellers.address.line1', required: true, maxLength: 120 },
    { key: 'suburb', labelKey: 'sellers.address.suburb', required: true, maxLength: 120 },
  ],
  regionField: null,
  regions: [],
  zones: ['Australia/Brisbane', 'Australia/Sydney'],
};

const mount = (initial = view(), canEdit = true) =>
  render(
    wrap(<StockLocations initial={initial} options={options} csrfToken="csrf" canEdit={canEdit} />),
  );

/** One row of the Compare list: the saved and typed values, read as text. */
const compared = (label: string | RegExp) => {
  const list = screen.getByRole('list', { name: 'Changes compared' });
  const item = within(list).getByText(label).closest('li')!;
  const [saved, yours] = [...item.querySelectorAll('q')].map((q) => q.textContent);
  return { saved, yours, item };
};

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('StockLocations', () => {
  it('lists the locations in order with the Default badge, address and zone', () => {
    mount();
    expect(screen.getByText('Default', { selector: 'span' })).toBeTruthy();
    // Street first, then the place, each on its own line.
    expect(screen.getByText('1 Test St Sunnybank').textContent).toBe('1 Test St\nSunnybank');
    expect(screen.getByText('Australia/Brisbane')).toBeTruthy();
    expect(screen.getByText('No address')).toBeTruthy();
  });

  it('hides every action without the edit permission', () => {
    mount(view(), false);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/You can see your stock locations but not change them/)).toBeTruthy();
  });

  it('is a list in a section of the template, with no save bar', () => {
    mount();
    expect(screen.getByRole('heading', { level: 1, name: 'Stock locations' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Your locations' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Garage' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
  });

  it('adds a location with the version the screen read and shows the new list', async () => {
    call.mockResolvedValue({ ok: true, status: 201, body: view({ version: 5 }) });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add a location' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Shed' } });
    fireEvent.change(screen.getByLabelText(/^Street address/), {
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
    await expectToast('Saved.');
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

  it('shows only the moves that do something: no up on the first, no down on the last', () => {
    mount();
    expect(screen.queryByRole('button', { name: 'Move Default up' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Move Default down' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Move Garage up' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Move Garage down' })).toBeNull();
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
    // The summary at the top of the form links to the field.
    const summary = screen
      .getAllByRole('alert')
      .find((node) => node.textContent?.includes('needs fixing before you can save'))!;
    expect(summary.textContent).toContain('1 setting needs fixing before you can save');
    fireEvent.click(within(summary).getByRole('link', { name: 'Name' }));
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
    expect(screen.getByLabelText('Name').getAttribute('aria-invalid')).toBe('true');
  });

  it('refreshes the list after a stale move and says so', async () => {
    call
      .mockResolvedValueOnce({ ok: false, failure: { status: 409, code: 'conflict.stale' } })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: view({
          version: 7,
          sources: [view().sources[0]!, { ...view().sources[1]!, name: 'Shed' }],
        }),
      });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Move Garage up' }));
    expect(await screen.findByText(/The list is up to date now/)).toBeTruthy();
    expect(call).toHaveBeenNthCalledWith(2, 'GET', 'inventory/seller/sources');
    expect(screen.getByText('Shed')).toBeTruthy();
    expect(screen.queryByText('Garage')).toBeNull();
  });

  it('keeps the open editor draft after a stale save and shows the saved location next to it', async () => {
    call
      .mockResolvedValueOnce({ ok: false, failure: { status: 409, code: 'conflict.stale' } })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: view({
          version: 7,
          sources: [
            view().sources[0]!,
            {
              ...view().sources[1]!,
              name: '<i>Shed</i>',
              address: { line1: '9 Other Rd', suburb: 'Sunnybank' },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, body: view({ version: 8 }) });
    mount();
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1]!);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Warehouse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Someone else saved these settings first')).toBeTruthy();
    expect(call).toHaveBeenNthCalledWith(
      1,
      'PUT',
      `inventory/seller/sources/${B}`,
      expect.objectContaining({ expectedVersion: 4, name: 'Warehouse' }),
      'csrf',
    );
    expect(call).toHaveBeenNthCalledWith(2, 'GET', 'inventory/seller/sources');
    // The draft is kept in the open editor.
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('Warehouse');

    fireEvent.click(screen.getByRole('button', { name: 'Show what changed' }));
    const name = compared('Name');
    expect(name).toMatchObject({ saved: '<i>Shed</i>', yours: 'Warehouse' });
    expect(name.item.querySelector('i')).toBeNull();
    // Address rows use the form's own (translated) labels, not the field keys.
    expect(compared('Street address')).toMatchObject({ saved: '9 Other Rd', yours: '1 Test St' });

    // The next save names the version read after the conflict.
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(3));
    expect(call).toHaveBeenNthCalledWith(
      3,
      'PUT',
      `inventory/seller/sources/${B}`,
      expect.objectContaining({ expectedVersion: 7, name: 'Warehouse' }),
      'csrf',
    );
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
        details: { max: 5 },
      }),
    ).toEqual({ form: { key: 'stock.error.limit', values: { max: 5 } }, fields: {} });
  });
});
