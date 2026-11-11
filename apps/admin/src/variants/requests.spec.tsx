// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { expectToast } from '../../test/toast-spy.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi, type ApiResult } from '../api/client.ts';
import { RequestsTab } from './requests-tab.tsx';
import type { RequestItem, RequestList } from './types.ts';

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
  ...over,
});

const list = (m: (typeof MARKETS)[number], items: RequestItem[]): RequestList => ({
  items,
  locales: { default: m.locale, supported: [m.locale] },
});

const ok = <T,>(body: T): ApiResult<T> => ({ ok: true, status: 200, body });
const fail = (status: number, code: string): ApiResult<never> => ({
  ok: false,
  failure: { status, code },
});
const decided = (status: 'approved' | 'mapped' | 'declined') =>
  ok({ request: { id: id(1), status, version: 3, resolvedVariantId: id(21) } });

function mount() {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <RequestsTab csrfToken="csrf-1" />
    </NextIntlClientProvider>,
  );
}

afterEach(() => cleanup());

describe.each(MARKETS)('size requests queue ($name)', (m) => {
  beforeEach(() => {
    call.mockReset();
  });

  it('shows what was asked for, named by the catalogue, and the seller name as plain text', async () => {
    call.mockResolvedValueOnce(ok(list(m, [item(m)])));
    mount();
    expect(await screen.findByRole('heading', { name: `${m.size}: ${m.xl}` })).toBeTruthy();
    expect(screen.getByText(/<i>Bakery<\/i> Co/)).toBeTruthy();
    expect(document.querySelector('i')).toBeNull();
    expect(call.mock.calls[0]).toEqual(['GET', 'catalog/admin/variant-requests']);
  });

  it('says so when nothing waits', async () => {
    call.mockResolvedValueOnce(ok(list(m, [])));
    mount();
    expect(await screen.findByText('Nothing is waiting for you.')).toBeTruthy();
  });

  it('approves with the version seen', async () => {
    call.mockResolvedValueOnce(ok(list(m, [item(m)])));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: `Approve ${m.size}: ${m.xl}` }));
    call.mockResolvedValueOnce(decided('approved'));
    call.mockResolvedValueOnce(ok(list(m, [])));
    fireEvent.click(screen.getByRole('button', { name: 'Approve request' }));
    await waitFor(() => expect(screen.getByText('Nothing is waiting for you.')).toBeTruthy());
    const [method, path, body, csrf] = call.mock.calls[1] ?? [];
    expect(method).toBe('POST');
    expect(path).toBe(`catalog/admin/variant-requests/${id(1)}/approve`);
    expect(body).toEqual({ version: 2 });
    expect(csrf).toBe('csrf-1');
    await expectToast('Variant added to the draft. The seller was told.');
  });

  it('keeps Approve off when the product already has the variant', async () => {
    call.mockResolvedValueOnce(ok(list(m, [item(m, { alreadyExists: true })])));
    mount();
    const approve = await screen.findByRole<HTMLButtonElement>('button', {
      name: `Approve ${m.size}: ${m.xl}`,
    });
    expect(approve.disabled).toBe(true);
    expect(screen.getByText(/already has this variant/)).toBeTruthy();
  });

  it('maps to a variant the product has', async () => {
    call.mockResolvedValueOnce(ok(list(m, [item(m)])));
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: `Map to existing: ${m.size}: ${m.xl}` }),
    );
    const confirm = screen.getByRole<HTMLButtonElement>('button', {
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

  it('disables Map when the product has no variants', async () => {
    call.mockResolvedValueOnce(ok(list(m, [item(m, { existing: [] })])));
    mount();
    const map = await screen.findByRole<HTMLButtonElement>('button', {
      name: `Map to existing: ${m.size}: ${m.xl}`,
    });
    expect(map.disabled).toBe(true);
    expect(screen.getByText('This product has no variants to map to.')).toBeTruthy();
  });

  it('declines with a reason the seller will read', async () => {
    call.mockResolvedValueOnce(ok(list(m, [item(m)])));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: `Decline ${m.size}: ${m.xl}` }));
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Decline request' });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Not made in XL' } });
    call.mockResolvedValueOnce(decided('declined'));
    call.mockResolvedValueOnce(ok(list(m, [])));
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByText('Nothing is waiting for you.')).toBeTruthy());
    expect(call.mock.calls[1]?.[1]).toBe(`catalog/admin/variant-requests/${id(1)}/decline`);
    expect(call.mock.calls[1]?.[2]).toEqual({ version: 2, reason: 'Not made in XL' });
  });

  it('tells the admin above the list when someone decided it first', async () => {
    call.mockResolvedValueOnce(ok(list(m, [item(m)])));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: `Decline ${m.size}: ${m.xl}` }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'No' } });
    call.mockResolvedValueOnce(fail(409, 'variant-request.stale'));
    call.mockResolvedValueOnce(ok(list(m, [])));
    fireEvent.click(screen.getByRole('button', { name: 'Decline request' }));
    expect(await screen.findByText(/Someone else already decided/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Nothing is waiting for you.')).toBeTruthy());
    expect(call.mock.calls[2]?.[0]).toBe('GET');
  });

  it('keeps the card and says why when the product cannot take the variant', async () => {
    call.mockResolvedValueOnce(ok(list(m, [item(m)])));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: `Approve ${m.size}: ${m.xl}` }));
    call.mockResolvedValueOnce(fail(409, 'variant-request.product-unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve request' }));
    expect(await screen.findByText(/not published/)).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('sends a decision once on a double click', async () => {
    call.mockResolvedValueOnce(ok(list(m, [item(m)])));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: `Approve ${m.size}: ${m.xl}` }));
    call.mockReturnValueOnce(new Promise(() => undefined));
    const confirm = screen.getByRole('button', { name: 'Approve request' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('shows a retry when the list cannot be read, and a notice on a refusal', async () => {
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
