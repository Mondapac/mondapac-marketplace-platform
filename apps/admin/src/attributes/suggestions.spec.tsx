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
    call.mockReset();
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
    fireEvent.click(await screen.findByRole('button', { name: 'Approve “<b>Oat</b> & honey”' }));
    const inputs = screen.getAllByRole('textbox');
    expect(inputs).toHaveLength(required.length + 1);
    expect((inputs[0] as HTMLInputElement).value).toBe('<b>Oat</b> & honey');
    const second = required.length > 1 ? (inputs[1] as HTMLInputElement) : undefined;
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

  it('asks for a value code when the default name has no Latin letters, and sends it', async () => {
    const list0 = list(locales, required);
    const first = list0.items[0];
    if (first === undefined) throw new Error('fixture');
    call.mockResolvedValueOnce(ok({ ...list0, items: [{ ...first, label: 'جو' }] }));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve “جو”' }));
    for (const input of screen.getAllByRole('textbox')) {
      if (input.getAttribute('name') !== 'option-code') {
        fireEvent.change(input, { target: { value: 'جو' } });
      }
    }
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'Approve value' });
    const code = screen.getByLabelText('Value code');
    // The default name has no Latin letters in the AU fixture's text too: a code is needed.
    expect(confirm.disabled).toBe(true);
    fireEvent.change(code, { target: { value: 'Barley' } });
    expect(confirm.disabled).toBe(false);
    call.mockResolvedValueOnce(
      ok({ suggestion: { id: id(1), status: 'approved', version: 4, optionCode: 'barley' } }),
    );
    call.mockResolvedValueOnce(ok({ ...list0, items: [] }));
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByText('Nothing is waiting for you.')).toBeTruthy());
    expect(call.mock.calls[1]?.[2]).toMatchObject({ version: 3, optionCode: 'barley' });
  });

  it('maps to an existing value', async () => {
    call.mockResolvedValueOnce(ok(list(locales, required)));
    mount();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Map “<b>Oat</b> & honey” to an existing value' }),
    );
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
    fireEvent.click(await screen.findByRole('button', { name: 'Reject “<b>Oat</b> & honey”' }));
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

  it('tells the admin above the list, without a skeleton, when someone decided it first', async () => {
    call.mockResolvedValueOnce(ok(list(locales, required)));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Reject “<b>Oat</b> & honey”' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'No' } });
    call.mockResolvedValueOnce(fail(409, 'suggestion.stale'));
    call.mockResolvedValueOnce(ok({ ...list(locales, required), items: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject suggestion' }));
    expect(await screen.findByText(/Someone else already decided/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Nothing is waiting for you.')).toBeTruthy());
    expect(call.mock.calls[2]?.[0]).toBe('GET');
  });

  it('keeps the form open on a refusal that the admin can fix', async () => {
    call.mockResolvedValueOnce(ok(list(locales, required)));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve “<b>Oat</b> & honey”' }));
    for (const input of screen
      .getAllByRole('textbox')
      .filter((box) => box.getAttribute('name') !== 'option-code')) {
      fireEvent.change(input, { target: { value: 'Oat honey' } });
    }
    call.mockResolvedValueOnce(fail(422, 'attribute.claim-word'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve value' }));
    expect(await screen.findByText(/only a certificate can back/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve value' })).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('sends a decision once on a double click', async () => {
    call.mockResolvedValueOnce(ok(list(locales, required)));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Reject “<b>Oat</b> & honey”' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'No' } });
    call.mockResolvedValueOnce(
      ok({ suggestion: { id: id(1), status: 'rejected', version: 4, optionCode: null } }),
    );
    call.mockResolvedValue(ok({ ...list(locales, required), items: [] }));
    const button = screen.getByRole('button', { name: 'Reject suggestion' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText('Nothing is waiting for you.')).toBeTruthy());
    expect(call.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
  });

  it('shows a retry when the list cannot be read, and the denied text on a 403', async () => {
    call.mockResolvedValueOnce(fail(500, 'unknown'));
    mount();
    expect(await screen.findByText('The suggestions could not be loaded.')).toBeTruthy();
    call.mockResolvedValueOnce(ok(list(locales, required)));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('“<b>Oat</b> & honey”')).toBeTruthy();
    cleanup();
    call.mockResolvedValueOnce(fail(403, 'access.denied'));
    mount();
    expect(await screen.findByText(/You cannot decide value suggestions/)).toBeTruthy();
  });

  it('moves focus into the form it opens', async () => {
    call.mockResolvedValueOnce(ok(list(locales, required)));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Reject “<b>Oat</b> & honey”' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox')));
  });
});
