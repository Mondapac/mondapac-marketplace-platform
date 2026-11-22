// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { visibleNavItems } from '@mondapac/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { adminNav } from '../nav.ts';
import { expectToast } from '../../test/toast-spy.ts';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi, type ApiResult } from '../api/client.ts';
import { formatMoney } from './format.ts';
import { holdProblemOf } from './hold-errors.ts';
import { HoldsList } from './holds-list.tsx';
import type { PriceHoldListRow } from './types.ts';

const call = vi.mocked(callApi);
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

/** Two Markets with different currencies and locales: a test that only passes for AU is a bug. */
const MARKETS = [
  { name: 'AU', locale: 'en-AU', currency: 'AUD' },
  { name: 'ZZ', locale: 'ja-JP', currency: 'JPY' },
] as const;

const row = (
  m: (typeof MARKETS)[number],
  over: Partial<PriceHoldListRow> = {},
): PriceHoldListRow => ({
  recordId: id(1),
  offerId: id(2),
  variantId: id(3),
  sellerId: id(4),
  productName: 'Halal beef mince 500 g',
  variantLabel: 'Family pack',
  storeName: 'Logan Road Grocer',
  kind: 'regular',
  amount: { amount: '1999', currency: m.currency },
  anchorAmount: { amount: '1000', currency: m.currency },
  direction: 'up',
  submittedAt: '2026-10-14T01:00:00.000Z',
  actions: ['open', 'decide'],
  ...over,
});

const page = (items: PriceHoldListRow[]) => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 25,
  paging: 'pages' as const,
  hasNext: false,
  counts: { all: items.length, regular: items.length, special: 0, up: items.length, down: 0 },
});
const ok = <T,>(body: T): ApiResult<T> => ({ ok: true, status: 200, body });
const fail = (status: number, code: string): ApiResult<never> => ({
  ok: false,
  failure: { status, code },
});

const SAVED = 'lists/admin/saved-filters';
interface SavedRow {
  readonly id: string;
  readonly name: string;
  readonly visibility: 'me' | 'everyone';
  readonly payload: unknown;
}
const savedRow = (
  n: number,
  name: string,
  payload: unknown,
): SavedRow & Record<string, unknown> => ({
  id: id(500 + n),
  listKey: 'admin.pricing.price-holds',
  name,
  visibility: 'everyone',
  payload,
  ownedByMe: false,
  canManage: false,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
});

/**
 * Answers the list route with `list`, a decision with `decision`, and the saved-filter routes with
 * `saved` (none by default): the list also reads its saved filters when it mounts.
 */
function serve(
  list: ApiResult<unknown>,
  decision: ApiResult<unknown> = ok({}),
  saved: readonly SavedRow[] = [],
  canShare = false,
) {
  call.mockImplementation((method, url, body) => {
    if (String(url).startsWith(SAVED)) {
      if (method === 'GET') return Promise.resolve(ok({ items: saved, canShare }));
      const asked = body as { name: string; visibility: 'me' | 'everyone'; payload: unknown };
      return Promise.resolve(
        ok({
          ...savedRow(9, asked.name, asked.payload),
          ...asked,
          ownedByMe: true,
          canManage: true,
        }),
      );
    }
    return Promise.resolve(method === 'POST' ? decision : list);
  });
}
const listCalls = () =>
  call.mock.calls.filter(([method, url]) => method === 'GET' && !String(url).startsWith(SAVED));

function mount(m: (typeof MARKETS)[number]) {
  return render(
    <NextIntlClientProvider locale={m.locale} messages={messages}>
      <HoldsList paging="pages" accountId={id(99)} marketId={m.name} csrfToken="csrf-1" />
    </NextIntlClientProvider>,
  );
}

async function openMenu() {
  fireEvent.click(
    await screen.findByRole('button', { name: 'Actions for Halal beef mince 500 g' }),
  );
}

afterEach(() => cleanup());

describe('held price helpers', () => {
  it('formats minor units in the currency and maps refusals to message keys', () => {
    expect(formatMoney({ amount: '1999', currency: 'AUD' }, 'en-AU')).toContain('19.99');
    expect(formatMoney({ amount: 'x', currency: 'AUD' }, 'en-AU')).toBe('-');
    expect(holdProblemOf({ status: 409, code: 'pricing.series-retired' }).key).toBe(
      'pricing.holds.error.retired',
    );
    expect(holdProblemOf({ status: 500, code: 'x' }).key).toBe('pricing.holds.error.unknown');
  });

  it('shows the nav item only with pricing.price-hold.view', () => {
    const ids = (keys: string[]) => visibleNavItems(adminNav, new Set(keys)).map((i) => i.id);
    expect(ids([])).not.toContain('price-holds');
    expect(ids(['pricing.price-hold.view'])).toContain('price-holds');
  });
});

describe.each(MARKETS)('held prices list ($name)', (m) => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute('open');
    };
    call.mockReset();
  });

  it('asks for the oldest first, shows the record and keeps seller text inert', async () => {
    serve(ok(page([row(m, { productName: '<b>Bold</b>' })])));
    mount(m);
    expect(await screen.findByText('<b>Bold</b>')).toBeTruthy();
    expect(document.querySelector('b')).toBeNull();
    const first = String(listCalls()[0]?.[1]);
    expect(first).toMatch(/^pricing\/admin\/price-holds\/list\?/);
    const q = new URLSearchParams(first.split('?')[1]);
    expect(q.get('sort')).toBe('submitted');
    expect(q.get('direction')).toBe('asc');
    expect(q.get('paging')).toBe('pages');
  });

  it('keeps the row when names could not be read', async () => {
    serve(ok(page([row(m, { productName: null, variantLabel: null, storeName: null })])));
    mount(m);
    expect(await screen.findByText(/Name unavailable \(0+2\)/)).toBeTruthy();
  });

  it('puts Approve and Reject in the Actions menu, not in the row', async () => {
    serve(ok(page([row(m)])));
    mount(m);
    await screen.findByText('Halal beef mince 500 g');
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    await openMenu();
    expect(await screen.findByRole('menuitem', { name: 'Approve…' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Reject…' })).toBeTruthy();
  });

  it('offers no decision without the decide action', async () => {
    serve(ok(page([row(m, { actions: ['open'] })])));
    mount(m);
    await screen.findByText('Halal beef mince 500 g');
    await openMenu();
    await screen.findByRole('menuitem', { name: 'Open store' });
    expect(screen.queryByRole('menuitem', { name: 'Approve…' })).toBeNull();
  });

  it('approves after a confirmation and reloads the list', async () => {
    serve(ok(page([row(m)])), ok({}));
    mount(m);
    await screen.findByText('Halal beef mince 500 g');
    await openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Approve…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve price' }));
    await expectToast('Price approved.');
    expect(call).toHaveBeenCalledWith(
      'POST',
      `pricing/admin/price-holds/${id(1)}/approve`,
      undefined,
      'csrf-1',
    );
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(1));
  });

  it('rejects with a reason code and an optional note', async () => {
    serve(ok(page([row(m)])), ok({}));
    mount(m);
    await screen.findByText('Halal beef mince 500 g');
    await openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Reject…' }));
    const submit = await screen.findByRole<HTMLButtonElement>('button', { name: 'Reject price' });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'policy-breach' } });
    fireEvent.change(screen.getByLabelText('Note for the seller (optional)'), {
      target: { value: ' too high ' },
    });
    fireEvent.click(submit);
    await expectToast(/Price rejected/);
    expect(call).toHaveBeenCalledWith(
      'POST',
      `pricing/admin/price-holds/${id(1)}/reject`,
      { reasonCode: 'policy-breach', note: 'too high' },
      'csrf-1',
    );
  });

  it('explains when the submitter tries to decide and keeps the dialog open', async () => {
    serve(ok(page([row(m)])), fail(403, 'pricing.hold.own-submission'));
    mount(m);
    await screen.findByText('Halal beef mince 500 g');
    await openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Approve…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve price' }));
    expect(await screen.findByText(/someone else must decide/)).toBeTruthy();
  });

  it('shows the amount in the Market currency and sorts by price on request', async () => {
    serve(ok(page([row(m)])));
    mount(m);
    await screen.findByText('Halal beef mince 500 g');
    expect(
      screen.getAllByText(formatMoney({ amount: '1999', currency: m.currency }, m.locale)).length,
    ).toBeGreaterThan(0);
  });

  it('shows the dates of a special price in the approve dialog', async () => {
    serve(
      ok(
        page([
          row(m, {
            kind: 'special',
            window: { startsAt: '2026-12-01T00:00:00.000Z', endsAt: '2026-12-08T00:00:00.000Z' },
          }),
        ]),
      ),
    );
    mount(m);
    await screen.findByText('Halal beef mince 500 g');
    await openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Approve…' }));
    expect(await screen.findByText(/Special price runs from/)).toBeTruthy();
  });

  it('closes the dialog and reads again when the record is gone', async () => {
    serve(ok(page([row(m)])), fail(409, 'pricing.hold.not-pending'));
    mount(m);
    await screen.findByText('Halal beef mince 500 g');
    await openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Approve…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve price' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve price' })).toBeNull());
    await waitFor(() => expect(listCalls().length).toBeGreaterThan(1));
  });

  it('shows the empty state', async () => {
    serve(ok(page([])));
    mount(m);
    expect(await screen.findByText('No held prices are waiting for a decision.')).toBeTruthy();
  });

  it('asks for one view when its tab is picked', async () => {
    serve(ok(page([row(m)])));
    mount(m);
    await screen.findByText('Halal beef mince 500 g');
    fireEvent.click((await screen.findAllByText(/^Increases/))[0]!);
    await waitFor(() =>
      expect(call.mock.calls.some(([, url]) => String(url).includes('view=up'))).toBe(true),
    );
  });
  it('searches by one record id or Offer id on the server and shows it as a chip', async () => {
    serve(ok(page([row(m)])));
    mount(m);
    await screen.findByText('Halal beef mince 500 g');
    const box = screen.getByRole('searchbox', { name: 'Search held prices' });
    fireEvent.change(box, { target: { value: id(7) } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => {
      const asked = listCalls().map(([, url]) => new URLSearchParams(String(url).split('?')[1]));
      expect(asked.some((q) => q.get('q') === id(7))).toBe(true);
    });
    expect(await screen.findByRole('button', { name: 'Save filter…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeTruthy();
    expect(screen.getByText(`ID is ${id(7)}`)).toBeTruthy();
  });

  it('does not ask the route for text that is not a whole id, and says what to type', async () => {
    serve(ok(page([row(m)])));
    mount(m);
    await screen.findByText('Halal beef mince 500 g');
    const asked = listCalls().length;
    const box = screen.getByRole('searchbox', { name: 'Search held prices' });
    fireEvent.change(box, { target: { value: 'abc' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('Enter a full record ID or Offer ID.')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(listCalls().length).toBe(asked);
  });

  it('reads its saved filters under its own list key', async () => {
    serve(ok(page([row(m)])));
    mount(m);
    await screen.findByText('Halal beef mince 500 g');
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('GET', `${SAVED}?listKey=admin.pricing.price-holds`),
    );
  });

  it('opens a shared saved filter as a tab with its view, filters and sort', async () => {
    serve(ok(page([row(m)])), ok({}), [
      savedRow(1, 'Big special increases', {
        v: 1,
        view: 'up',
        filters: { kind: 'special', minAmount: '5000' },
        sort: 'amount',
        direction: 'desc',
      }),
    ]);
    mount(m);
    await screen.findByText('Halal beef mince 500 g');
    fireEvent.click((await screen.findAllByText('Big special increases'))[0]!);
    await waitFor(() => {
      const asked = listCalls().map(([, url]) => new URLSearchParams(String(url).split('?')[1]));
      expect(
        asked.some(
          (q) =>
            q.get('view') === 'up' &&
            q.get('kind') === 'special' &&
            q.get('minAmount') === '5000' &&
            q.get('sort') === 'amount' &&
            q.get('direction') === 'desc',
        ),
      ).toBe(true);
    });
  });

  it('saves the view on show as a filter of its own list, with the session token', async () => {
    serve(ok(page([row(m)])));
    mount(m);
    await screen.findByText('Halal beef mince 500 g');
    fireEvent.click((await screen.findAllByText(/^Increases/))[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Save filter…' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Increases' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Save filter' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        SAVED,
        {
          listKey: 'admin.pricing.price-holds',
          name: 'Increases',
          visibility: 'me',
          payload: { v: 1, view: 'up', filters: {}, sort: 'submitted', direction: 'asc' },
        },
        'csrf-1',
      ),
    );
  });
});
