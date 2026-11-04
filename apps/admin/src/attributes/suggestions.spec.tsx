// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { expectToast } from '../../test/toast-spy.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi, type ApiResult } from '../api/client.ts';
import { SuggestionsTab } from './suggestions-tab.tsx';
import type { SuggestionList, MarketLocales } from './types.ts';

const call = vi.mocked(callApi);
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

/** Two Markets: a test that only passes for AU is a bug. */
const MARKETS: readonly {
  readonly name: string;
  readonly locales: MarketLocales;
  readonly required: string[];
}[] = [
  { name: 'AU', locales: { default: 'en-AU', supported: ['en-AU'] }, required: ['en-AU'] },
  {
    name: 'ZZ',
    locales: { default: 'ja-JP', supported: ['ja-JP', 'fa-IR'] },
    required: ['ja-JP', 'fa-IR'],
  },
];

const list = (locales: MarketLocales, required: string[]): SuggestionList => ({
  locales,
  requiredLocales: required,
  items: [
    {
      id: id(1),
      version: 3,
      label: '<b>Oat</b> & honey',
      createdAt: '2026-11-03T10:00:00.000Z',
      sellerId: id(9),
      productId: id(8),
      productCode: 'SKU-1',
      attribute: {
        id: id(7),
        code: 'flavour',
        names: { [locales.default]: 'Flavour' },
        multi: false,
        options: [{ code: 'plain', labels: { [locales.default]: 'Plain' } }],
      },
    },
  ],
});

const ok = <T,>(body: T): ApiResult<T> => ({ ok: true, status: 200, body });
const fail = (status: number, code: string): ApiResult<never> => ({
  ok: false,
  failure: { status, code },
});

function mount(canDecide = true) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <SuggestionsTab canDecide={canDecide} csrfToken="csrf-1" />
    </NextIntlClientProvider>,
  );
}

afterEach(() => cleanup());

describe.each(MARKETS)('value suggestions queue ($name)', ({ locales, required }) => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the seller words as plain text and asks nothing without the decide key', async () => {
    call.mockResolvedValue(ok(list(locales, required)));
    mount();
    expect(await screen.findByText('“<b>Oat</b> & honey”')).toBeTruthy();
    expect(document.querySelector('b')).toBeNull();
    cleanup();
    call.mockClear();
    mount(false);
    expect(screen.getByText(/You cannot decide value suggestions/)).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('approves with a name in every required language and the version seen', async () => {
    call.mockResolvedValueOnce(ok(list(locales, required)));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    const inputs = screen.getAllByRole('textbox');
    expect(inputs).toHaveLength(required.length);
    expect((inputs[0] as HTMLInputElement).value).toBe('<b>Oat</b> & honey');
    const second = inputs[1] as HTMLInputElement | undefined;
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Approve value' });
    if (second !== undefined) {
      expect(confirm.disabled).toBe(true);
      fireEvent.change(second, { target: { value: 'Oat honey (fa)' } });
    }
    call.mockResolvedValueOnce(
      ok({ suggestion: { id: id(1), status: 'approved', version: 4, optionCode: 'oat-honey' } }),
    );
    call.mockResolvedValueOnce(ok({ ...list(locales, required), items: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve value' }));
    await waitFor(() => expect(screen.getByText('Nothing is waiting for you.')).toBeTruthy());
    const [method, path, body, csrf] = call.mock.calls[1] ?? [];
    expect(method).toBe('POST');
    expect(path).toBe(`catalog/admin/attribute-suggestions/${id(1)}/approve`);
    expect(csrf).toBe('csrf-1');
    expect(body).toMatchObject({ version: 3 });
    expect(Object.keys((body as { labels: object }).labels)).toEqual(required);
    await expectToast('Value added. The seller was told.');
  });

  it('maps to an existing value', async () => {
    call.mockResolvedValueOnce(ok(list(locales, required)));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Map to existing' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'plain' } });
    call.mockResolvedValueOnce(
      ok({ suggestion: { id: id(1), status: 'mapped', version: 4, optionCode: 'plain' } }),
    );
    call.mockResolvedValueOnce(ok({ ...list(locales, required), items: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Map to this value' }));
    await waitFor(() => expect(screen.getByText('Nothing is waiting for you.')).toBeTruthy());
    expect(call.mock.calls[1]?.[2]).toEqual({ version: 3, optionCode: 'plain' });
  });

  it('rejects with a reason the seller will read', async () => {
    call.mockResolvedValueOnce(ok(list(locales, required)));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    const reject = screen.getByRole<HTMLButtonElement>('button', { name: 'Reject suggestion' });
    expect(reject.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Not a flavour' } });
    call.mockResolvedValueOnce(
      ok({ suggestion: { id: id(1), status: 'rejected', version: 4, optionCode: null } }),
    );
    call.mockResolvedValueOnce(ok({ ...list(locales, required), items: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject suggestion' }));
    await waitFor(() => expect(screen.getByText('Nothing is waiting for you.')).toBeTruthy());
    expect(call.mock.calls[1]?.[2]).toEqual({ version: 3, reason: 'Not a flavour' });
  });

  it('says so and reads the list again when someone decided it first', async () => {
    call.mockResolvedValueOnce(ok(list(locales, required)));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'No' } });
    call.mockResolvedValueOnce(fail(409, 'suggestion.stale'));
    call.mockResolvedValueOnce(ok({ ...list(locales, required), items: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject suggestion' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(3));
    expect(call.mock.calls[2]?.[0]).toBe('GET');
  });
});
