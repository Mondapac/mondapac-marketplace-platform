// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { expectToast } from '../../test/toast-spy.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi, type ApiResult } from '../api/client.ts';
import { ValueSuggestionsList } from './value-suggestions-list.tsx';
import type { MarketLocales } from './types.ts';

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

/** The list answer: the page contract plus the Market's languages and the row actions. */
const list = (
  locales: MarketLocales,
  required: string[],
  actions = ['approve', 'map', 'reject'],
) => ({
  locales,
  requiredLocales: required,
  total: 1,
  page: 1,
  pageSize: 25,
  paging: 'pages',
  hasNext: false,
  items: [
    {
      id: id(1),
      version: 3,
      label: '<b>Oat</b> & honey',
      createdAt: '2026-11-03T10:00:00.000Z',
      sellerId: id(9),
      productId: id(8),
      productCode: 'SKU-1',
      actions,
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
const empty = (locales: MarketLocales, required: string[]) => ({
  ...list(locales, required),
  items: [],
  total: 0,
});

const ok = <T,>(body: T): ApiResult<T> => ({ ok: true, status: 200, body });
const fail = (status: number, code: string): ApiResult<never> => ({
  ok: false,
  failure: { status, code },
});

function mount() {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <ValueSuggestionsList paging="pages" accountId={id(99)} marketId="AU" csrfToken="csrf-1" />
    </NextIntlClientProvider>,
  );
}
const LABEL = '<b>Oat</b> & honey';
/** Opens the row's Actions menu and picks an item: no row action is a button in the row. */
async function act(item: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Actions for ${LABEL}` }));
  fireEvent.click(await screen.findByRole('menuitem', { name: item }));
  return screen.findByRole('dialog');
}
const posts = () => call.mock.calls.filter(([method]) => method === 'POST');

afterEach(() => cleanup());

describe.each(MARKETS)('value suggestions queue ($name)', ({ locales, required }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    call.mockReset();
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })) as unknown as typeof window.matchMedia;
  });

  it('shows the seller words as plain text, and asks for the oldest first', async () => {
    call.mockResolvedValue(ok(list(locales, required)));
    mount();
    expect(await screen.findByText(`“${LABEL}”`)).toBeTruthy();
    expect(document.querySelector('b')).toBeNull();
    // The Market's languages arrive with the first answer; they do not read the list again.
    expect(call.mock.calls.filter(([m]) => m === 'GET')).toHaveLength(1);
    const query = new URLSearchParams(String(call.mock.calls[0]?.[1]).split('?')[1]);
    expect(query.get('sort')).toBe('created');
    expect(query.get('direction')).toBe('asc');
    expect(query.get('paging')).toBe('pages');
    expect(screen.getByRole('link', { name: 'Flavour' }).getAttribute('href')).toBe(
      `/catalog/attributes/${id(7)}`,
    );
  });

  it('keeps every decision in the Actions menu, and only those the API names', async () => {
    call.mockResolvedValue(ok(list(locales, required, ['reject'])));
    mount();
    await screen.findByText(`“${LABEL}”`);
    expect(screen.queryByRole('button', { name: /^Approve|^Reject/ })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: `Actions for ${LABEL}` }));
    expect(await screen.findByRole('menuitem', { name: 'Reject…' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Approve…' })).toBeNull();
  });

  it('approves with a name in every required language and the version seen', async () => {
    call.mockResolvedValueOnce(ok(list(locales, required)));
    mount();
    const dialog = await act('Approve…');
    const inputs = within(dialog).getAllByRole('textbox');
    expect(inputs).toHaveLength(required.length + 1);
    expect((inputs[0] as HTMLInputElement).value).toBe(LABEL);
    const second = required.length > 1 ? (inputs[1] as HTMLInputElement) : undefined;
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', {
      name: 'Approve value',
    });
    if (second !== undefined) {
      expect(confirm.disabled).toBe(true);
      fireEvent.change(second, { target: { value: 'Oat honey (fa)' } });
    }
    call.mockResolvedValueOnce(
      ok({ suggestion: { id: id(1), status: 'approved', version: 4, optionCode: 'oat-honey' } }),
    );
    call.mockResolvedValue(ok(empty(locales, required)));
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByText('Nothing is waiting for you')).toBeTruthy());
    const [method, path, body, csrf] = posts()[0] ?? [];
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
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for جو' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Approve…' }));
    const dialog = await screen.findByRole('dialog');
    for (const input of within(dialog).getAllByRole('textbox')) {
      if (input.getAttribute('name') !== 'option-code') {
        fireEvent.change(input, { target: { value: 'جو' } });
      }
    }
    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', {
      name: 'Approve value',
    });
    // The default name has no Latin letters: a code is needed.
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Value code'), { target: { value: 'Barley' } });
    expect(confirm.disabled).toBe(false);
    call.mockResolvedValueOnce(
      ok({ suggestion: { id: id(1), status: 'approved', version: 4, optionCode: 'barley' } }),
    );
    call.mockResolvedValue(ok(empty(locales, required)));
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByText('Nothing is waiting for you')).toBeTruthy());
    expect(posts()[0]?.[2]).toMatchObject({ version: 3, optionCode: 'barley' });
  });

  it('maps to an existing value', async () => {
    call.mockResolvedValueOnce(ok(list(locales, required)));
    mount();
    const dialog = await act('Map to existing value…');
    fireEvent.change(within(dialog).getByRole('combobox'), { target: { value: 'plain' } });
    call.mockResolvedValueOnce(
      ok({ suggestion: { id: id(1), status: 'mapped', version: 4, optionCode: 'plain' } }),
    );
    call.mockResolvedValue(ok(empty(locales, required)));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Map to this value' }));
    await waitFor(() => expect(screen.getByText('Nothing is waiting for you')).toBeTruthy());
    expect(posts()[0]?.[2]).toEqual({ version: 3, optionCode: 'plain' });
  });

  it('offers no mapping when the field has no values yet', async () => {
    const list0 = list(locales, required);
    const first = list0.items[0];
    if (first === undefined) throw new Error('fixture');
    call.mockResolvedValueOnce(
      ok({ ...list0, items: [{ ...first, attribute: { ...first.attribute, options: [] } }] }),
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: `Actions for ${LABEL}` }));
    expect(await screen.findByRole('menuitem', { name: 'Approve…' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Map to existing value…' })).toBeNull();
  });

  it('rejects with a reason the seller will read, with Cancel focused first', async () => {
    call.mockResolvedValueOnce(ok(list(locales, required)));
    mount();
    const dialog = await act('Reject…');
    await waitFor(() =>
      expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Cancel' })),
    );
    const reject = within(dialog).getByRole<HTMLButtonElement>('button', {
      name: 'Reject suggestion',
    });
    expect(reject.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Not a flavour' } });
    call.mockResolvedValueOnce(
      ok({ suggestion: { id: id(1), status: 'rejected', version: 4, optionCode: null } }),
    );
    call.mockResolvedValue(ok(empty(locales, required)));
    fireEvent.click(reject);
    await waitFor(() => expect(screen.getByText('Nothing is waiting for you')).toBeTruthy());
    expect(posts()[0]?.[2]).toEqual({ version: 3, reason: 'Not a flavour' });
  });

  it('tells the admin above the list when someone decided it first', async () => {
    call.mockResolvedValueOnce(ok(list(locales, required)));
    mount();
    const dialog = await act('Reject…');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'No' } });
    call.mockResolvedValueOnce(fail(409, 'suggestion.stale'));
    call.mockResolvedValue(ok(empty(locales, required)));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject suggestion' }));
    expect(await screen.findByText(/Someone else already decided/)).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Nothing is waiting for you')).toBeTruthy());
  });

  it('keeps the dialog open on a refusal that the admin can fix', async () => {
    call.mockResolvedValueOnce(ok(list(locales, required)));
    mount();
    const dialog = await act('Approve…');
    for (const input of within(dialog)
      .getAllByRole('textbox')
      .filter((box) => box.getAttribute('name') !== 'option-code')) {
      fireEvent.change(input, { target: { value: 'Oat honey' } });
    }
    call.mockResolvedValueOnce(fail(422, 'attribute.claim-word'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve value' }));
    expect(await within(dialog).findByText(/only a certificate can back/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Approve value' })).toBeTruthy();
    expect(posts()).toHaveLength(1);
  });

  it('sends a decision once on a double click', async () => {
    call.mockResolvedValueOnce(ok(list(locales, required)));
    mount();
    const dialog = await act('Reject…');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'No' } });
    call.mockResolvedValueOnce(
      ok({ suggestion: { id: id(1), status: 'rejected', version: 4, optionCode: null } }),
    );
    call.mockResolvedValue(ok(empty(locales, required)));
    const button = within(dialog).getByRole('button', { name: 'Reject suggestion' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText('Nothing is waiting for you')).toBeTruthy());
    expect(posts()).toHaveLength(1);
  });

  it('shows a retry when the list cannot be read', async () => {
    call.mockResolvedValueOnce(fail(500, 'unknown'));
    mount();
    expect(await screen.findByText(/could not be loaded/)).toBeTruthy();
    call.mockResolvedValueOnce(ok(list(locales, required)));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(`“${LABEL}”`)).toBeTruthy();
  });

  it('sends an ended session to sign-in, on a decision', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    call.mockResolvedValueOnce(ok(list(locales, required)));
    mount();
    const dialog = await act('Reject…');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'No' } });
    call.mockResolvedValueOnce(fail(401, 'identity.session-ended'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject suggestion' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    vi.unstubAllGlobals();
  });
});
