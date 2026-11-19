// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Toaster } from '@mondapac/ui';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: nav.push }) }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { cleanColumns, exportColumns } from './list/posts-columns.ts';
import { exportParams } from './list/posts-export.tsx';
import {
  DEFAULT_QUERY,
  defaultDirection,
  filtersOf,
  type PostListPage,
  type PostListRow,
} from './list/posts-list-types.ts';
import { queryString, searchText } from './list/posts-query.ts';
import { PostsList } from './posts-list.tsx';

// The Blog posts super list (list 26): views with counts, the title and web address search,
// filters, sort, columns, both List paging modes, selection and Export, and the Actions menu,
// which only opens pages.

const call = vi.mocked(callApi);
const BRISBANE = 'Australia/Brisbane';
const AUCKLAND = 'Pacific/Auckland';
// 2026-11-16 20:30 UTC: already the 17th in Brisbane (UTC+10) and the 17th, 9:30 am, in Auckland.
const NOW = new Date('2026-11-16T20:30:00.000Z');
const ME = '0190a000-0000-7000-8000-0000000000a1';
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const LIST = 'blog/admin/posts';
const nameOf = (n = 1) => `Post ${n}`;

const row = (n = 1, over: Partial<PostListRow> = {}): PostListRow => ({
  id: id(n),
  kind: 'product',
  slug: `post-${n}`,
  ownerType: 'platform',
  sellerId: null,
  status: 'published',
  openState: null,
  title: nameOf(n),
  featured: false,
  scheduledAt: null,
  publishedAt: '2026-10-27T03:20:00.000Z',
  updatedAt: '2026-10-27T03:20:00.000Z',
  actions: ['open', 'edit'],
  ...over,
});
const COUNTS = {
  all: 60,
  draft: 5,
  in_review: 4,
  changes_requested: 2,
  approved: 3,
  scheduled: 6,
  published: 30,
  unpublished: 4,
  archived: 6,
};
const pageOf = (items: PostListRow[], over: Partial<PostListPage> = {}): PostListPage => ({
  items,
  counts: COUNTS,
  total: items.length,
  page: 1,
  pageSize: 25,
  hasMore: false,
  nextCursor: null,
  ...over,
});
/** The answer of Previous and next: no total and no page. */
const openPage = (items: PostListRow[], nextCursor: string | null = null) =>
  pageOf(items, { total: null, page: null, hasMore: nextCursor !== null, nextCursor });

type Answer = PostListPage | 'fail' | 'denied' | 'unauthenticated' | 'refused';
const failure = (status: number, code: string, details: object = { fields: [] }) =>
  Promise.resolve({ ok: false, failure: { status, code, details } } as never);
const ok = (body: unknown, status = 200) => Promise.resolve({ ok: true, status, body } as never);

function serve(answer: (url: string) => Answer) {
  call.mockImplementation((method, path) => {
    if (method !== 'GET' || !path.startsWith(`${LIST}?`)) return failure(404, 'not-found');
    const result = answer(path);
    if (result === 'fail') return failure(503, 'blog.unavailable');
    if (result === 'denied') return failure(403, 'access.denied');
    if (result === 'unauthenticated') return failure(401, 'session.invalid');
    if (result === 'refused') return failure(400, 'validation.failed');
    return ok(result);
  });
}
const listUrls = () =>
  call.mock.calls
    .filter((entry) => entry[0] === 'GET' && entry[1].startsWith(`${LIST}?`))
    .map((entry) => entry[1]);
const lastParams = () => {
  const urls = listUrls();
  return Object.fromEntries(new URL(`http://x/${urls[urls.length - 1]!}`).searchParams);
};

function mount(
  options: {
    paging?: 'pages' | 'prev-next';
    view?: 'all' | 'draft' | 'in_review' | 'published' | 'archived';
    zone?: string;
    marketId?: string;
    canEdit?: boolean;
  } = {},
) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <PostsList
        paging={options.paging ?? 'pages'}
        accountId={ME}
        marketId={options.marketId ?? 'AU'}
        zone={options.zone ?? BRISBANE}
        canEdit={options.canEdit ?? false}
        initialView={options.view ?? 'all'}
      />
      <Toaster labels={{ region: messages.toast.region, close: messages.toast.close }} />
    </NextIntlClientProvider>,
  );
}
const postLink = (n = 1) => screen.findByRole('link', { name: nameOf(n) });
const openMenu = async (name = nameOf(1)) => {
  fireEvent.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  return screen.findByRole('menu');
};
const search = (text: string) => {
  const box = screen.getByRole('searchbox', { name: 'Search' });
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: 'Enter' });
};

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
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Blog posts list: page numbers', () => {
  it('asks for every post, page 1, newest created first, and shows the views, the row and the range', async () => {
    serve(() => pageOf([row()], { total: 143 }));
    mount();
    expect((await postLink()).getAttribute('href')).toBe(`/content/blog/${id(1)}`);
    expect(lastParams()).toEqual({
      view: 'all',
      sort: 'created',
      direction: 'desc',
      page: '1',
      pageSize: '25',
    });
    expect(screen.getByRole('button', { name: 'All (60)' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    const table = screen.getByRole('table');
    for (const header of ['Post', 'Status', 'Type', 'Author', 'Updated on', 'Actions']) {
      expect(within(table).getByRole('columnheader', { name: header })).toBeTruthy();
    }
    expect(within(table).getByText('Published', { selector: 'span' })).toBeTruthy();
    expect(within(table).getByText('/blog/post-1')).toBeTruthy();
    expect(within(table).getByText('Product')).toBeTruthy();
    expect(within(table).getByText('Mondapac team')).toBeTruthy();
    expect(screen.getByText('Sorted by Created on: Newest first')).toBeTruthy();
    expect(screen.getByText('1–1 of 143 posts')).toBeTruthy();
    for (const [name, view] of [
      ['Drafts (5)', 'draft'],
      ['In review (4)', 'in_review'],
      ['Changes requested (2)', 'changes_requested'],
      ['Approved (3)', 'approved'],
      ['Scheduled (6)', 'scheduled'],
      ['Published (30)', 'published'],
      ['Unpublished (4)', 'unpublished'],
      ['Archived (6)', 'archived'],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name }));
      await waitFor(() => expect(lastParams()['view']).toBe(view));
    }
  });

  it('opens the view of the link', async () => {
    serve(() => pageOf([row()]));
    mount({ view: 'in_review' });
    await postLink();
    expect(lastParams()['view']).toBe('in_review');
  });

  it('shows a seller post, a featured mark, a note for a newer version and the status as plain text when unknown', async () => {
    serve(() =>
      pageOf([
        row(1, { kind: 'brand', ownerType: 'seller', sellerId: id(90), featured: true }),
        row(2, { openState: 'in_review' }),
        row(3, { status: 'in_review', openState: 'in_review' }),
        row(4, { status: 'weird' }),
      ]),
    );
    mount();
    await postLink();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Brand')).toBeTruthy();
    expect(within(table).getByText('Seller')).toBeTruthy();
    expect(within(table).getByText('Featured on the blog home')).toBeTruthy();
    // One note: the post that is itself in review is described by its status alone.
    expect(within(table).getAllByText('New version in review')).toHaveLength(1);
    expect(within(table).getByText('weird')).toBeTruthy();
  });

  it('renders a title as plain text, never as markup', async () => {
    serve(() => pageOf([row(1, { title: '<img src=x onerror=alert(1)>' })]));
    const { container } = mount();
    await screen.findByText('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
  });

  it.each([
    { zone: 'Australia/Sydney', stamp: '27 Oct, 2:20 pm' },
    { zone: AUCKLAND, stamp: '27 Oct, 4:20 pm' },
  ])('writes times in $zone, not the browser zone', async ({ zone, stamp }) => {
    serve(() => pageOf([row()]));
    mount({ zone });
    await postLink();
    expect(within(screen.getByRole('table')).getByText(stamp)).toBeTruthy();
    expect(screen.getByText(`Dates are shown in ${zone}.`)).toBeTruthy();
  });

  it('has the optional columns of the go-live and published times, in the list zone', async () => {
    window.localStorage.setItem(
      'mp:admin:AU:' + ME + ':blog-posts-columns',
      JSON.stringify(['scheduled', 'published']),
    );
    serve(() => pageOf([row(1, { status: 'scheduled', scheduledAt: '2026-10-31T21:00:00.000Z' })]));
    mount();
    await postLink();
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Goes live on' })).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: 'Published on' })).toBeTruthy();
    // 21:00 UTC on the 31st is 7:00 am on 1 Nov in Brisbane.
    expect(within(table).getByText('1 Nov, 7:00 am')).toBeTruthy();
    expect(within(table).queryByRole('columnheader', { name: 'Type' })).toBeNull();
  });

  it('keeps New post and Categories and tags in the heading, New post for an editor only', async () => {
    serve(() => pageOf([row()]));
    mount({ canEdit: false });
    await postLink();
    expect(screen.queryByRole('link', { name: 'New post' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Categories and tags' }).getAttribute('href')).toBe(
      '/content/blog/taxonomy',
    );
    cleanup();
    mount({ canEdit: true });
    expect((await screen.findByRole('link', { name: 'New post' })).getAttribute('href')).toBe(
      '/content/blog/new',
    );
  });

  it('has no button in a row; its menu names only pages and no label ends in an ellipsis', async () => {
    serve(() =>
      pageOf([
        row(1, {
          actions: ['open', 'edit', 'submit', 'approve', 'publish', 'feature', 'teleport'],
        }),
      ]),
    );
    mount();
    await postLink();
    const buttons = within(screen.getByRole('table'))
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? button.textContent);
    expect(buttons).toEqual([`Actions for ${nameOf(1)}`]);
    const menu = await openMenu();
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['Open', 'Edit', 'Review', 'Publishing']);
    fireEvent.click(items[2]!);
    expect(nav.push).toHaveBeenCalledWith(`/content/blog/${id(1)}/review`);
  });

  it('offers exactly what the row names: Open alone, Edit only when named, Review and Publishing apart', async () => {
    serve(() =>
      pageOf([
        row(1, { actions: ['open'] }),
        row(2, { actions: ['open', 'edit'] }),
        row(3, { actions: ['open', 'request-changes'] }),
        row(4, { actions: ['open', 'archive'] }),
      ]),
    );
    mount();
    await postLink(1);
    const labels = async (n: number) =>
      within(await openMenu(nameOf(n)))
        .getAllByRole('menuitem')
        .map((item) => item.textContent);
    expect(await labels(1)).toEqual(['Open']);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(await labels(2)).toEqual(['Open', 'Edit']);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(await labels(3)).toEqual(['Open', 'Review']);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(await labels(4)).toEqual(['Open', 'Publishing']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Publishing' }));
    expect(nav.push).toHaveBeenCalledWith(`/content/blog/${id(4)}/review`);
  });

  it('sends Open and Edit to the post page', async () => {
    serve(() => pageOf([row()]));
    mount();
    await postLink();
    fireEvent.click(within(await openMenu()).getByRole('menuitem', { name: 'Edit' }));
    expect(nav.push).toHaveBeenCalledWith(`/content/blog/${id(1)}`);
  });

  it('offers no menu on a row that names no action', async () => {
    serve(() => pageOf([row(1, { actions: [] })]));
    mount();
    await postLink();
    expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
  });

  it('sends the words as typed, control characters as spaces, and shows them as a chip', async () => {
    serve(() => pageOf([row()]));
    mount();
    await postLink();
    search('\t eid\tsweets \u0007 ');
    await waitFor(() => expect(lastParams()['q']).toBe('eid sweets'));
    expect(screen.getByText('Title or web address has eid sweets')).toBeTruthy();
    // A zero-width non-joiner (Persian text) is kept.
    search('می‌خواهم');
    await waitFor(() => expect(lastParams()['q']).toBe('می‌خواهم'));
    // An empty search asks for nothing.
    search('   ');
    await waitFor(() => expect(lastParams()['q']).toBeUndefined());
  });

  it('cuts the search to 100 characters', async () => {
    serve(() => pageOf([row()]));
    mount();
    await postLink();
    expect(screen.getByRole('searchbox', { name: 'Search' }).getAttribute('maxlength')).toBe('100');
    search('x'.repeat(130));
    await waitFor(() => expect(lastParams()['q']).toBe('x'.repeat(100)));
  });

  const applyFilter = async (field: string, value: string) => {
    fireEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    fireEvent.change(within(panel).getByLabelText('Field'), { target: { value: field } });
    fireEvent.change(within(panel).getByLabelText('Value'), { target: { value } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
  };

  it('filters from the panel and shows each filter as a removable chip', async () => {
    serve(() => pageOf([row()], { total: 7 }));
    mount();
    await postLink();
    await applyFilter('kind', 'event');
    await waitFor(() => expect(lastParams()['kind']).toBe('event'));
    expect(screen.getByText('7 posts match')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter Type is Event' }));
    await waitFor(() => expect(lastParams()['kind']).toBeUndefined());
    await applyFilter('owner', 'seller');
    await waitFor(() => expect(lastParams()['owner']).toBe('seller'));
    expect(screen.getByText('Author is Seller')).toBeTruthy();
    await applyFilter('featured', 'yes');
    await waitFor(() => expect(lastParams()['featured']).toBe('true'));
    await applyFilter('featured', 'no');
    await waitFor(() => expect(lastParams()['featured']).toBe('false'));
    expect(screen.getByText('Featured is Not featured')).toBeTruthy();
  });

  it.each([
    { zone: BRISBANE, from: '2026-11-16T14:00:00.000Z', to: '2026-11-17T14:00:00.000Z' },
    { zone: AUCKLAND, from: '2026-11-16T11:00:00.000Z', to: '2026-11-17T11:00:00.000Z' },
  ])('reads the Updated on preset on the clock of $zone', async ({ zone, from, to }) => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    serve(() => pageOf([row()]));
    mount({ zone });
    await postLink();
    await applyFilter('updated', 'today');
    await waitFor(() => expect(lastParams()['from']).toBeDefined());
    expect(lastParams()).toMatchObject({ from, to });
    expect(screen.getByText('Updated on is Today')).toBeTruthy();
  });

  it('starts each sort on its own first order, and labels the first order as that', async () => {
    serve(() => pageOf([row()]));
    mount();
    await postLink();
    fireEvent.click(screen.getByRole('button', { name: /^Sort/ }));
    // Created on starts newest first, so that is its first radio and it is chosen.
    const newest = await screen.findByRole('radio', { name: 'Newest first' });
    expect((newest as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Oldest first' }));
    await waitFor(() => expect(lastParams()['direction']).toBe('asc'));
    expect(screen.getByText('Sorted by Created on: Oldest first')).toBeTruthy();
    // The go-live time starts with the soonest.
    fireEvent.click(screen.getByRole('radio', { name: 'Goes live on' }));
    await waitFor(() => expect(lastParams()['sort']).toBe('scheduled'));
    expect(lastParams()['direction']).toBe('asc');
    const soonest = screen.getByRole('radio', { name: 'Soonest first' });
    expect((soonest as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('Sorted by Goes live on: Soonest first')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Updated on' }));
    await waitFor(() => expect(lastParams()['sort']).toBe('updated'));
    expect(lastParams()['direction']).toBe('desc');
    const recent = screen.getByRole('radio', { name: 'Most recent first' });
    expect((recent as HTMLInputElement).checked).toBe(true);
  });

  it('keeps the ticked rows over paging and for the same words in another case, and drops them for a new search, sort, filter or view', async () => {
    serve((url) =>
      url.includes('page=2')
        ? pageOf([row(2)], { total: 30, page: 2 })
        : pageOf([row()], { total: 30 }),
    );
    mount();
    await postLink();
    const tick = () =>
      fireEvent.click(screen.getByRole('checkbox', { name: `Select ${nameOf()}` }));
    const gone = () => waitFor(() => expect(screen.queryByText('1 post selected')).toBeNull());
    tick();
    search('eid');
    await waitFor(() => expect(lastParams()['q']).toBe('eid'));
    // A new search is another list: the tick goes.
    await gone();
    tick();
    const reads = listUrls().length;
    search(' EID ');
    // The same words in capitals are the same list: the tick stays.
    await waitFor(() => expect(listUrls().length).toBeGreaterThanOrEqual(reads));
    await postLink();
    expect(screen.getByText('1 post selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Page 2' }));
    expect(await postLink(2)).toBeTruthy();
    expect(screen.getByText('1 post selected')).toBeTruthy();
    // Back on page 1 the row is still ticked; a sort starts another list.
    fireEvent.click(screen.getByRole('button', { name: 'Page 1' }));
    await postLink(1);
    fireEvent.click(screen.getByRole('button', { name: /^Sort/ }));
    fireEvent.click(await screen.findByRole('radio', { name: 'Oldest first' }));
    await gone();
    tick();
    await applyFilter('kind', 'news');
    await gone();
    tick();
    fireEvent.click(screen.getByRole('button', { name: 'Drafts (5)' }));
    await gone();
  });

  it('goes back to the last page with rows when a page is past the end', async () => {
    serve((url) => {
      if (url.includes('page=4')) return pageOf([], { total: 30, page: 4 });
      if (url.includes('page=2')) return pageOf([row(2)], { total: 30, page: 2 });
      return pageOf([row()], { total: 90 });
    });
    mount();
    await postLink();
    fireEvent.click(screen.getByRole('button', { name: 'Page 4' }));
    expect(await postLink(2)).toBeTruthy();
    expect(listUrls().map((url) => new URL(`http://x/${url}`).searchParams.get('page'))).toEqual([
      '1',
      '4',
      '2',
    ]);
  });

  it('says the API refused the query without a Try again, and offers one when it is down', async () => {
    serve(() => 'refused');
    mount();
    expect(await screen.findByText(/This search can't be run/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    cleanup();
    serve(() => 'fail');
    mount();
    expect(await screen.findByText('The posts could not be loaded.')).toBeTruthy();
    serve(() => pageOf([row()]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await postLink()).toBeTruthy();
  });

  it('says there is no access on a 403 and sends a signed-out admin away on a 401', async () => {
    serve(() => 'denied');
    mount();
    expect(await screen.findByText('You do not have access to this list.')).toBeTruthy();
    cleanup();
    const assign = vi.fn();
    vi.stubGlobal('location', { assign, href: 'http://admin.localhost/content/blog' });
    serve(() => 'unauthenticated');
    mount();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });

  it('shows the empty state of a view, and a no-match state with Clear all', async () => {
    serve(() => pageOf([], { total: 0 }));
    mount({ view: 'archived' });
    expect(await screen.findByText('No posts are archived.')).toBeTruthy();
    search('saffron');
    expect(await screen.findByText('No posts match')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear all' })[0]!);
    await waitFor(() => expect(lastParams()['q']).toBeUndefined());
  });

  it('says so when no post exists at all', async () => {
    serve(() => pageOf([], { total: 0, counts: { ...COUNTS, all: 0 } }));
    mount();
    expect(await screen.findByText(/No posts yet/)).toBeTruthy();
  });
});

describe('Blog posts list: Previous and next', () => {
  it('sends limit and the cursor only, with no sort, and steps Next, Next, Previous', async () => {
    serve((url) => {
      if (url.includes('cursor=c2')) return openPage([row(3)]);
      if (url.includes('cursor=c1')) return openPage([row(2)], 'c2');
      return openPage([row()], 'c1');
    });
    mount({ paging: 'prev-next' });
    await postLink();
    expect(lastParams()).toEqual({ view: 'all', limit: '25' });
    expect(screen.queryByRole('button', { name: /^Sort/ })).toBeNull();
    expect(screen.getByText('Sorted by Created on: Newest first')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await postLink(2);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await postLink(3);
    expect(lastParams()).toEqual({ view: 'all', limit: '25', cursor: 'c2' });
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(await postLink(2)).toBeTruthy();
    expect(lastParams()).toEqual({ view: 'all', limit: '25', cursor: 'c1' });
  });

  it('steps back once when a page comes back empty', async () => {
    serve((url) => {
      if (url.includes('cursor=c2')) return openPage([]);
      if (url.includes('cursor=c1')) return openPage([row(2)], 'c2');
      return openPage([row()], 'c1');
    });
    mount({ paging: 'prev-next' });
    await postLink();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await postLink(2);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(listUrls()).toHaveLength(4));
    expect(lastParams()).toEqual({ view: 'all', limit: '25', cursor: 'c1' });
    // No further read follows the step back.
    await new Promise((done) => setTimeout(done, 30));
    expect(listUrls()).toHaveLength(4);
  });
});

describe('Blog posts list: queries and export', () => {
  const context = { paging: 'pages' as const, zone: BRISBANE, now: NOW };

  it('builds the list query with every filter, and always names the view', () => {
    const query = {
      ...DEFAULT_QUERY,
      view: 'in_review' as const,
      q: ' eid sweets ',
      filters: {
        kind: 'event' as const,
        owner: 'seller' as const,
        featured: 'yes' as const,
        updated: 'today' as const,
      },
      sort: 'published' as const,
      direction: 'asc' as const,
      page: 3,
    };
    expect(Object.fromEntries(new URLSearchParams(queryString(query, context)))).toEqual({
      view: 'in_review',
      q: 'eid sweets',
      kind: 'event',
      owner: 'seller',
      featured: 'true',
      // The 17th in Brisbane (UTC+10).
      from: '2026-11-16T14:00:00.000Z',
      to: '2026-11-17T14:00:00.000Z',
      sort: 'published',
      direction: 'asc',
      page: '3',
      pageSize: '25',
    });
    expect(
      queryString({ ...DEFAULT_QUERY, cursors: ['a', 'b'] }, { ...context, paging: 'prev-next' }),
    ).toBe('view=all&limit=25&cursor=b');
  });

  it('cleans the search text, filters and columns', () => {
    expect(searchText('\u0000a\tb­ ‌ ')).toBe('a b­ ‌'.trim());
    expect(searchText('   ')).toBe('');
    expect(searchText('x'.repeat(101))).toHaveLength(100);
    expect(defaultDirection('scheduled')).toBe('asc');
    expect(defaultDirection('created')).toBe('desc');
    expect(
      filtersOf({ kind: 'podcast', owner: 'seller', featured: 'maybe', updated: 'x' }),
    ).toEqual({ owner: 'seller' });
    expect(cleanColumns(['published', 'nope', 'kind'])).toEqual(['published', 'kind']);
  });

  it('maps the columns on screen to the columns of the export', () => {
    expect(exportColumns(['kind', 'published', 'author', 'scheduled'])).toEqual([
      'slug',
      'featured',
      'stage',
      'published',
      'scheduled',
    ]);
    expect(exportColumns([])).toEqual(['slug', 'featured', 'stage']);
  });

  it('exports ticked rows by id alone, and all matching by the selector and the sort', () => {
    const query = { ...DEFAULT_QUERY, q: 'eid', sort: 'updated' as const };
    const params = (input: Partial<Parameters<typeof exportParams>[0]>) =>
      Object.fromEntries(
        new URLSearchParams(
          exportParams({
            query,
            paging: 'pages',
            zone: BRISBANE,
            format: 'csv',
            columns: [],
            selection: { ids: [], allMatching: false, total: 30 },
            now: NOW,
            ...input,
          }),
        ),
      );
    expect(
      params({
        columns: ['kind', 'published'],
        selection: { ids: [id(1), id(2)], allMatching: false, total: 30 },
      }),
    ).toEqual({
      ids: `${id(1)},${id(2)}`,
      format: 'csv',
      columns: 'slug,featured,stage,published',
    });
    expect(
      params({
        paging: 'prev-next',
        format: 'xlsx',
        selection: { ids: [], allMatching: true, total: null },
      }),
    ).toEqual({
      view: 'all',
      q: 'eid',
      sort: 'created',
      direction: 'desc',
      format: 'xlsx',
      columns: 'slug,featured,stage',
    });
    expect(params({ selection: { ids: [], allMatching: true, total: 30 } })).toMatchObject({
      sort: 'updated',
      direction: 'desc',
    });
    expect(() => params({})).toThrow('export.no-rows-selected');
  });

  const stubDownload = () => {
    const fetched: string[] = [];
    const objectUrl = vi.fn(() => 'blob:x');
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        fetched.push(url);
        return Promise.resolve(
          new Response('id\n1\n', { headers: { 'content-type': 'text/csv' } }),
        );
      }),
    );
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: objectUrl, revokeObjectURL: () => {} }),
    );
    return { fetched, objectUrl };
  };

  it('downloads the file of the ticked rows from the Bulk action menu, Export being the only item', async () => {
    const { fetched } = stubDownload();
    serve(() => pageOf([row()]));
    mount();
    await postLink();
    const bulk = screen.getByRole('button', { name: 'Bulk action' });
    expect(bulk.hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${nameOf()}` }));
    fireEvent.click(bulk);
    const menu = await screen.findByRole('menu', { name: 'Bulk action' });
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1);
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Export/ }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Export' }),
    );
    await waitFor(() => expect(fetched).toHaveLength(1));
    const url = new URL(fetched[0]!, 'http://x');
    expect(url.pathname).toBe('/api/blog/admin/posts/export');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      ids: id(1),
      format: 'csv',
      columns: 'slug,featured,stage',
    });
  });

  it('selects all matching posts, exports them by the selector, and drops them for another view', async () => {
    const { fetched } = stubDownload();
    serve(() => pageOf([row()], { total: 30 }));
    mount();
    await postLink();
    search('eid');
    await waitFor(() => expect(lastParams()['q']).toBe('eid'));
    await postLink();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all posts on this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all 30 matching' }));
    expect(screen.getByText('All 30 matching posts are selected')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    fireEvent.click(
      within(await screen.findByRole('menu', { name: 'Bulk action' })).getByRole('menuitem', {
        name: /^Export/,
      }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByLabelText(/XLSX/));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(fetched).toHaveLength(1));
    const params = Object.fromEntries(new URL(fetched[0]!, 'http://x').searchParams);
    // The selector, never the ids.
    expect(params['ids']).toBeUndefined();
    expect(params).toMatchObject({
      view: 'all',
      q: 'eid',
      sort: 'created',
      direction: 'desc',
      format: 'xlsx',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Drafts (5)' }));
    await waitFor(() =>
      expect(screen.queryByText('All 30 matching posts are selected')).toBeNull(),
    );
  });

  async function exportWith(response: Response) {
    const { objectUrl } = stubDownload();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response)),
    );
    serve(() => pageOf([row()]));
    mount();
    await postLink();
    fireEvent.click(screen.getByRole('checkbox', { name: `Select ${nameOf()}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Bulk action' }));
    fireEvent.click(
      within(await screen.findByRole('menu', { name: 'Bulk action' })).getByRole('menuitem', {
        name: /^Export/,
      }),
    );
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Export' }),
    );
    return objectUrl;
  }
  const json = (status: number, body: object) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  it('says when the file would be too large, and offers no file', async () => {
    const objectUrl = await exportWith(
      json(413, { code: 'batch.too-large', details: { max: 10000, total: 12000 } }),
    );
    expect(await screen.findByText(/Too many rows to export: 12,?000 match/)).toBeTruthy();
    expect(objectUrl).not.toHaveBeenCalled();
  });

  it('says when the export filters are refused, and offers no file', async () => {
    const objectUrl = await exportWith(
      json(400, { code: 'validation.failed', details: { fields: [{ path: 'from' }] } }),
    );
    expect(await screen.findByText(/can't be exported with its current filters/)).toBeTruthy();
    expect(objectUrl).not.toHaveBeenCalled();
  });

  it('says when the export is unavailable, and offers no file', async () => {
    const objectUrl = await exportWith(json(503, { code: 'blog.unavailable' }));
    expect(await screen.findByText('Export failed. Try again.')).toBeTruthy();
    expect(objectUrl).not.toHaveBeenCalled();
  });

  it('keeps the column choice for this viewer in storage, and drops an unknown stored id', async () => {
    window.localStorage.setItem(
      'mp:admin:AU:' + ME + ':blog-posts-columns',
      JSON.stringify(['published', 'nope']),
    );
    serve(() => pageOf([row()]));
    mount();
    await postLink();
    const table = () => screen.getByRole('table');
    expect(within(table()).getByRole('columnheader', { name: 'Published on' })).toBeTruthy();
    expect(within(table()).queryByRole('columnheader', { name: 'Type' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Columns' }));
    const panel = await screen.findByRole('dialog', { name: 'Columns' });
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Published on' }));
    fireEvent.click(within(panel).getByRole('checkbox', { name: 'Type' }));
    fireEvent.click(within(panel).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(within(table()).queryByRole('columnheader', { name: 'Published on' })).toBeNull(),
    );
    expect(within(table()).getByRole('columnheader', { name: 'Type' })).toBeTruthy();
    expect(
      JSON.parse(window.localStorage.getItem('mp:admin:AU:' + ME + ':blog-posts-columns')!),
    ).toEqual(['kind']);
  });

  it('keeps the column choice per Market', async () => {
    window.localStorage.setItem(
      'mp:admin:NZ:' + ME + ':blog-posts-columns',
      JSON.stringify(['published']),
    );
    serve(() => pageOf([row()]));
    mount({ marketId: 'NZ', zone: AUCKLAND });
    await postLink();
    expect(
      within(screen.getByRole('table')).getByRole('columnheader', { name: 'Published on' }),
    ).toBeTruthy();
  });
});
