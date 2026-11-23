// @vitest-environment jsdom
import { Toaster, toast } from '@mondapac/ui';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import type { ListPaging, OwnPayoutRow, OwnPayouts } from '../payout-types.ts';
import { PayoutsList } from './payouts-list.tsx';

const call = vi.mocked(callApi);
const PATH = 'commission-payouts/seller/payouts';
const KEY = (market: string) =>
  `mp:seller:${market}:0190a000-0000-7000-8000-0000000000f1:payouts-columns`;
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const OPEN = (name: string) => screen.getByRole('button', { name });

// Two Market fixtures: Australia (AUD, two decimals) and a synthetic one with another currency,
// another locale and a store zone that is not the Market's (JPY has no decimals).
const AU = {
  market: 'AU',
  locale: 'en-AU',
  marketZone: 'Australia/Brisbane',
  zone: 'Pacific/Auckland',
  currency: 'AUD',
  exponent: 2,
} as const;
const JP = {
  market: 'JP',
  locale: 'en-US',
  marketZone: 'America/New_York',
  zone: 'Asia/Tokyo',
  currency: 'JPY',
  exponent: 0,
} as const;
type Fixture = typeof AU | typeof JP;

const row = (n: number, over: Partial<OwnPayoutRow> = {}, fx: Fixture = AU): OwnPayoutRow => ({
  payoutId: id(n),
  status: 'paid',
  gross: { amountMinor: '120410', currency: fx.currency },
  netted: { amountMinor: '0', currency: fx.currency },
  transfer: { amountMinor: '120410', currency: fx.currency },
  slotAt: '2026-10-26T23:00:00.000Z',
  createdAt: '2026-10-26T04:00:00.000Z',
  updatedAt: '2026-10-27T01:00:00.000Z',
  reason: null,
  actions: ['open'],
  ...over,
});
const COUNTS = {
  all: 31,
  scheduled: 2,
  'awaiting-approval': 1,
  'on-its-way': 0,
  paid: 25,
  'not-sent': 1,
  failed: 1,
  settled: 1,
} as const;
const pageOf = (rows: OwnPayoutRow[], over: Partial<OwnPayouts> = {}): OwnPayouts => ({
  payouts: rows,
  counts: COUNTS,
  total: null,
  page: null,
  pageSize: 25,
  nextCursor: null,
  ...over,
});
const pages = (rows: OwnPayoutRow[], total: number, over: Partial<OwnPayouts> = {}) =>
  pageOf(rows, { total, page: 1, ...over });
const ok = (body: OwnPayouts) => ({ ok: true as const, status: 200, body });

function serve(make: (url: string) => OwnPayouts) {
  call.mockImplementation((_m: string, path: string) => Promise.resolve(ok(make(path))));
}
const asked = () => call.mock.calls.filter(([, path]) => path.startsWith(PATH));
const lastUrl = (): string => String(asked()[asked().length - 1]?.[1]);
const paramsOf = (url: string) => Object.fromEntries(new URL(`http://x/${url}`).searchParams);

function mount(initial: OwnPayouts | null, paging: ListPaging = 'prev-next', fx: Fixture = AU) {
  return render(
    <NextIntlClientProvider locale={fx.locale} timeZone={fx.marketZone} messages={messages}>
      <PayoutsList
        initial={initial}
        paging={paging}
        zone={fx.zone}
        currency={fx.currency}
        accountId="0190a000-0000-7000-8000-0000000000f1"
        marketId={fx.market}
      />
      <Toaster labels={{ region: 'Action notifications', close: 'Close notification' }} />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  call.mockReset();
  window.localStorage.clear();
  serve(() => pageOf([row(1)]));
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const heads = () =>
  within(screen.getByRole('table'))
    .getAllByRole('columnheader')
    .map((head) => head.textContent)
    .filter((name) => name !== '' && name !== 'Actions');

describe('payout list rows', () => {
  it('shows the payout day first, in the store zone, with the status and the amount', () => {
    mount(pageOf([row(1)]));
    const table = screen.getByRole('table', { name: 'Payout history' });
    expect(heads()).toEqual(['Payout on', 'Status', 'Details', 'Amount']);
    // 23:00 UTC on 26 Oct is noon on 27 Oct in Auckland (NZDT), not the Market's Brisbane clock.
    expect(within(table).getByText(/27 Oct.*12:00 pm.*NZDT/)).toBeTruthy();
    expect(within(table).getByText('Paid')).toBeTruthy();
    expect(within(table).getByText('$1,204.10')).toBeTruthy();
    expect(screen.queryByText(/Dates and days are in/)).toBeNull();
    // The server's page is the first answer: the list asks for nothing more.
    expect(asked()).toHaveLength(0);
  });

  it('has a view for each status with its count, and asks for the status', async () => {
    mount(pageOf([row(1)]));
    expect(OPEN('All (31)')).toBeTruthy();
    expect(OPEN('Planned (2)')).toBeTruthy();
    fireEvent.click(OPEN('Failed (1)'));
    await waitFor(() =>
      expect(paramsOf(lastUrl())).toMatchObject({ status: 'failed', limit: '25' }),
    );
  });

  it('puts every row action in the Actions menu: no button in a row but the menu and the box', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mount(pageOf([row(1)]));
    const body = within(screen.getByRole('table')).getAllByRole('row')[1]!;
    expect(
      within(body)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label') ?? button.textContent),
    ).toEqual(['Actions for Payout 00000001']);
    fireEvent.click(OPEN('Actions for Payout 00000001'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy payout ID' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(id(1)));
    expect(await screen.findByText('Payout ID copied')).toBeTruthy();
    toast.dismiss();
  });

  it('shows Created on and Updated on only when chosen, and keeps the choice per Market and account', async () => {
    mount(pageOf([row(1)]));
    expect(heads()).not.toContain('Created on');
    fireEvent.click(OPEN('Columns'));
    const panel = await screen.findByRole('dialog', { name: 'Columns' });
    expect(within(panel).getByRole('checkbox', { name: 'Created on' })).toBeTruthy();
    expect(within(panel).getByRole('checkbox', { name: 'Updated on' })).toBeTruthy();
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Created on' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    expect(heads()).toEqual(['Payout on', 'Status', 'Details', 'Amount', 'Created on']);
    expect(JSON.parse(window.localStorage.getItem(KEY('AU')) ?? 'null')).toEqual([
      'note',
      'amount',
      'created',
    ]);
  });

  it('reads the stored choice and ignores unknown ids', async () => {
    window.localStorage.setItem(KEY('AU'), JSON.stringify(['updated', 'nope', 'gross']));
    mount(pageOf([row(1)]));
    await waitFor(() => expect(heads()).toEqual(['Payout on', 'Status', 'Updated on', 'Earned']));
  });
});

describe('payout list empty, error and loading states', () => {
  it('says so when the seller has no payout at all', () => {
    mount(pageOf([], { counts: { ...COUNTS, all: 0 } }));
    expect(screen.getByText('No payouts yet')).toBeTruthy();
  });

  it('has a filtered empty state with a way to clear it', async () => {
    mount(pageOf([row(1)]), 'pages');
    serve(() => pages([], 0));
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: 'minAmount' } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value: '5000' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('No payouts match')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear all' })[0]!);
    await waitFor(() => expect(paramsOf(lastUrl())['minAmount']).toBeUndefined());
  });

  it('offers Try again when the first page could not be read, and when a page cannot be loaded', async () => {
    mount(null);
    expect(screen.getByText('Your payout history could not be loaded.')).toBeTruthy();
    serve(() => pageOf([row(1)]));
    fireEvent.click(OPEN('Try again'));
    expect(await screen.findByText('Paid')).toBeTruthy();
    call.mockResolvedValue({ ok: false, failure: { status: 503, code: 'access.unavailable' } });
    fireEvent.click(OPEN('Failed (1)'));
    expect(await screen.findByText('Your payout history could not be loaded.')).toBeTruthy();
    expect(OPEN('Try again')).toBeTruthy();
  });

  it('never retries a query the API refused', async () => {
    mount(pageOf([row(1)]));
    call.mockResolvedValue({ ok: false, failure: { status: 400, code: 'validation.failed' } });
    fireEvent.click(OPEN('Paid (25)'));
    expect(await screen.findByText(/This search can't be run/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('sends a signed-out seller to the session-ended route', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    mount(pageOf([row(1)]));
    call.mockResolvedValue({ ok: false, failure: { status: 401, code: 'session.invalid' } });
    fireEvent.click(OPEN('Paid (25)'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    vi.unstubAllGlobals();
  });
});

describe('payout list paging', () => {
  it('walks the API cursor with Previous and Next, with no total', async () => {
    mount(pageOf([row(1)], { nextCursor: 'slot.1793998800000.a' }));
    expect(screen.queryByText(/ of /)).toBeNull();
    serve(() => pageOf([row(2)], { nextCursor: null }));
    fireEvent.click(OPEN('Next'));
    expect(await screen.findByText('Paid')).toBeTruthy();
    expect(paramsOf(lastUrl())).toEqual({ limit: '25', cursor: 'slot.1793998800000.a' });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Next' }).disabled).toBe(true);
    serve(() => pageOf([row(1)], { nextCursor: 'slot.1793998800000.a' }));
    fireEvent.click(OPEN('Previous'));
    await waitFor(() => expect(paramsOf(lastUrl())).toEqual({ limit: '25' }));
  });

  it('starts again from the first page, with no cursor, when the view changes', async () => {
    mount(pageOf([row(1)], { nextCursor: 'slot.1.a' }));
    serve(() => pageOf([row(2)], { nextCursor: 'slot.2.b' }));
    fireEvent.click(OPEN('Next'));
    await waitFor(() => expect(paramsOf(lastUrl())['cursor']).toBe('slot.1.a'));
    fireEvent.click(OPEN('Paid (25)'));
    await waitFor(() => expect(paramsOf(lastUrl())).toEqual({ status: 'paid', limit: '25' }));
  });

  it('shows page numbers with the total, the range and the 10,000 row limit', async () => {
    mount(pages([row(1)], 12_345), 'pages');
    expect(screen.getByText('1 to 1 of 12,345')).toBeTruthy();
    expect(screen.getByText(/Page numbers stop at the first 10,000 payouts/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Page 401' })).toBeNull();
    serve((url) => pages([row(1)], 12_345, { page: Number(paramsOf(url)['page']) }));
    fireEvent.click(OPEN('Page 2'));
    await waitFor(() =>
      expect(paramsOf(lastUrl())).toMatchObject({
        page: '2',
        pageSize: '25',
        sort: 'slot',
        direction: 'desc',
      }),
    );
  });

  it('goes back a page once when the last page has no rows left', async () => {
    mount(pages([row(1)], 60), 'pages');
    serve((url) =>
      paramsOf(url)['page'] === '3' ? pages([], 30, { page: 3 }) : pages([row(1)], 30, { page: 2 }),
    );
    fireEvent.click(OPEN('Page 3'));
    await waitFor(() => expect(paramsOf(lastUrl())['page']).toBe('2'));
  });
});

describe('payout list sort', () => {
  it('names the sort of the payout day first, newest first, as the default', () => {
    mount(pages([row(1)], 3), 'pages');
    expect(screen.getByText('Sorted by Payout on, Newest first')).toBeTruthy();
  });

  it('offers the payout day, the amount and (once shown) Created on with page numbers', async () => {
    mount(pages([row(1)], 3), 'pages');
    serve(() => pages([row(1)], 3));
    fireEvent.click(OPEN('Sort'));
    const panel = await screen.findByRole('dialog', { name: 'Sort' });
    expect(within(panel).getByRole('radio', { name: 'Payout on' })).toBeTruthy();
    expect(within(panel).getByRole('radio', { name: 'Amount' })).toBeTruthy();
    expect(within(panel).queryByRole('radio', { name: 'Created on' })).toBeNull();
    // The first label of a field is its default direction.
    fireEvent.click(within(panel).getByRole('radio', { name: 'Amount' }));
    await waitFor(() =>
      expect(paramsOf(lastUrl())).toMatchObject({ sort: 'amount', direction: 'desc' }),
    );
    expect(within(panel).getByRole('radio', { name: 'Highest first' })).toBeTruthy();
    fireEvent.click(within(panel).getByRole('radio', { name: 'Lowest first' }));
    await waitFor(() =>
      expect(paramsOf(lastUrl())).toMatchObject({ sort: 'amount', direction: 'asc' }),
    );
    expect(screen.getByText('Sorted by Amount, Lowest first')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('radio', { name: 'Payout on' }));
    fireEvent.click(within(panel).getByRole('radio', { name: 'Oldest first' }));
    await waitFor(() =>
      expect(paramsOf(lastUrl())).toMatchObject({ sort: 'slot', direction: 'asc' }),
    );
  });

  it('has no amount sort and no direction with Previous and Next, and sorts by Created on only when shown', async () => {
    window.localStorage.setItem(KEY('AU'), JSON.stringify(['note', 'amount', 'created']));
    mount(pageOf([row(1)]));
    await waitFor(() => expect(heads()).toContain('Created on'));
    fireEvent.click(OPEN('Sort'));
    const panel = await screen.findByRole('dialog', { name: 'Sort' });
    const choices = within(panel)
      .getAllByRole<HTMLInputElement>('radio')
      .map((radio) => radio.labels?.[0]?.textContent);
    expect(choices).toEqual(['Payout on: Newest first', 'Created on: Newest first']);
    fireEvent.click(within(panel).getByRole('radio', { name: 'Created on: Newest first' }));
    await waitFor(() => expect(paramsOf(lastUrl())).toEqual({ limit: '25', sort: 'created' }));
    expect(screen.getByText('Sorted by Created on, Newest first')).toBeTruthy();
  });
});

describe.each([AU, JP])('payout list filters in the $market Market', (fx) => {
  const mountFx = (rows: OwnPayoutRow[] = [row(1, {}, fx)], paging: ListPaging = 'pages') => {
    serve(() => pages(rows, 1));
    return mount(pages(rows, 1), paging, fx);
  };
  async function apply(field: string, value: string) {
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: field } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
  }

  it('reads the payout day presets on the store clock, not the Market clock, and names the chip', async () => {
    // 12:30 UTC on 17 Nov: the 17th in Brisbane and New York, the 18th in Auckland and Tokyo
    // (Tokyo is 21:30 on the 17th: use the offsets of each zone below).
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-17T12:30:00.000Z'));
    mountFx();
    await apply('payoutOn', 'next-7-days');
    const window7 =
      fx.zone === 'Pacific/Auckland'
        ? { from: '2026-11-17T11:00:00.000Z', to: '2026-11-24T11:00:00.000Z' }
        : { from: '2026-11-16T15:00:00.000Z', to: '2026-11-23T15:00:00.000Z' };
    await waitFor(() => expect(paramsOf(lastUrl())).toMatchObject(window7));
    expect(
      screen.getByRole('button', { name: 'Remove filter Payout on: Next 7 days' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Payout on: Next 7 days' }));
    await waitFor(() => expect(paramsOf(lastUrl())['from']).toBeUndefined());
  });

  it('sends "Next 30 days" and the shared presets as store-zone day starts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-17T12:30:00.000Z'));
    mountFx();
    await apply('payoutOn', 'next-30-days');
    await waitFor(() => expect(paramsOf(lastUrl())['from']).toBeDefined());
    const asks = paramsOf(lastUrl());
    expect(new Date(asks['to']!).getTime() - new Date(asks['from']!).getTime()).toBe(
      30 * 86_400_000,
    );
    // Day starts at midnight on the store clock.
    const midnight = new Intl.DateTimeFormat('en-GB', {
      timeZone: fx.zone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(asks['from']!));
    expect(midnight).toBe('00:00');
  });

  it('sends the amount steps in minor units of the currency, and the chips say them in whole units', async () => {
    mountFx();
    await apply('minAmount', '50');
    await waitFor(() =>
      expect(paramsOf(lastUrl())['minAmount']).toBe(fx.exponent === 2 ? '5000' : '50'),
    );
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Add condition' }));
    const fields = within(panel).getAllByLabelText('Field');
    fireEvent.change(fields[fields.length - 1]!, { target: { value: 'maxAmount' } });
    const values = within(panel).getAllByLabelText('Value');
    fireEvent.change(values[values.length - 1]!, { target: { value: '1000' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(paramsOf(lastUrl())).toMatchObject({
        minAmount: fx.exponent === 2 ? '5000' : '50',
        maxAmount: fx.exponent === 2 ? '100000' : '1000',
      }),
    );
    expect(
      screen.getByRole('button', {
        name: new RegExp(`^Remove filter Amount at least: .*50$`),
      }),
    ).toBeTruthy();
    expect(screen.getByText('1 payout matches')).toBeTruthy();
  });

  it('shows the amounts in the currency of the payout', () => {
    mountFx([row(1, { transfer: { amountMinor: '120410', currency: fx.currency } }, fx)]);
    const cell = within(screen.getByRole('table'))
      .getAllByRole('cell')
      .map((c) => c.textContent);
    expect(cell.join(' ')).toContain(fx.currency === 'AUD' ? '$1,204.10' : '120,410');
  });
});

describe('payout list search', () => {
  it('searches by a whole payout id and says what to type for other text', async () => {
    mount(pageOf([row(1)]));
    const box = screen.getByRole('searchbox', { name: 'Search payouts' });
    fireEvent.change(box, { target: { value: id(1).toUpperCase() } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(paramsOf(lastUrl())['q']).toBe(id(1)));
    expect(screen.getByText(`Payout: ${id(1).toUpperCase()}`)).toBeTruthy();
    const count = call.mock.calls.length;
    fireEvent.change(box, { target: { value: 'weekly' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText(/Type a whole payout ID/)).toBeTruthy();
    expect(call.mock.calls.length).toBe(count);
  });
});

describe('payout list selection and export', () => {
  const CSV = { 'content-type': 'text/csv; charset=utf-8' };
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const click = vi.fn();
  const createUrl = vi.fn(() => 'blob:payouts');
  const tick = () =>
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all payouts on this page' }));
  const openExport = async (mode: 'ticked' | 'all' = 'ticked') => {
    tick();
    if (mode === 'all') fireEvent.click(OPEN('Select all 60 matching'));
    fireEvent.click(OPEN('Bulk action'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Export/ }));
    return screen.findByRole('dialog', { name: /^Export/ });
  };
  const confirm = (dialog: HTMLElement, format: 'CSV' | 'XLSX' = 'CSV') => {
    fireEvent.click(within(dialog).getByRole('radio', { name: new RegExp(`^${format}`) }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
  };
  const answer = (make: () => Response) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(make()));
  const sent = (fetched: { mock: { calls: unknown[][] } }) => {
    const url = new URL(String(fetched.mock.calls[0]?.[0]), 'http://x');
    return { path: url.pathname, params: Object.fromEntries(url.searchParams) };
  };
  const mountPages = (over: Partial<OwnPayouts> = {}) => mount(pages([row(1)], 60, over), 'pages');

  beforeEach(() => {
    click.mockReset();
    createUrl.mockClear();
    URL.createObjectURL = createUrl;
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(click);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    toast.dismiss();
  });

  it('keeps Export as the only bulk action, off until a row is ticked', async () => {
    mountPages();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Bulk action' }).disabled).toBe(
      true,
    );
    tick();
    fireEvent.click(OPEN('Bulk action'));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual([expect.stringMatching(/^Export…/)]);
  });

  it('selects the page, then every matching payout, and clears', () => {
    mountPages();
    tick();
    expect(screen.getByText('1 payout selected')).toBeTruthy();
    fireEvent.click(OPEN('Select all 60 matching'));
    expect(screen.getByText('All 60 matching payouts are selected')).toBeTruthy();
    fireEvent.click(OPEN('Clear selection'));
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it('says "Select all matching" with no number under Previous and Next', () => {
    mount(pageOf([row(1)], { nextCursor: 'slot.1.a' }));
    tick();
    expect(OPEN('Select all matching')).toBeTruthy();
  });

  it('names the ticked payouts by id and adds the shown optional columns in order', async () => {
    window.localStorage.setItem(KEY('AU'), JSON.stringify(['note', 'updated', 'gross', 'created']));
    mountPages();
    await waitFor(() => expect(heads()).toContain('Updated on'));
    const dialog = await openExport();
    const fetched = answer(
      () =>
        new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
          status: 200,
          headers: { 'content-type': XLSX },
        }),
    );
    confirm(dialog, 'XLSX');
    expect(await screen.findByText('Exported 1 payout.')).toBeTruthy();
    const { path, params } = sent(fetched);
    expect(path).toBe('/api/commission-payouts/seller/payouts/export');
    expect(params).toEqual({ ids: id(1), format: 'xlsx', columns: 'updated,gross,created' });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('exports every matching payout with the selector and the sort after "Select all matching"', async () => {
    mountPages();
    serve(() => pages([row(1)], 60));
    fireEvent.click(OPEN('Paid (25)'));
    await waitFor(() => expect(paramsOf(lastUrl())['status']).toBe('paid'));
    const dialog = await openExport('all');
    expect(within(dialog).getByText('Export 60 payouts')).toBeTruthy();
    const fetched = answer(
      () => new Response('Payout ID\r\nrow\r\n', { status: 200, headers: CSV }),
    );
    confirm(dialog);
    expect(await screen.findByText('Exported 1 payout.')).toBeTruthy();
    expect(sent(fetched).params).toEqual({
      status: 'paid',
      sort: 'slot',
      direction: 'desc',
      format: 'csv',
    });
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('exports on the window the rows were read with (the preset is not read again)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-17T12:30:00.000Z'));
    mountPages();
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: 'payoutOn' } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value: 'next-7-days' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(paramsOf(lastUrl())['from']).toBe('2026-11-17T11:00:00.000Z'));
    serve(() => pages([row(1)], 60));
    fireEvent.click(OPEN('Paid (25)'));
    await waitFor(() => expect(paramsOf(lastUrl())['status']).toBe('paid'));
    // Two days later the read window is still the one of the rows on show.
    vi.setSystemTime(new Date('2026-11-19T12:30:00.000Z'));
    const dialog = await openExport('all');
    const fetched = answer(() => new Response('x\r\nrow\r\n', { status: 200, headers: CSV }));
    confirm(dialog);
    await screen.findByText('Exported 1 payout.');
    expect(sent(fetched).params).toMatchObject({
      from: '2026-11-17T11:00:00.000Z',
      to: '2026-11-24T11:00:00.000Z',
      status: 'paid',
    });
  });

  it('tells the seller to narrow the filter when the file would be too large (413)', async () => {
    mountPages();
    const dialog = await openExport();
    answer(
      () =>
        new Response(
          JSON.stringify({ code: 'batch.too-large', details: { max: 10000, total: 12345 } }),
          { status: 413 },
        ),
    );
    confirm(dialog);
    expect(await screen.findByText(/12,345 match, and one file holds up to 10,000/)).toBeTruthy();
    expect(createUrl).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it('says the export cannot be done on a refused query (400), saving no file', async () => {
    mountPages();
    const dialog = await openExport();
    answer(() => new Response(JSON.stringify({ code: 'validation.failed' }), { status: 400 }));
    confirm(dialog);
    expect(await screen.findByText(/That export can’t be done/)).toBeTruthy();
    expect(createUrl).not.toHaveBeenCalled();
  });

  it('says the store zone could not be read when the API cannot write the dates (503), saving no file', async () => {
    mountPages();
    const dialog = await openExport();
    answer(
      () =>
        new Response(JSON.stringify({ code: 'commission-payouts.unavailable' }), { status: 503 }),
    );
    confirm(dialog);
    expect(await screen.findByText(/needs your store’s time zone/)).toBeTruthy();
    expect(createUrl).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it('says the export did not work after any other failure or a response that is not the file', async () => {
    mountPages();
    let dialog = await openExport();
    answer(() => new Response('{}', { status: 503 }));
    confirm(dialog);
    expect(await screen.findByText('The export didn’t work. Try again.')).toBeTruthy();
    toast.dismiss();
    vi.restoreAllMocks();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(click);
    dialog = await screen.findByRole('dialog', { name: /^Export/ }).catch(() => dialog);
    answer(
      () =>
        new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    fireEvent.click(OPEN('Bulk action'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Export/ }));
    confirm(await screen.findByRole('dialog', { name: /^Export/ }));
    await waitFor(() =>
      expect(screen.getAllByText('The export didn’t work. Try again.')).toBeTruthy(),
    );
    expect(createUrl).not.toHaveBeenCalled();
  });
});

describe('payout list review follow-ups', () => {
  const many = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => row(from + i));
  const tickPage = () =>
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all payouts on this page' }));

  it('stops ticking rows at the 200 cap: the 201st row cannot be ticked', async () => {
    mount(pages(many(1000, 100), 201, { pageSize: 100 }), 'pages');
    tickPage();
    serve((url) =>
      pages(many(2000, 100), 201, { pageSize: 100, page: Number(paramsOf(url)['page']) }),
    );
    fireEvent.click(OPEN('Page 2'));
    await screen.findAllByRole('checkbox', { name: /^Select Payout/ });
    await waitFor(() => expect(paramsOf(lastUrl())['page']).toBe('2'));
    tickPage();
    expect(screen.getByText('200 payouts selected')).toBeTruthy();
    serve((url) => pages([row(3000)], 201, { pageSize: 100, page: Number(paramsOf(url)['page']) }));
    fireEvent.click(OPEN('Page 3'));
    await waitFor(() => expect(paramsOf(lastUrl())['page']).toBe('3'));
    const box = await screen.findByRole<HTMLInputElement>('checkbox', { name: /^Select Payout/ });
    expect(box.disabled).toBe(true);
    expect(screen.getByText('200 payouts selected')).toBeTruthy();
  });

  it('clears the selection when a filter or the sort changes', async () => {
    mount(pages([row(1)], 40), 'pages');
    serve(() => pages([row(1)], 40));
    tickPage();
    expect(screen.getByText('1 payout selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: 'minAmount' } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value: '10' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(screen.queryByText(/payouts? selected/)).toBeNull());
    tickPage();
    expect(screen.getByText('1 payout selected')).toBeTruthy();
    fireEvent.click(OPEN('Sort'));
    const sort = await screen.findByRole('dialog', { name: 'Sort' });
    fireEvent.click(within(sort).getByRole('radio', { name: 'Amount' }));
    await waitFor(() => expect(screen.queryByText(/payouts? selected/)).toBeNull());
  });

  it('drops the cursor when the sort flips to or from Created on', async () => {
    window.localStorage.setItem(KEY('AU'), JSON.stringify(['note', 'created']));
    mount(pageOf([row(1)], { nextCursor: 'slot.1.a' }));
    await waitFor(() => expect(heads()).toContain('Created on'));
    serve(() => pageOf([row(2)], { nextCursor: 'slot.2.b' }));
    fireEvent.click(OPEN('Next'));
    await waitFor(() => expect(paramsOf(lastUrl())['cursor']).toBe('slot.1.a'));
    fireEvent.click(OPEN('Sort'));
    const panel = await screen.findByRole('dialog', { name: 'Sort' });
    fireEvent.click(within(panel).getByRole('radio', { name: 'Created on: Newest first' }));
    await waitFor(() => expect(paramsOf(lastUrl())).toEqual({ limit: '25', sort: 'created' }));
    fireEvent.click(OPEN('Next'));
    await waitFor(() => expect(paramsOf(lastUrl())['cursor']).toBe('slot.2.b'));
    fireEvent.click(within(panel).getByRole('radio', { name: 'Payout on: Newest first' }));
    await waitFor(() => expect(paramsOf(lastUrl())).toEqual({ limit: '25' }));
  });

  it('shows the year of a payout day that is not in the current year', () => {
    mount(pageOf([row(1, { slotAt: '2024-03-05T00:00:00.000Z' })]));
    expect(within(screen.getByRole('table')).getByText(/5 Mar 2024/)).toBeTruthy();
  });

  it('phone layout: lines are labelled, and a Details line with no value is left out', () => {
    mount(pageOf([row(1), row(2, { status: 'failed' })]));
    const cells = [...document.querySelectorAll('tbody td[data-label]')];
    expect(cells.some((cell) => cell.getAttribute('data-label') === 'Amount')).toBe(true);
    // The paid row has no details: its cell holds the marker the phone stylesheet hides.
    expect(document.querySelectorAll('td > [data-empty-line]')).toHaveLength(1);
    const css = readFileSync(join(__dirname, '../../../app/globals.css'), 'utf8');
    expect(css).toMatch(
      /max-width: 1023\.98px[\s\S]*td:has\(> \[data-empty-line\]\)[\s\S]*display: none/,
    );
    expect(screen.getByText('Select page')).toBeTruthy();
  });

  it('saves the API bytes of a CSV, so the byte-order mark survives', async () => {
    const save = vi.fn();
    const createUrl = vi.fn((blob: Blob) => {
      save(blob);
      return 'blob:x';
    });
    URL.createObjectURL = createUrl;
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode('Payout ID\r\nrow\r\n'),
    ]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(bytes, { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8' } }),
    );
    mount(pages([row(1)], 60), 'pages');
    tickPage();
    fireEvent.click(OPEN('Bulk action'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Export/ }));
    const dialog = await screen.findByRole('dialog', { name: /^Export/ });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    const blob = save.mock.calls[0]![0] as Blob;
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    vi.restoreAllMocks();
  });
});
