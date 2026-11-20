// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { toast, Toaster } from '@mondapac/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { StepUpProvider } from '../../step-up/step-up.tsx';
import { cleanColumns } from './list-columns.ts';
import { exportParams } from './list-export.tsx';
import { queryString, searchText } from './list-query.ts';
import { LIST_KEY, payloadOf, queryOf, somethingToSave } from './list-saved.ts';
import { ModerationList } from './moderation-list.tsx';
import {
  DEFAULT_QUERY,
  filtersOf,
  type ModerationListPage,
  type ModerationListRow,
} from './list-types.ts';

const call = vi.mocked(callApi);
const BRISBANE = 'Australia/Brisbane';
// 2026-11-16 20:30 UTC: already the 17th in Brisbane.
const NOW = new Date('2026-11-16T20:30:00.000Z');
const REVIEW = '0190a000-0000-7000-8000-0000000000a1';
const reviewId = (n: number) => `0190a000-0000-7000-8000-0000000000a${n}`;
const SELLER = '0190a000-0000-7000-8000-0000000000c1';
const LIST = 'reviews/admin/moderation/list';

const row = (over: Partial<ModerationListRow> = {}): ModerationListRow => ({
  id: REVIEW,
  productId: '0190a000-0000-7000-8000-0000000000b1',
  offerId: '0190a000-0000-7000-8000-0000000000d1',
  sellerId: SELLER,
  rating: 1,
  title: 'Awful',
  body: 'Not what I ordered',
  locale: 'en-AU',
  status: 'held',
  createdAt: '2026-11-10T01:30:00.000Z',
  editedAt: null,
  openReports: 2,
  signalCodes: ['profanity'],
  actions: ['open', 'publish', 'hide', 'remove', 'dismiss-reports'],
  ...over,
});
const COUNTS = { all: 9, held: 4, reported: 3, actioned: 2 };
const pageOf = (
  items: ModerationListRow[],
  over: Partial<ModerationListPage> = {},
): ModerationListPage => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 25,
  paging: 'pages',
  hasNext: false,
  counts: COUNTS,
  ...over,
});
const noTotal = (items: ModerationListRow[], hasNext = false, page = 1) =>
  pageOf(items, { total: null, paging: 'prev-next', hasNext, page });

type SavedRoute = (method: string, path: string) => Promise<never>;
/** Until a test says otherwise the saved-filter route does not know the list: controls stay hidden. */
const noSavedRoute: SavedRoute = () =>
  Promise.resolve({
    ok: false,
    failure: { status: 400, code: 'validation.failed', details: { fields: [] } },
  } as never);

type Answer = ModerationListPage | 'fail' | 'denied' | 'unauthenticated' | 'refused';

/** The list answers by URL, so the order of the calls does not matter. */
function serve(
  answer: (url: string) => Answer,
  saved: SavedRoute = noSavedRoute,
  review?: (url: string) => unknown,
) {
  call.mockImplementation((method, path) => {
    if (path.startsWith('lists/admin/saved-filters')) return saved(method, path);
    if (path.startsWith('reviews/admin/moderation/') && !path.startsWith(LIST)) {
      return Promise.resolve({ ok: true, status: 200, body: review?.(path) } as never);
    }
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
    sellerId?: string | null;
    canModerate?: boolean;
    canRemove?: boolean;
  } = {},
) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <StepUpProvider>
        <ModerationList
          paging={options.paging ?? 'pages'}
          accountId="acc-1"
          marketId={options.marketId ?? 'AU'}
          zone={BRISBANE}
          canModerate={options.canModerate ?? true}
          canRemove={options.canRemove ?? true}
          sellerId={options.sellerId ?? null}
          csrfToken="csrf-1"
        />
      </StepUpProvider>
      <Toaster labels={{ region: messages.toast.region, close: messages.toast.close }} />
    </NextIntlClientProvider>,
  );
}
const findRow = () => screen.findByRole('button', { name: 'Awful - Not what I ordered' });

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

describe('Review moderation list: page numbers and views', () => {
  it('asks for page 1 newest first and shows the views, rows and range, never the author', async () => {
    serve(() => pageOf([row()], { total: 143 }));
    mount();
    await findRow();
    expect(paramsOf(urls()[0]!)).toEqual({
      paging: 'pages',
      page: '1',
      pageSize: '25',
      sort: 'submitted',
      direction: 'desc',
    });
    expect(screen.getByText('Times are shown in Australia/Brisbane.')).toBeTruthy();
    expect(screen.getByText('Sorted by Submitted: Newest first')).toBeTruthy();
    expect(screen.getByText('1-1 of 143')).toBeTruthy();
    expect(screen.getByRole('img', { name: '1 out of 5' })).toBeTruthy();
    expect(screen.getAllByText('Held').length).toBeGreaterThan(0);
    expect(screen.getByText('2 open reports')).toBeTruthy();
    expect(screen.getByText('Blocked word')).toBeTruthy();
    expect(screen.queryByText(/author|buyer name/i)).toBeNull();
    // The saved filter controls are hidden while their route does not know the list.
    expect(screen.queryByRole('button', { name: 'Manage filters' })).toBeNull();
  });

  it('shows the view counts and sends the view, back on page 1', async () => {
    serve(() => pageOf([row()], { total: 80 }));
    mount();
    await findRow();
    expect(screen.getByRole('button', { name: 'All (9)' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(lastUrl()).toContain('page=2'));
    fireEvent.click(screen.getByRole('button', { name: 'Reported (3)' }));
    await waitFor(() => expect(paramsOf(lastUrl())['view']).toBe('reported'));
    expect(paramsOf(lastUrl())['page']).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Hidden or removed (2)' }));
    await waitFor(() => expect(paramsOf(lastUrl())['view']).toBe('actioned'));
    fireEvent.click(screen.getByRole('button', { name: 'All (9)' }));
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('view'));
  });

  it('sorts by rating, lowest first by default, and then the other way', async () => {
    serve(() => pageOf([row()]));
    mount();
    await findRow();
    fireEvent.click(screen.getByRole('button', { name: 'Sort' }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Rating' }));
    await waitFor(() =>
      expect(paramsOf(lastUrl())).toMatchObject({ sort: 'rating', direction: 'asc' }),
    );
    fireEvent.click(await screen.findByRole('radio', { name: 'Highest first' }));
    await waitFor(() => expect(paramsOf(lastUrl())['direction']).toBe('desc'));
  });

  it('sends paging=prev-next, shows no total and walks the pages', async () => {
    serve((url) =>
      paramsOf(url)['page'] === '2' ? noTotal([row()], false, 2) : noTotal([row()], true),
    );
    mount({ paging: 'prev-next' });
    await findRow();
    expect(paramsOf(urls()[0]!)['paging']).toBe('prev-next');
    expect(screen.queryByText(/ of /)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(paramsOf(lastUrl())['page']).toBe('2'));
    await findRow();
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await waitFor(() => expect(paramsOf(lastUrl())['page']).toBe('1'));
  });

  it('with Previous and next, goes to the page before when the page asked for is now empty', async () => {
    serve((url) => {
      const page = Number(paramsOf(url)['page']);
      return page === 4 ? noTotal([], false, 4) : noTotal([row()], true, page);
    });
    mount({ paging: 'prev-next' });
    await findRow();
    for (const n of [2, 3, 4]) {
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      await waitFor(() => expect(paramsOf(lastUrl())['page']).toBe(String(n)));
      if (n < 4) await findRow();
    }
    await waitFor(() => expect(paramsOf(lastUrl())['page']).toBe('3'));
  });
});

describe('Review moderation list: search and filters', () => {
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

  it('sends typed words or an id as q, trimmed, with a chip that clears it', async () => {
    serve(() => pageOf([row()]));
    mount();
    await findRow();
    const box = screen.getByRole('searchbox', { name: 'Search' });
    fireEvent.change(box, { target: { value: '  not what I ordered ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.submit(box.closest('form') ?? box);
    await waitFor(() => expect(paramsOf(lastUrl())['q']).toBe('not what I ordered'));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Remove filter Search is not what I ordered' }),
    );
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('q'));
  });

  it('offers the star range, report reason and submitted, and no queue (it is a view)', async () => {
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
    ).toEqual(['Field', 'Stars at least', 'Stars at most', 'Report reason', 'Submitted']);
    fireEvent.change(field, { target: { value: 'reportReason' } });
    expect(
      within(within(panel).getByLabelText('Value'))
        .getAllByRole('option')
        .map((option) => option.textContent)
        .slice(1),
    ).toContain('Abusive');
  });

  it('filters by stars and reason, as chips that can be removed one by one', async () => {
    serve(() => pageOf([row()]));
    mount();
    await findRow();
    await addCondition('minRating', '2');
    apply(await addCondition('reportReason', 'extortion', false));
    await waitFor(() => expect(paramsOf(lastUrl())['minRating']).toBe('2'));
    expect(paramsOf(lastUrl())['reportReason']).toBe('extortion');
    expect(screen.getByText('Stars at least is 2 stars')).toBeTruthy();
    expect(screen.getByText('Report reason is Extortion')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filter (2)' })).toBeTruthy();
    expect(screen.getByText('1 review matches')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Remove filter Report reason is Extortion' }),
    );
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('reportReason'));
    expect(paramsOf(lastUrl())['minRating']).toBe('2');
  });

  it('reads the Submitted preset on the clock of the list zone, Brisbane', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['Date'] });
    vi.setSystemTime(NOW);
    serve(() => pageOf([row()]));
    mount();
    await findRow();
    apply(await addCondition('submitted', 'today'));
    await waitFor(() => expect(paramsOf(lastUrl())['from']).toBeDefined());
    expect(paramsOf(lastUrl())).toMatchObject({
      from: '2026-11-16T14:00:00.000Z',
      to: '2026-11-17T14:00:00.000Z',
    });
  });

  it('shows a removable Seller chip when a link names one', async () => {
    serve(() => pageOf([row()]));
    mount({ sellerId: SELLER });
    await findRow();
    expect(paramsOf(urls()[0]!)['sellerId']).toBe(SELLER);
    const chip = screen.getByRole('button', { name: /^Remove filter Seller is / });
    fireEvent.click(chip);
    await waitFor(() => expect(paramsOf(lastUrl())).not.toHaveProperty('sellerId'));
  });
});

describe('Review moderation list: row Actions menu', () => {
  const openMenu = async () => {
    fireEvent.click(
      (
        await screen.findAllByRole('button', {
          name: 'Actions for the 1-star review Awful - Not what I ordered',
        })
      )[0]!,
    );
    return screen.findByRole('menu');
  };

  it('lists the actions the row names in a fixed order, each that changes it ending in "…"', async () => {
    serve(() => pageOf([row()]));
    mount();
    await findRow();
    const menu = await openMenu();
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Open…', 'Publish…', 'Dismiss reports…', 'Hide…', 'Remove…']);
  });

  it('ignores an unknown action and shows only what the server allows', async () => {
    serve(() => pageOf([row({ actions: ['open', 'restore', 'bulk-delete'] })]));
    mount();
    await findRow();
    const menu = await openMenu();
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Open…', 'Restore…']);
  });

  it('opens the review dialog with the chosen action, and reads the list again after a change', async () => {
    serve(
      () => pageOf([row()]),
      noSavedRoute,
      () => ({
        ...row(),
        reportReasons: [{ reasonCode: 'abusive', count: 2 }],
        history: [],
        allowedActions: ['publish', 'hide', 'remove', 'dismiss-reports'],
      }),
    );
    mount();
    await findRow();
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Hide…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hide review' });
    await within(dialog).findByText('Not what I ordered');
    expect(within(dialog).getByLabelText<HTMLSelectElement>('Action').value).toBe('hide');
    // The focus starts on Close, not on the red button.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Close' }));
    fireEvent.change(within(dialog).getByLabelText('Reason'), { target: { value: 'spam' } });
    const before = urls().length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Hide' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `reviews/admin/moderation/${REVIEW}/hide`,
        { reasonCode: 'spam' },
        'csrf-1',
      ),
    );
    // The change reads the list again (same query, new answer).
    await waitFor(() => expect(urls().length).toBeGreaterThan(before));
  });

  it('opens Remove without the action chosen for a moderator who lacks the remove key', async () => {
    serve(
      () => pageOf([row()]),
      noSavedRoute,
      () => ({
        ...row(),
        reportReasons: [],
        history: [],
        allowedActions: ['publish', 'hide', 'remove'],
      }),
    );
    mount({ canRemove: false });
    await findRow();
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Remove…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove review' });
    await within(dialog).findByText('Not what I ordered');
    const action = within(dialog).getByLabelText<HTMLSelectElement>('Action');
    expect(action.value).toBe('');
    expect(within(action).queryByRole('option', { name: 'Remove' })).toBeNull();
  });

  it('has no button inside a row besides the review link, the select box and the menu', async () => {
    serve(() => pageOf([row()]));
    mount();
    const opener = await findRow();
    const tr = opener.closest('tr') ?? opener.closest('li');
    expect(tr).not.toBeNull();
    const names = within(tr as HTMLElement)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent);
    expect(names).toEqual([
      'Awful - Not what I ordered',
      'Actions for the 1-star review Awful - Not what I ordered',
    ]);
  });

  it('renders review text as plain text', async () => {
    serve(() => pageOf([row({ title: '<img src=x onerror=alert(1)>', body: null })]));
    mount();
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('Review moderation list: selection and Export', () => {
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
        return Promise.resolve(
          new Response('﻿Rating\r\n1\r\n2\r\n', { status: 200, headers: CSV }),
        );
      }),
    );
  });
  afterEach(() => click.mockRestore());

  it('has Export as the only bulk item (no bulk moderation), off until a row is selected', async () => {
    serve(() => pageOf([row(), row({ id: reviewId(2) })]));
    mount();
    await screen.findAllByRole('button', { name: 'Awful - Not what I ordered' });
    expect(bulk()).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all reviews on this page' }));
    expect(bulk()).toHaveProperty('disabled', false);
    fireEvent.click(bulk());
    const menu = await screen.findByRole('menu', { name: 'Bulk action' });
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1);
  });

  it('sends the ticked ids and the shown optional columns, and no filter, sort or zone', async () => {
    serve(() => pageOf([row(), row({ id: reviewId(2) })]));
    mount();
    await screen.findAllByRole('button', { name: 'Awful - Not what I ordered' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all reviews on this page' }));
    confirm(await openExport());
    expect(await screen.findByText('Exported 2 rows.')).toBeTruthy();
    expect(sent()).toEqual({
      path: '/api/reviews/admin/moderation/export',
      params: { format: 'csv', columns: 'signals,seller-id', ids: `${reviewId(1)},${reviewId(2)}` },
    });
  });

  it('sends the list selector and sort after "Select all matching"', async () => {
    serve(() => pageOf([row()], { total: 143 }));
    mount();
    await findRow();
    fireEvent.click(screen.getByRole('button', { name: 'Held (4)' }));
    await waitFor(() => expect(paramsOf(lastUrl())['view']).toBe('held'));
    await findRow();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all reviews on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all 143 matching' }));
    confirm(await openExport());
    await waitFor(() => expect(fetched).toHaveLength(1));
    expect(sent().params).toEqual({
      format: 'csv',
      columns: 'signals,seller-id',
      view: 'held',
      sort: 'submitted',
      direction: 'desc',
    });
  });
});

describe('Review moderation list: states', () => {
  it('shows the load error with Try again when the first load fails, then recovers', async () => {
    let fail = true;
    serve(() => (fail ? 'fail' : pageOf([row()])));
    mount();
    const retry = await screen.findByRole('button', { name: 'Try again' });
    fail = false;
    fireEvent.click(retry);
    expect(await findRow()).toBeTruthy();
  });

  it('goes to the sign-in page on a 401', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign, href: 'http://admin.localhost/' });
    serve(() => 'unauthenticated');
    mount();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });

  it('says there is no access on a 403', async () => {
    serve(() => 'denied');
    mount();
    expect(
      await screen.findByText('You do not have access to the buyer review queue.'),
    ).toBeTruthy();
  });

  it('says the query cannot be run on validation.failed, with no Try again', async () => {
    serve(() => 'refused');
    mount();
    expect(
      await screen.findByText(
        "This search can't be run. Change the text or the filters, or clear them.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('words an empty view by queue', async () => {
    serve(() => pageOf([], { total: 0 }));
    mount();
    expect(await screen.findByText('No review needs a moderator.')).toBeTruthy();
  });

  it('keeps the column choice in this browser, per Market and account (second fixture ZZ)', async () => {
    window.localStorage.setItem(
      'mp:admin:ZZ:acc-1:review-moderation-columns',
      JSON.stringify(['locale']),
    );
    serve(() => pageOf([row()]));
    mount({ marketId: 'ZZ' });
    await findRow();
    expect(screen.getByText('en-AU')).toBeTruthy();
    expect(screen.queryByText('Blocked word')).toBeNull();
  });
});

describe('Review moderation list: saved filters', () => {
  const item = {
    id: '0190a000-0000-7000-8000-0000000000e1',
    listKey: LIST_KEY,
    name: 'Low reported',
    visibility: 'me',
    payload: { v: 1, view: 'reported', filters: { maxRating: '2' }, sort: 'rating' },
    ownedByMe: true,
    canManage: true,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };

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
    fireEvent.click(await screen.findByRole('button', { name: 'Low reported' }));
    await waitFor(() => expect(paramsOf(lastUrl())['view']).toBe('reported'));
    expect(paramsOf(lastUrl())).toMatchObject({
      maxRating: '2',
      sort: 'rating',
      direction: 'desc',
      page: '1',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Held (4)' }));
    await waitFor(() => expect(paramsOf(lastUrl())['view']).toBe('held'));
    expect(paramsOf(lastUrl())).not.toHaveProperty('maxRating');
    expect(paramsOf(lastUrl())['sort']).toBe('submitted');
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
    fireEvent.click(screen.getByRole('button', { name: 'Reported (3)' }));
    expect(await screen.findByRole('button', { name: 'Save filter…' })).toBeTruthy();
  });

  it('saves only what the closed document may hold: never the search or the seller', () => {
    const query = {
      ...DEFAULT_QUERY,
      view: 'held' as const,
      q: 'some words',
      sellerId: SELLER,
      filters: { minRating: '2' as const, submitted: 'today' as const },
    };
    expect(somethingToSave(DEFAULT_QUERY)).toBe(false);
    expect(somethingToSave(query)).toBe(true);
    expect(payloadOf(query)).toEqual({
      v: 1,
      view: 'held',
      filters: { minRating: '2', submitted: 'today' },
    });
    expect(queryOf({ v: 1, view: 'held', filters: { minRating: '2' } })).toEqual({
      ...DEFAULT_QUERY,
      view: 'held',
      filters: { minRating: '2' },
    });
    // An unknown view, value or field is dropped.
    expect(
      queryOf({
        v: 1,
        view: 'nope' as never,
        filters: { minRating: '9', text: 'x', reportReason: 'bogus' } as never,
        sort: 'author' as never,
      }),
    ).toEqual(DEFAULT_QUERY);
  });
});

describe('Review moderation list: query building', () => {
  const context = { paging: 'pages' as const, zone: BRISBANE, now: NOW };

  it('sends no view for All, and the filters, seller and sort as chosen', () => {
    expect(paramsOf(`x?${queryString(DEFAULT_QUERY, context)}`)).toEqual({
      paging: 'pages',
      page: '1',
      pageSize: '25',
      sort: 'submitted',
      direction: 'desc',
    });
    const asked = queryString(
      {
        ...DEFAULT_QUERY,
        view: 'reported',
        q: REVIEW,
        sellerId: SELLER,
        filters: { minRating: '1', maxRating: '3', reportReason: 'abusive' },
        sort: 'rating',
        direction: 'asc',
        page: 3,
      },
      context,
    );
    expect(paramsOf(`x?${asked}`)).toEqual({
      view: 'reported',
      q: REVIEW,
      sellerId: SELLER,
      minRating: '1',
      maxRating: '3',
      reportReason: 'abusive',
      paging: 'pages',
      page: '3',
      pageSize: '25',
      sort: 'rating',
      direction: 'asc',
    });
  });

  it('keeps the search inside what the API takes: no control or direction marks, 100 characters', () => {
    expect(searchText('  a‮b\u0007c  ')).toBe('a b c');
    expect(Array.from(searchText('x'.repeat(150)))).toHaveLength(100);
    expect(searchText('   ')).toBe('');
  });

  it('turns a star range around rather than asking for nothing, and drops unknown values', () => {
    expect(filtersOf({ minRating: '4', maxRating: '2' })).toEqual({
      minRating: '2',
      maxRating: '4',
    });
    expect(filtersOf({ minRating: '0', reportReason: 'negative', submitted: 'forever' })).toEqual(
      {},
    );
    // A shop reports only with its five reasons; a moderator's Hide reason is not a report reason.
    expect(filtersOf({ reportReason: 'spam' })).toEqual({});
  });

  it('exports ticked rows by id alone, capped at 200', () => {
    const ids = Array.from({ length: 205 }, (_, n) => `id-${n}`);
    const params = new URLSearchParams(
      exportParams({
        query: { ...DEFAULT_QUERY, view: 'held' },
        paging: 'pages',
        zone: BRISBANE,
        format: 'xlsx',
        columns: [],
        selection: { ids, allMatching: false, total: null },
      }),
    );
    expect([...params.keys()]).toEqual(['ids', 'format']);
    expect(params.get('ids')!.split(',')).toHaveLength(200);
  });

  it('cleans a stored column choice to the export column ids', () => {
    expect(cleanColumns(['locale', 'locale', 'author', 'edited'])).toEqual(['locale', 'edited']);
    expect(cleanColumns(undefined)).toEqual(['signals', 'seller-id']);
  });
});
