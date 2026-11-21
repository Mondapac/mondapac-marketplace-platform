// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { toast, Toaster } from '@mondapac/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { AlertList } from './alert-list.tsx';
import { cleanColumns } from './list-columns.ts';
import { exportParams } from './list-export.tsx';
import { queryString, searchText } from './list-query.ts';
import { LIST_KEY, payloadOf, queryOf, somethingToSave } from './list-saved.ts';
import {
  DEFAULT_QUERY,
  RULE_CODES,
  filtersOf,
  type AlertListPage,
  type AlertListRow,
} from './list-types.ts';

const call = vi.mocked(callApi);
const BRISBANE = 'Australia/Brisbane';
// 2026-11-16 20:30 UTC: already the 17th in Brisbane.
const NOW = new Date('2026-11-16T20:30:00.000Z');
const alertId = (n: number) => `0190a000-0000-7000-8000-0000000000a${n}`;
const LIST = 'security/admin/alerts/list';
const TITLE = 'Many failed sign-ins on one account';

const row = (over: Partial<AlertListRow> = {}): AlertListRow => ({
  id: alertId(1),
  rule: 'sign-in-failures-account',
  title: TITLE,
  severity: 's2',
  state: 'open',
  keyType: 'account',
  keyLabel: 'acc-1',
  eventCount: 12,
  firstEventAt: '2026-11-16T19:00:00.000Z',
  lastEventAt: '2026-11-16T20:00:00.000Z',
  openedAt: '2026-11-16T20:00:00.000Z',
  acknowledgedAt: null,
  acknowledgedByName: null,
  resolvedAt: null,
  nextNotifyAt: null,
  version: 3,
  actions: ['open', 'acknowledge', 'resolve'],
  ...over,
});
const COUNTS = { all: 9, open: 4, acknowledged: 2, critical: 1, resolved: 3 };
const pageOf = (items: AlertListRow[], over: Partial<AlertListPage> = {}): AlertListPage => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 25,
  paging: 'pages',
  hasNext: false,
  counts: COUNTS,
  ...over,
});

type SavedRoute = (method: string, path: string) => Promise<never>;
/** Until a test says otherwise the saved-filter route does not know the list: controls stay hidden. */
const noSavedRoute: SavedRoute = () =>
  Promise.resolve({
    ok: false,
    failure: { status: 400, code: 'validation.failed', details: { fields: [] } },
  } as never);

type Answer = AlertListPage | 'fail' | 'denied' | 'unauthenticated' | 'refused';

/** The list answers by URL, so the order of the calls does not matter. */
function serve(answer: (url: string) => Answer, saved: SavedRoute = noSavedRoute) {
  call.mockImplementation((method, path) => {
    if (path.startsWith('lists/admin/saved-filters')) return saved(method, path);
    const result = answer(path);
    if (result === 'fail') {
      return Promise.resolve({ ok: false, failure: { status: 503, code: 'access.unavailable' } });
    }
    if (result === 'denied') {
      return Promise.resolve({ ok: false, failure: { status: 403, code: 'access.denied' } });
    }
    if (result === 'unauthenticated') {
      return Promise.resolve({ ok: false, failure: { status: 401, code: 'session.invalid' } });
    }
    if (result === 'refused') {
      return Promise.resolve({
        ok: false,
        failure: { status: 400, code: 'validation.failed', details: { fields: [] } },
      });
    }
    return Promise.resolve({ ok: true, status: 200, body: result } as never);
  });
}
const urls = () => call.mock.calls.map((entry) => entry[1]).filter((url) => url.startsWith(LIST));
const lastUrl = () => urls()[urls().length - 1]!;
const paramsOf = (url: string) => Object.fromEntries(new URL(`http://x/${url}`).searchParams);

function mount(
  options: {
    paging?: 'pages' | 'prev-next';
    marketId?: string;
    noRoster?: boolean;
    initialSeverity?: 's1' | 's2' | 's3' | 's4';
    initialView?: 'all' | 'open' | 'critical';
  } = {},
) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <AlertList
        paging={options.paging ?? 'pages'}
        accountId="acc-1"
        marketId={options.marketId ?? 'AU'}
        zone={BRISBANE}
        now={NOW.getTime()}
        noRoster={options.noRoster ?? false}
        csrfToken="csrf-1"
        {...(options.initialSeverity === undefined
          ? {}
          : { initialSeverity: options.initialSeverity })}
        {...(options.initialView === undefined ? {} : { initialView: options.initialView })}
      />
      <Toaster labels={{ region: messages.toast.region, close: messages.toast.close }} />
    </NextIntlClientProvider>,
  );
}
const findRow = () => screen.findByRole('link', { name: TITLE });

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  toast.dismiss();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** usePoll reads again when the tab becomes visible: the same path as the 30 s timer. */
const poll = () => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
};

describe('Alert list: views, rows and paging', () => {
  it('asks for open alerts, critical first, and links each row to its own page', async () => {
    serve(() => pageOf([row()], { total: 143 }));
    mount();
    const link = await findRow();
    expect(link.getAttribute('href')).toBe(`/security/alerts/${alertId(1)}`);
    expect(paramsOf(urls()[0]!)).toEqual({
      view: 'open',
      paging: 'pages',
      page: '1',
      pageSize: '25',
      sort: 'severity',
      direction: 'asc',
    });
    expect(screen.getByText('Sorted by Severity: Critical first')).toBeTruthy();
    expect(screen.getByText('1-1 of 143')).toBeTruthy();
    expect(screen.getByText('acc-1')).toBeTruthy();
    expect(screen.getByText('sign-in-failures-account')).toBeTruthy();
    // The saved filter controls are hidden while their route does not know the list.
    expect(screen.queryByRole('button', { name: 'Manage filters' })).toBeNull();
  });

  it('shows the view counts and sends the view, back on page 1', async () => {
    serve(() => pageOf([row()], { total: 80 }));
    mount();
    await findRow();
    expect(screen.getByRole('button', { name: 'Open (4)' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(lastUrl()).toContain('page=2'));
    fireEvent.click(screen.getByRole('button', { name: 'Critical (live S1) (1)' }));
    await waitFor(() => expect(paramsOf(lastUrl())['view']).toBe('critical'));
    expect(paramsOf(lastUrl())['page']).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Resolved (3)' }));
    await waitFor(() => expect(paramsOf(lastUrl())['view']).toBe('resolved'));
    fireEvent.click(screen.getByRole('button', { name: 'All (9)' }));
    await waitFor(() => expect(paramsOf(lastUrl())['view']).toBe('all'));
  });

  it('opens the view a link names and starts on its severity as a removable chip', async () => {
    serve(() => pageOf([row()]));
    mount({ initialView: 'critical', initialSeverity: 's1' });
    await findRow();
    expect(paramsOf(urls()[0]!)).toMatchObject({ view: 'critical', severity: 's1' });
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove filter Severity is S1 · Critical' }),
    );
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('severity'));
  });

  it('sorts by events, newest activity direction by default, and then the other way', async () => {
    serve(() => pageOf([row()]));
    mount();
    await findRow();
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Events' }));
    await waitFor(() =>
      expect(paramsOf(lastUrl())).toMatchObject({ sort: 'events', direction: 'desc' }),
    );
    fireEvent.click(await screen.findByRole('radio', { name: 'Fewest events first' }));
    await waitFor(() => expect(paramsOf(lastUrl())['direction']).toBe('asc'));
  });

  it('sends paging=prev-next, shows no total and walks the pages', async () => {
    serve((url) =>
      pageOf([row()], {
        total: null,
        paging: 'prev-next',
        hasNext: !url.includes('page=2'),
        page: url.includes('page=2') ? 2 : 1,
      }),
    );
    mount({ paging: 'prev-next' });
    await findRow();
    expect(paramsOf(urls()[0]!)['paging']).toBe('prev-next');
    expect(screen.queryByText(/of \d+/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(lastUrl()).toContain('page=2'));
  });

  it('shows the S1 timer, who acknowledged, and says nothing was sent without a roster', async () => {
    serve(() =>
      pageOf([
        row({ id: alertId(1), severity: 's1', title: 'A critical one' }),
        row({
          id: alertId(2),
          title: 'Acked',
          state: 'acknowledged',
          acknowledgedByName: 'Hassan R.',
        }),
      ]),
    );
    mount({ noRoster: true });
    await screen.findByRole('link', { name: 'A critical one' });
    expect(screen.getAllByText('Not sent (no roster)').length).toBeGreaterThan(0);
    expect(screen.getByText('Acknowledged by Hassan R.')).toBeTruthy();
  });
});

describe('Alert list: search and filters', () => {
  async function addCondition(field: string, value: string, first = true) {
    if (first) fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    if (!first) fireEvent.click(within(panel).getByRole('button', { name: 'Add condition' }));
    const index = first ? 0 : within(panel).getAllByLabelText('Field').length - 1;
    fireEvent.change(within(panel).getAllByLabelText('Field')[index]!, {
      target: { value: field },
    });
    fireEvent.change(within(panel).getAllByLabelText('Value')[index]!, { target: { value } });
    return panel;
  }
  const apply = (panel: HTMLElement) =>
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));

  it('sends the typed key as keyValue, trimmed, with a chip that clears it', async () => {
    serve(() => pageOf([row()]));
    mount();
    await findRow();
    const box = screen.getByRole('searchbox', { name: 'Search' });
    fireEvent.change(box, { target: { value: '  203.0.113.7 ' } });
    fireEvent.submit(box.closest('form') ?? box);
    await waitFor(() => expect(paramsOf(lastUrl())['keyValue']).toBe('203.0.113.7'));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Remove filter Key is 203.0.113.7' }),
    );
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('keyValue'));
  });

  it('offers severity, rule, key type, opened and events, and no state (it is a view)', async () => {
    serve(() => pageOf([row()]));
    mount();
    await findRow();
    fireEvent.click(screen.getByRole('button', { name: 'Filter' }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    const field = within(panel).getByLabelText('Field');
    expect(
      within(field)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Field', 'Severity', 'Rule', 'Key type', 'Opened', 'Events at least']);
    fireEvent.change(field, { target: { value: 'rule' } });
    expect(
      within(within(panel).getByLabelText('Value'))
        .getAllByRole('option')
        .map((option) => option.textContent)
        .slice(1),
    ).toContain('Many failed sign-ins from one address');
  });

  it('filters by severity and events, as chips that can be removed one by one', async () => {
    serve(() => pageOf([row()]));
    mount();
    await findRow();
    await addCondition('severity', 's1');
    apply(await addCondition('minEvents', '10', false));
    await waitFor(() => expect(paramsOf(lastUrl())['severity']).toBe('s1'));
    expect(paramsOf(lastUrl())['minEvents']).toBe('10');
    expect(screen.getByText('Severity is S1 · Critical')).toBeTruthy();
    expect(screen.getByText('Events at least is 10 events')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filter (2)' })).toBeTruthy();
    expect(screen.getByText('1 alert matches')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove filter Events at least is 10 events' }),
    );
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('minEvents'));
    expect(paramsOf(lastUrl())['severity']).toBe('s1');
  });

  it('reads the Opened preset on the clock of the list zone, Brisbane', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    vi.setSystemTime(NOW);
    serve(() => pageOf([row()]));
    mount();
    await findRow();
    apply(await addCondition('opened', 'today'));
    await waitFor(() => expect(paramsOf(lastUrl())['from']).toBeDefined());
    expect(paramsOf(lastUrl())).toMatchObject({
      from: '2026-11-16T14:00:00.000Z',
      to: '2026-11-17T14:00:00.000Z',
    });
  });
});

describe('Alert list: row Actions menu', () => {
  const openMenu = async () => {
    fireEvent.click((await screen.findAllByRole('button', { name: `Actions for ${TITLE}` }))[0]!);
    return screen.findByRole('menu');
  };
  const labels = (menu: HTMLElement) =>
    within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent);

  it('lists the actions the row names in a fixed order, those that ask for more ending in "…"', async () => {
    serve(() => pageOf([row()]));
    mount();
    await findRow();
    expect(labels(await openMenu())).toEqual(['Open', 'Acknowledge…', 'Resolve…']);
  });

  it('ignores an unknown action and shows only what the server allows', async () => {
    serve(() => pageOf([row({ actions: ['open', 'delete', 'resolve'] })]));
    mount();
    await findRow();
    expect(labels(await openMenu())).toEqual(['Open', 'Resolve…']);
  });

  it('opens the alert page for every item: the act itself is made there', async () => {
    serve(() => pageOf([row()]));
    mount();
    await findRow();
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Acknowledge…' }));
    expect(push).toHaveBeenCalledWith(`/security/alerts/${alertId(1)}`);
  });

  it('shows no Acknowledge or Resolve for a reader without the respond key', async () => {
    serve(() => pageOf([row({ actions: ['open'] })]));
    mount();
    await findRow();
    expect(labels(await openMenu())).toEqual(['Open']);
  });
});

describe('Alert list: selection and Export', () => {
  const CSV = { 'content-type': 'text/csv; charset=utf-8' };
  const bulk = () => screen.getByRole('button', { name: 'Bulk action' });
  const openExport = async () => {
    fireEvent.click(bulk());
    fireEvent.click(
      within(await screen.findByRole('menu', { name: 'Bulk action' })).getByRole('menuitem', {
        name: /^Export/,
      }),
    );
    return screen.findByRole('dialog');
  };
  const confirm = (dialog: HTMLElement) => {
    fireEvent.click(within(dialog).getByRole('radio', { name: /^CSV/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
  };
  const fetched: string[] = [];
  const sent = () => {
    const url = new URL(fetched[fetched.length - 1]!, 'http://x');
    return { path: url.pathname, params: Object.fromEntries(url.searchParams) };
  };
  let click: { mockRestore: () => void };

  beforeEach(() => {
    fetched.length = 0;
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        fetched.push(url);
        return Promise.resolve(new Response('﻿Alert\r\n1\r\n2\r\n', { status: 200, headers: CSV }));
      }),
    );
  });
  afterEach(() => click.mockRestore());

  it('has Export as the only bulk item (no bulk acknowledge), off until a row is selected', async () => {
    serve(() => pageOf([row(), row({ id: alertId(2), title: 'Second' })]));
    mount();
    await findRow();
    expect(bulk()).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all alerts on this page' }));
    expect(bulk()).toHaveProperty('disabled', false);
    fireEvent.click(bulk());
    const menu = await screen.findByRole('menu', { name: 'Bulk action' });
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1);
  });

  it('sends the ticked ids alone', async () => {
    serve(() => pageOf([row(), row({ id: alertId(2), title: 'Second' })]));
    mount();
    await findRow();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all alerts on this page' }));
    confirm(await openExport());
    expect(await screen.findByText('Exported 2 rows.')).toBeTruthy();
    expect(sent()).toEqual({
      path: '/api/security/admin/alerts/export',
      params: { format: 'csv', ids: `${alertId(1)},${alertId(2)}` },
    });
  });

  it('sends the list selector and sort after "Select all matching"', async () => {
    serve(() => pageOf([row()], { total: 143 }));
    mount();
    await findRow();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all alerts on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all 143 matching' }));
    confirm(await openExport());
    await waitFor(() => expect(fetched).toHaveLength(1));
    expect(sent().params).toEqual({
      format: 'csv',
      view: 'open',
      sort: 'severity',
      direction: 'asc',
    });
  });
});

describe('Alert list: states and refresh', () => {
  it('shows the load error with Try again when the first load fails, then recovers', async () => {
    let fails = true;
    serve(() => (fails ? 'fail' : pageOf([row()])));
    mount();
    expect(await screen.findByText(/The alerts couldn't be loaded/)).toBeTruthy();
    expect(screen.queryByText('No open alerts.')).toBeNull();
    fails = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await findRow();
  });

  it('goes to the sign-in page on a 401', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    serve(() => 'unauthenticated');
    mount();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });

  it('says there is no access on a 403', async () => {
    serve(() => 'denied');
    mount();
    expect(await screen.findByText('You do not have access to security alerts.')).toBeTruthy();
  });

  it('says the query cannot be run on validation.failed, with no Try again', async () => {
    serve(() => 'refused');
    mount();
    expect(await screen.findByText(/This search can't be run/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('words an empty view, and offers to clear filters that hide everything', async () => {
    serve(() => pageOf([]));
    mount();
    expect(await screen.findByText('No open alerts.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resolved (3)' }));
    expect(await screen.findByText('No alert has been resolved.')).toBeTruthy();
  });

  it('keeps the last list and says the refresh failed, without moving the page', async () => {
    let answers: Answer[] = [pageOf([row()]), 'fail'];
    serve(() => answers.shift() ?? 'fail');
    mount();
    await findRow();
    poll();
    expect(await screen.findByText(/^Couldn't refresh\. Showing alerts as of/)).toBeTruthy();
    expect(screen.getByRole('link', { name: TITLE })).toBeTruthy();
    answers = [pageOf([row()])];
    poll();
    await waitFor(() => expect(screen.queryByText(/^Couldn't refresh/)).toBeNull());
  });

  it('keeps the column choice in this browser, per Market and account', async () => {
    serve(() => pageOf([row()]));
    const { unmount } = mount();
    await findRow();
    expect(screen.queryByRole('columnheader', { name: 'First event' })).toBeNull();
    unmount();
    window.localStorage.setItem(
      'mp:admin:AU:acc-1:security-alert-columns',
      JSON.stringify(['first-event']),
    );
    mount();
    await findRow();
    expect(call).toHaveBeenCalled();
  });
});

describe('Alert list: saved filters', () => {
  const item = {
    id: '0190a000-0000-7000-8000-0000000000e1',
    listKey: LIST_KEY,
    name: 'Critical IPs',
    visibility: 'me',
    payload: {
      v: 1,
      view: 'critical',
      filters: { severities: ['s1'], keyType: 'ip', minEvents: 5 },
      sort: 'events',
    },
    ownedByMe: true,
    canManage: true,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };

  it("keeps the built-in tabs' counts when a saved filter is open", async () => {
    serve(
      (url) =>
        pageOf([row()], {
          counts: url.includes('minEvents=5')
            ? { all: 1, open: 0, acknowledged: 0, critical: 1, resolved: 0 }
            : COUNTS,
        }),
      () =>
        Promise.resolve({
          ok: true,
          status: 200,
          body: { items: [item], canShare: false },
        } as never),
    );
    mount();
    await findRow();
    fireEvent.click(await screen.findByRole('button', { name: 'Critical IPs' }));
    await waitFor(() => expect(paramsOf(lastUrl())).toHaveProperty('minEvents', '5'));
    expect(await screen.findByRole('button', { name: /^Open \(4\)$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^All \(9\)$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Resolved \(3\)$/ })).toBeTruthy();
  });

  it('adds the saved filter as a tab, and a built-in tab opened from it does not carry it', async () => {
    serve(
      () => pageOf([row()]),
      () =>
        Promise.resolve({
          ok: true,
          status: 200,
          body: { items: [item], canShare: false },
        } as never),
    );
    mount();
    await findRow();
    fireEvent.click(await screen.findByRole('button', { name: 'Critical IPs' }));
    await waitFor(() => expect(paramsOf(lastUrl())['view']).toBe('critical'));
    expect(paramsOf(lastUrl())).toMatchObject({
      severity: 's1',
      keyType: 'ip',
      minEvents: '5',
      sort: 'events',
      // The document leaves out what the page's own default is (ascending).
      direction: 'asc',
      page: '1',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Resolved (3)' }));
    await waitFor(() => expect(paramsOf(lastUrl())['view']).toBe('resolved'));
    expect(paramsOf(lastUrl())).not.toHaveProperty('keyType');
    expect(paramsOf(lastUrl())['sort']).toBe('severity');
  });

  it('offers Save filter… on a built-in tab that shows something to keep', async () => {
    serve(
      () => pageOf([row()]),
      () =>
        Promise.resolve({ ok: true, status: 200, body: { items: [], canShare: true } } as never),
    );
    mount();
    await findRow();
    expect(screen.queryByRole('button', { name: /^Save filter/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Resolved (3)' }));
    expect(await screen.findByRole('button', { name: 'Save filter…' })).toBeTruthy();
  });

  it('saves only what the closed document may hold: never the key search', () => {
    const query = {
      ...DEFAULT_QUERY,
      view: 'critical' as const,
      q: '203.0.113.7',
      filters: { severity: 's1' as const, minEvents: '10' as const, opened: 'today' as const },
    };
    expect(somethingToSave(DEFAULT_QUERY)).toBe(false);
    expect(somethingToSave(query)).toBe(true);
    expect(payloadOf(query)).toEqual({
      v: 1,
      view: 'critical',
      filters: { severities: ['s1'], minEvents: 10, opened: 'today' },
    });
    expect(
      queryOf({ v: 1, view: 'critical', filters: { severities: ['s1', 's2'], minEvents: 10 } }),
    ).toEqual({
      ...DEFAULT_QUERY,
      view: 'critical',
      filters: { severity: 's1', minEvents: '10' },
    });
    // An unknown view, value or field is dropped.
    expect(
      queryOf({
        v: 1,
        view: 'nope' as never,
        filters: { severities: ['s9'], rule: 'bogus', minEvents: 3 },
        sort: 'author' as never,
      }),
    ).toEqual(DEFAULT_QUERY);
  });
});

describe('Alert list: query building', () => {
  const context = { paging: 'pages' as const, zone: BRISBANE, now: NOW };

  it('always sends the view, and the filters, key and sort as chosen', () => {
    expect(Object.fromEntries(new URLSearchParams(queryString(DEFAULT_QUERY, context)))).toEqual({
      view: 'open',
      paging: 'pages',
      page: '1',
      pageSize: '25',
      sort: 'severity',
      direction: 'asc',
    });
    const asked = {
      ...DEFAULT_QUERY,
      view: 'all' as const,
      q: ' 203.0.113.7 ',
      filters: {
        severity: 's2' as const,
        rule: 'sign-in-failures-ip',
        keyType: 'ip' as const,
        minEvents: '5',
        opened: 'last-7-days' as const,
      },
      sort: 'events' as const,
      direction: 'desc' as const,
      page: 3,
    };
    const params = Object.fromEntries(new URLSearchParams(queryString(asked, context)));
    expect(params).toMatchObject({
      view: 'all',
      keyValue: '203.0.113.7',
      severity: 's2',
      rule: 'sign-in-failures-ip',
      keyType: 'ip',
      minEvents: '5',
      sort: 'events',
      direction: 'desc',
      page: '3',
    });
    expect(params['from']).toBeDefined();
    expect(params['to']).toBeDefined();
  });

  it('keeps the search inside what the API takes: no control or direction marks, 64 characters', () => {
    expect(searchText('  a\u0000b‮c  ')).toBe('a b c');
    expect(Array.from(searchText('x'.repeat(100)))).toHaveLength(64);
  });

  it('keeps only known values of known fields', () => {
    expect(
      filtersOf({
        severity: 's9',
        rule: RULE_CODES[0],
        keyType: 'user',
        minEvents: '7',
        opened: 'someday',
        junk: 'x',
      }),
    ).toEqual({ rule: RULE_CODES[0] });
  });

  it('exports ticked rows by id alone, capped at 200', () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
    const params = new URLSearchParams(
      exportParams({
        query: DEFAULT_QUERY,
        paging: 'pages',
        zone: BRISBANE,
        format: 'csv',
        columns: [],
        selection: { ids, allMatching: false, total: null },
      }),
    );
    expect(params.get('ids')?.split(',')).toHaveLength(200);
    expect([...params.keys()].sort()).toEqual(['format', 'ids']);
  });

  it('cleans a stored column choice to the export column ids', () => {
    expect(cleanColumns(undefined)).toEqual([]);
    expect(cleanColumns(['resolved', 'bogus', 'resolved', 'alert-id'])).toEqual([
      'resolved',
      'alert-id',
    ]);
  });
});
