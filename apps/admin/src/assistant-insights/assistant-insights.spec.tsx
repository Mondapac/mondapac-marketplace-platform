// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { addDays, averageCostUsd, rangeQuery } from './insights-math.ts';
import { AssistantInsights } from './insights-view.tsx';
import { LIST_KEY, payloadOf, queryOf, somethingToSave } from './list-saved.ts';
import { DEFAULT_QUERY, filtersOf, type Insights, type UnansweredRow } from './types.ts';

const call = vi.mocked(callApi);

const group = (query: string, count: number, reasons: UnansweredRow['reasons']): UnansweredRow => ({
  query,
  count,
  lastAt: '2026-11-19T01:00:00Z',
  reasons,
});
const EVIL = '<img src=x onerror="alert(1)"> =HYPERLINK("http://x")';
const ROWS = [
  group('halal kangaroo mince', 9, { 'no-results': 9 }),
  group(EVIL, 3, { 'thumbs-down': 3 }),
  group('refund my order', 2, { unavailable: 2 }),
];
const answer = (over: Partial<Insights> = {}, rows: readonly UnansweredRow[] = ROWS): Insights => ({
  from: '2026-10-22',
  to: '2026-11-20',
  days: [
    { day: '2026-11-19', conversations: 4, spendMicroUsd: 120_000 },
    { day: '2026-11-20', conversations: 6, spendMicroUsd: 180_000 },
  ],
  totals: { conversations: 10, spendMicroUsd: 300_000 },
  feedback: { up: 6, down: 2, upShare: 0.75, reasons: { wrong: 1, 'not-found': 1 } },
  handoffs: 3,
  unanswered: { total: rows.length, page: 1, pageSize: 100, truncated: false, rows },
  ...over,
});

const wrap = () =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <AssistantInsights
        paging="pages"
        zone="Australia/Brisbane"
        accountId="acc"
        marketId="AU"
        csrfToken="csrf"
      />
    </NextIntlClientProvider>,
  );

function serve(body: Insights | 'fail' = answer()) {
  call.mockImplementation((_method, path) => {
    if (path.startsWith('lists/admin/saved-filters')) {
      return Promise.resolve({
        ok: false,
        failure: { status: 400, code: 'validation.failed', details: { fields: [] } },
      } as never);
    }
    return Promise.resolve(
      body === 'fail'
        ? ({ ok: false, failure: { status: 503, code: 'unavailable' } } as never)
        : ({ ok: true, status: 200, body } as never),
    );
  });
}
const insightCalls = () =>
  call.mock.calls
    .map((entry) => entry[1])
    .filter((path) => path.startsWith('assistant/admin/insights'));

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
  call.mockReset();
  window.localStorage.clear();
});
afterEach(cleanup);

describe('insights maths', () => {
  it('moves whole calendar days and builds a range ending today', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(rangeQuery('7', '2026-11-20', 2)).toBe(
      'from=2026-11-14&to=2026-11-20&page=2&pageSize=100',
    );
  });
  it('averages the cost of a conversation, or says there is none', () => {
    expect(averageCostUsd({ conversations: 4, spendMicroUsd: 120_000 })).toBeCloseTo(0.03);
    expect(averageCostUsd({ conversations: 0, spendMicroUsd: 0 })).toBeNull();
  });
});

describe('saved filter document', () => {
  it('round-trips the view, filters and sort and drops what the page does not know', () => {
    const query = {
      ...DEFAULT_QUERY,
      view: 'failed' as const,
      filters: { reason: 'unavailable' },
      sort: 'last' as const,
    };
    expect(LIST_KEY).toBe('admin.assistant.insights');
    expect(payloadOf(query)).toEqual({
      v: 1,
      view: 'failed',
      filters: { reason: 'unavailable' },
      sort: 'last',
    });
    expect(queryOf(payloadOf(query))).toMatchObject({ view: 'failed', sort: 'last', q: '' });
    expect(queryOf({ v: 1, view: 'nope' as never, filters: { reason: 'x' } })).toMatchObject({
      view: 'all',
      filters: {},
    });
    expect(somethingToSave(DEFAULT_QUERY)).toBe(false);
    expect(filtersOf({ minCount: '5', other: '1' })).toEqual({ minCount: '5' });
  });
});

describe('AssistantInsights', () => {
  it('shows the summary, the feedback share and the unanswered list', async () => {
    serve();
    wrap();
    expect(await screen.findByText('Summary')).toBeTruthy();
    expect(screen.getByText('75% thumbs up (6 up, 2 down).')).toBeTruthy();
    expect(screen.getByText('Wrong: 1')).toBeTruthy();
    expect(screen.getByText('halal kangaroo mince')).toBeTruthy();
    expect(screen.getByRole('button', { name: /All \(3\)/ })).toBeTruthy();
    expect(insightCalls()[0]).toBe('assistant/admin/insights?page=1&pageSize=100');
  });

  it('renders the buyer text as plain text, never as markup', async () => {
    serve();
    const { container } = wrap();
    expect(await screen.findAllByText(EVIL)).not.toHaveLength(0);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
  });

  it('reads the second page when more than 100 groups exist', async () => {
    const first = answer({}, ROWS.slice(0, 2));
    const big = {
      ...first,
      unanswered: { ...first.unanswered, total: 3, pageSize: 2, rows: ROWS.slice(0, 2) },
    };
    const second = {
      ...big,
      unanswered: { ...big.unanswered, page: 2, rows: ROWS.slice(2) },
    };
    let n = 0;
    call.mockImplementation((_m, path) => {
      if (path.startsWith('lists/'))
        return Promise.resolve({ ok: false, failure: { status: 400, code: 'x' } } as never);
      n += 1;
      return Promise.resolve({ ok: true, status: 200, body: n === 1 ? big : second } as never);
    });
    wrap();
    expect(await screen.findByText('refund my order')).toBeTruthy();
    expect(insightCalls()[1]).toBe(
      'assistant/admin/insights?from=2026-10-22&to=2026-11-20&page=2&pageSize=100',
    );
  });

  it('searches, filters by view and clears', async () => {
    serve();
    wrap();
    await screen.findByText('halal kangaroo mince');
    fireEvent.click(screen.getByRole('button', { name: /Nothing found \(1\)/ }));
    await waitFor(() => expect(screen.queryByText('refund my order')).toBeNull());
    expect(screen.getByText('halal kangaroo mince')).toBeTruthy();
  });

  it('copies a question from the row Actions menu', async () => {
    serve();
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    wrap();
    await screen.findByText('halal kangaroo mince');
    fireEvent.click(
      screen.getByRole('button', { name: 'Actions for the question “halal kangaroo mince”' }),
    );
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy question' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('halal kangaroo mince'));
  });

  it('says what happened when the insights cannot be read, and tries again', async () => {
    serve('fail');
    wrap();
    expect(await screen.findByText("The insights couldn't be loaded.")).toBeTruthy();
    serve();
    fireEvent.click(within(document.body).getByRole('button', { name: /try again|retry/i }));
    expect(await screen.findByText('Summary')).toBeTruthy();
  });

  it('asks a longer range with dates from the Market day of the first answer', async () => {
    serve();
    wrap();
    await screen.findByText('Summary');
    fireEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));
    await waitFor(() =>
      expect(insightCalls()).toContain(
        'assistant/admin/insights?from=2026-11-14&to=2026-11-20&page=1&pageSize=100',
      ),
    );
  });

  it('keeps the first groups and says so when the second page fails', async () => {
    const big = {
      ...answer({}, ROWS.slice(0, 2)),
      unanswered: { total: 3, page: 1, pageSize: 2, truncated: false, rows: ROWS.slice(0, 2) },
    };
    let n = 0;
    call.mockImplementation((_m, path) => {
      if (path.startsWith('lists/')) {
        return Promise.resolve({ ok: false, failure: { status: 400, code: 'x' } } as never);
      }
      n += 1;
      return Promise.resolve(
        n === 1
          ? ({ ok: true, status: 200, body: big } as never)
          : ({ ok: false, failure: { status: 503, code: 'unavailable' } } as never),
      );
    });
    wrap();
    expect(await screen.findByText('halal kangaroo mince')).toBeTruthy();
    expect(screen.getByText(/Only the first part of the unanswered questions/)).toBeTruthy();
  });

  it('keeps the figures on show when a refresh fails, and asks the Market day again', async () => {
    serve();
    wrap();
    await screen.findByText('halal kangaroo mince');
    serve('fail');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText(/couldn't be refreshed/)).toBeTruthy();
    expect(screen.getByText('halal kangaroo mince')).toBeTruthy();
    // Refresh reads without dates, so a tab left open past midnight moves on.
    expect(insightCalls().at(-1)).toBe('assistant/admin/insights?page=1&pageSize=100');
  });

  it('pages the list on the client, 25 at a time', async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      group(`question number ${i}`, 100 - i, { 'no-results': 1 }),
    );
    serve(answer({}, many));
    wrap();
    await screen.findByText('question number 0');
    expect(screen.queryByText('question number 25')).toBeNull();
    expect(screen.getByText('1-25 of 60')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^(Page )?2$/ }));
    expect(await screen.findByText('question number 25')).toBeTruthy();
    expect(screen.queryByText('question number 0')).toBeNull();
  });

  it('exports the selected questions as a CSV that stays text', async () => {
    serve();
    const saved: Blob[] = [];
    const url = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      saved.push(blob as Blob);
      return 'blob:x';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    wrap();
    await screen.findByText('halal kangaroo mince');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all questions on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    const menu = await screen.findByRole('menu', { name: 'Bulk action' });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Export…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Export' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    const text = await saved[0]!.text();
    expect(text).toContain('halal kangaroo mince,9,');
    expect(text).toContain(`"<img src=x onerror=""alert(1)""> =HYPERLINK`);
    url.mockRestore();
  });

  it('offers saved filters once the lists module knows the list', async () => {
    call.mockImplementation((_m, path) =>
      Promise.resolve(
        path.startsWith('lists/admin/saved-filters')
          ? ({
              ok: true,
              status: 200,
              body: {
                items: [
                  {
                    id: 's1',
                    listKey: LIST_KEY,
                    name: 'Thumbs this week',
                    visibility: 'me',
                    payload: { v: 1, view: 'thumbs-down' },
                    ownedByMe: true,
                    canManage: true,
                    createdAt: '',
                    updatedAt: '',
                  },
                ],
                canShare: false,
              },
            } as never)
          : ({ ok: true, status: 200, body: answer() } as never),
      ),
    );
    wrap();
    fireEvent.click(await screen.findByRole('button', { name: 'Thumbs this week' }));
    await waitFor(() => expect(screen.queryByText('halal kangaroo mince')).toBeNull());
    expect((await screen.findAllByText(EVIL)).length).toBeGreaterThan(0);
  });
});
