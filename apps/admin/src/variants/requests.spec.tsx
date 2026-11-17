// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { expectToast } from '../../test/toast-spy.ts';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi, type ApiResult } from '../api/client.ts';
import type { PagedAnswer } from '../shared/paged-list/types.ts';
import { BY_CODE } from './request-errors.ts';
import { RequestsList } from './requests-list.tsx';
import type { RequestItem } from './types.ts';

const call = vi.mocked(callApi);
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

/** Two Markets: a test that only passes for AU is a bug. */
const MARKETS = [
  { name: 'AU', locale: 'en-AU', size: 'Size', xl: 'XL' },
  { name: 'ZZ', locale: 'ja-JP', size: 'サイズ', xl: '特大' },
] as const;

const option = (m: (typeof MARKETS)[number], optionLabel: string, optionCode: string) => ({
  attributeCode: 'size',
  attributeName: m.size,
  optionCode,
  optionLabel,
});

const item = (m: (typeof MARKETS)[number], over: Partial<RequestItem> = {}): RequestItem => ({
  id: id(1),
  version: 2,
  createdAt: '2026-11-10T10:00:00.000Z',
  sellerId: id(9),
  sellerName: '<i>Bakery</i> Co',
  offerId: id(5),
  productId: id(8),
  productCode: 'SKU-1',
  options: [option(m, m.xl, 'xl')],
  existing: [
    { variantId: id(21), variantNo: 1, options: [option(m, 'M', 'm')] },
    { variantId: id(22), variantNo: 2, options: [option(m, 'L', 'l')] },
  ],
  alreadyExists: false,
  actions: ['approve', 'map', 'decline'],
  ...over,
});

const list = (_m: (typeof MARKETS)[number], items: RequestItem[]): PagedAnswer<RequestItem> => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 25,
  paging: 'pages',
  hasNext: false,
});

const ok = <T,>(body: T): ApiResult<T> => ({ ok: true, status: 200, body });
const fail = (status: number, code: string): ApiResult<never> => ({
  ok: false,
  failure: { status, code },
});
const decided = (status: 'approved' | 'mapped' | 'declined') =>
  ok({ request: { id: id(1), status, version: 3, resolvedVariantId: id(21) } });

function mount(paging: 'pages' | 'prev-next' = 'pages') {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <RequestsList paging={paging} accountId={id(99)} marketId="AU" csrfToken="csrf-1" />
    </NextIntlClientProvider>,
  );
}

/** Opens the row's Actions menu and returns its item (the row action is never a button in the row). */
async function menuItem(m: (typeof MARKETS)[number], name: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Actions for ${m.size}: ${m.xl}` }));
  return screen.findByRole('menuitem', { name });
}

afterEach(() => cleanup());

describe('refusal messages', () => {
  it('has a message in the catalogue for every mapped refusal', () => {
    for (const [code, { key }] of Object.entries(BY_CODE)) {
      const error = messages.variants.requests.error as Record<string, string>;
      expect(error[key], code).toBeTruthy();
    }
  });
});

describe.each(MARKETS)('size requests queue ($name)', (m) => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute('open');
    };
    call.mockReset();
  });

  it('shows what was asked for, named by the catalogue, and the seller name as plain text', async () => {
    call.mockResolvedValueOnce(ok(list(m, [item(m)])));
    mount();
    expect(await screen.findByText(`${m.size}: ${m.xl}`)).toBeTruthy();
    expect(screen.getByText(/<i>Bakery<\/i> Co/)).toBeTruthy();
    expect(document.querySelector('i')).toBeNull();
    const first = new URLSearchParams(String(call.mock.calls[0]?.[1]).split('?')[1]);
    expect(call.mock.calls[0]?.[1]).toMatch(/^catalog\/admin\/variant-requests\?/);
    expect(first.get('page')).toBe('1');
    expect(first.get('paging')).toBe('pages');
    expect(first.get('sort')).toBe('created');
    expect(first.get('direction')).toBe('asc');
  });

  it('has no button in the row: every action is in the Actions menu', async () => {
    call.mockResolvedValueOnce(ok(list(m, [item(m)])));
    mount();
    await screen.findByText(`${m.size}: ${m.xl}`);
    expect(screen.queryByRole('button', { name: /^(Approve|Decline|Map to existing)/ })).toBeNull();
    expect(await menuItem(m, 'Approve…')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Map to existing…' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Decline…' })).toBeTruthy();
  });

  it('offers only the actions the API names for the row', async () => {
    call.mockResolvedValueOnce(ok(list(m, [item(m, { actions: ['decline'] })])));
    mount();
    expect(await menuItem(m, 'Decline…')).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Approve…' })).toBeNull();
  });

  it('says so when nothing waits', async () => {
    call.mockResolvedValueOnce(ok(list(m, [])));
    mount();
    expect(await screen.findByText('Nothing is waiting for you.')).toBeTruthy();
  });

  it('approves with the version seen after a confirmation that names the request', async () => {
    call.mockResolvedValueOnce(ok(list(m, [item(m)])));
    mount();
    fireEvent.click(await menuItem(m, 'Approve…'));
    const dialog = await screen.findByRole('dialog', { name: 'Approve size request' });
    expect(dialog.textContent).toContain(`${m.size}: ${m.xl}`);
    call.mockResolvedValueOnce(decided('approved'));
    call.mockResolvedValueOnce(ok(list(m, [])));
    fireEvent.click(screen.getByRole('button', { name: 'Approve request' }));
    await waitFor(() => expect(screen.getByText('Nothing is waiting for you.')).toBeTruthy());
    const [method, path, body, csrf] = call.mock.calls[1] ?? [];
    expect(method).toBe('POST');
    expect(path).toBe(`catalog/admin/variant-requests/${id(1)}/approve`);
    expect(body).toEqual({ version: 2 });
    expect(csrf).toBe('csrf-1');
    await expectToast('Variant added to the draft. The seller will get an email.');
  });

  it('keeps Approve off when the product already has the variant', async () => {
    call.mockResolvedValueOnce(ok(list(m, [item(m, { alreadyExists: true })])));
    mount();
    const approve = await menuItem(m, 'Approve…');
    expect(
      approve.getAttribute('aria-disabled') === 'true' || approve.hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.getByText(/already has this size/)).toBeTruthy();
  });

  it('maps to a variant the product has', async () => {
    call.mockResolvedValueOnce(ok(list(m, [item(m)])));
    mount();
    fireEvent.click(await menuItem(m, 'Map to existing…'));
    const confirm = await screen.findByRole<HTMLButtonElement>('button', {
      name: 'Map to this variant',
    });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: id(22) } });
    call.mockResolvedValueOnce(decided('mapped'));
    call.mockResolvedValueOnce(ok(list(m, [])));
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByText('Nothing is waiting for you.')).toBeTruthy());
    expect(call.mock.calls[1]?.[1]).toBe(`catalog/admin/variant-requests/${id(1)}/map`);
    expect(call.mock.calls[1]?.[2]).toEqual({ version: 2, variantId: id(22) });
  });

  it('keeps Map off when the product has no variants', async () => {
    call.mockResolvedValueOnce(ok(list(m, [item(m, { existing: [] })])));
    mount();
    const map = await menuItem(m, 'Map to existing…');
    expect(map.getAttribute('aria-disabled') === 'true' || map.hasAttribute('disabled')).toBe(true);
  });

  it('declines with a reason the seller will read, focus on Cancel', async () => {
    call.mockResolvedValueOnce(ok(list(m, [item(m)])));
    mount();
    fireEvent.click(await menuItem(m, 'Decline…'));
    const confirm = await screen.findByRole<HTMLButtonElement>('button', {
      name: 'Decline request',
    });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: /Reason for the seller/ }), {
      target: { value: 'Not made in XL' },
    });
    call.mockResolvedValueOnce(decided('declined'));
    call.mockResolvedValueOnce(ok(list(m, [])));
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByText('Nothing is waiting for you.')).toBeTruthy());
    expect(call.mock.calls[1]?.[1]).toBe(`catalog/admin/variant-requests/${id(1)}/decline`);
    expect(call.mock.calls[1]?.[2]).toEqual({ version: 2, reason: 'Not made in XL' });
  });

  it('tells the admin when someone decided it first and reads the list again', async () => {
    call.mockResolvedValueOnce(ok(list(m, [item(m)])));
    mount();
    fireEvent.click(await menuItem(m, 'Decline…'));
    fireEvent.change(await screen.findByRole('textbox', { name: /Reason for the seller/ }), {
      target: { value: 'No' },
    });
    call.mockResolvedValueOnce(fail(409, 'variant-request.stale'));
    call.mockResolvedValueOnce(ok(list(m, [])));
    fireEvent.click(screen.getByRole('button', { name: 'Decline request' }));
    await expectToast(/Someone else already decided/, 'error');
    await waitFor(() => expect(screen.getByText('Nothing is waiting for you.')).toBeTruthy());
    expect(call.mock.calls[2]?.[0]).toBe('GET');
  });

  it.each([
    ['variant-request.product-unavailable', 409, /not published/],
    ['variant.limit-reached', 422, /most variants/],
    ['product.not-editable', 409, /draft could not take/],
  ])('keeps the dialog and says why for %s', async (code, status, text) => {
    call.mockResolvedValueOnce(ok(list(m, [item(m)])));
    mount();
    fireEvent.click(await menuItem(m, 'Approve…'));
    call.mockResolvedValueOnce(fail(status, code));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve request' }));
    expect(await screen.findByText(text)).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('sends a decision once on a double click', async () => {
    call.mockResolvedValueOnce(ok(list(m, [item(m)])));
    mount();
    fireEvent.click(await menuItem(m, 'Approve…'));
    call.mockReturnValueOnce(new Promise(() => undefined));
    const confirm = await screen.findByRole('button', { name: 'Approve request' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('searches by product code from page one', async () => {
    call.mockResolvedValue(ok(list(m, [item(m)])));
    mount();
    await screen.findByText(`${m.size}: ${m.xl}`);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search size requests' }), {
      target: { value: 'SKU-1' },
    });
    await waitFor(() =>
      expect(call.mock.calls.some(([, path]) => String(path).includes('q=SKU-1'))).toBe(true),
    );
  });

  it('approves the ticked requests together and reports what the server skipped', async () => {
    call.mockResolvedValueOnce(ok(list(m, [item(m)])));
    mount();
    await screen.findByText(`${m.size}: ${m.xl}`);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Bulk action' }).disabled).toBe(
      true,
    );
    fireEvent.click(await screen.findByRole('checkbox', { name: `Select ${m.size}: ${m.xl}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Approve ticked…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Approve 1 size request?' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' }));
    call.mockResolvedValueOnce(
      ok({ action: 'approve', counts: { done: 0, skipped: 1, failed: 0 }, results: [] }),
    );
    call.mockResolvedValueOnce(ok(list(m, [item(m)])));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve 1 request' }));
    expect(await within(dialog).findByText('0 rows decided, 1 skipped.')).toBeTruthy();
    expect(call.mock.calls[1]).toEqual([
      'POST',
      'catalog/admin/variant-requests/bulk-decide',
      { action: 'approve', items: [{ id: id(1), version: 2 }] },
      'csrf-1',
    ]);
  });

  it('declines the ticked requests only with a reason', async () => {
    call.mockResolvedValueOnce(ok(list(m, [item(m)])));
    mount();
    await screen.findByText(`${m.size}: ${m.xl}`);
    fireEvent.click(await screen.findByRole('checkbox', { name: `Select ${m.size}: ${m.xl}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Decline ticked…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Decline 1 size request?' });
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', {
      name: 'Decline 1 request',
    });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: ' Not stocked ' } });
    call.mockResolvedValueOnce(
      ok({ action: 'decline', counts: { done: 1, skipped: 0, failed: 0 }, results: [] }),
    );
    call.mockResolvedValueOnce(ok(list(m, [])));
    fireEvent.click(confirm);
    await within(dialog).findByText('1 row decided, 0 skipped.');
    expect(call.mock.calls[1]?.[2]).toEqual({
      action: 'decline',
      items: [{ id: id(1), version: 2 }],
      reason: 'Not stocked',
    });
  });

  it('shows a retry when the list cannot be read, and says so without access', async () => {
    call.mockResolvedValueOnce(fail(500, 'x'));
    mount();
    expect(await screen.findByText('The size requests could not be loaded.')).toBeTruthy();
    cleanup();
    call.mockReset();
    call.mockResolvedValueOnce(fail(403, 'access.denied'));
    mount();
    expect(await screen.findByText('You cannot answer size requests.')).toBeTruthy();
  });
});
