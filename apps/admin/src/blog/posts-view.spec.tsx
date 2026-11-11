// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi, type ApiResult } from '../api/client.ts';
import { PostsView } from './posts-view.tsx';
import type { PostPage, PostRow } from './types.ts';

const call = vi.mocked(callApi);
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

const row = (n: number, over: Partial<PostRow> = {}): PostRow => ({
  id: id(n),
  kind: 'product',
  slug: `post-${n}`,
  ownerType: 'platform',
  sellerId: null,
  status: 'published',
  openState: null,
  title: `Post ${n}`,
  featured: false,
  scheduledAt: null,
  publishedAt: '2026-10-27T03:20:00.000Z',
  updatedAt: '2026-10-27T03:20:00.000Z',
  ...over,
});
const page = (items: PostRow[], over: Partial<PostPage> = {}): PostPage => ({
  items,
  page: 1,
  pageSize: 50,
  hasMore: false,
  ...over,
});
const answer = <T,>(body: T): ApiResult<T> => ({ ok: true, status: 200, body });
const failure = (status: number): ApiResult<never> => ({
  ok: false,
  failure: { status, code: 'x' },
});

// Both Market time zones the panel meets: Australia (AEDT, UTC+11) and a synthetic zone.
const ZONES = [
  { zone: 'Australia/Sydney', stamp: '27 Oct, 2:20 pm' },
  { zone: 'Pacific/Auckland', stamp: '27 Oct, 4:20 pm' },
] as const;

function show(zone = 'Australia/Sydney') {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <PostsView zone={zone} />
    </NextIntlClientProvider>,
  );
}
const lastPath = () => call.mock.calls.at(-1)![1];

describe('admin blog posts list', () => {
  beforeEach(() => {
    call.mockReset();
  });
  afterEach(cleanup);

  it('shows the posts with type, author, status and the update time in the Market zone', async () => {
    call.mockResolvedValue(
      answer(
        page([
          row(1),
          row(2, {
            kind: 'brand',
            ownerType: 'seller',
            sellerId: id(90),
            status: 'in_review',
            title: 'Meet Saffron & Co',
          }),
        ]),
      ),
    );
    show();
    const table = await screen.findByRole('table', { name: 'Blog' });
    expect(call).toHaveBeenCalledWith('GET', 'blog/admin/posts');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Post 1')).toBeTruthy();
    expect(within(rows[0]!).getByText('/blog/post-1')).toBeTruthy();
    expect(within(rows[0]!).getByText('Mondapac team')).toBeTruthy();
    expect(within(rows[0]!).getByText('Published')).toBeTruthy();
    expect(within(rows[1]!).getByText('Brand')).toBeTruthy();
    expect(within(rows[1]!).getByText('Seller')).toBeTruthy();
    expect(within(rows[1]!).getByText('In review')).toBeTruthy();
  });

  it.each(ZONES)('writes times in $zone, not the browser zone', async ({ zone, stamp }) => {
    call.mockResolvedValue(answer(page([row(1)])));
    show(zone);
    expect(await screen.findByText(stamp)).toBeTruthy();
    expect(screen.getByText(`Times are shown in ${zone}.`)).toBeTruthy();
  });

  it('shows the schedule time of a scheduled post and a note for a new version in review', async () => {
    call.mockResolvedValue(
      answer(
        page([
          row(1, {
            status: 'scheduled',
            scheduledAt: '2026-10-31T21:00:00.000Z',
            publishedAt: null,
          }),
          row(2, { openState: 'in_review' }),
        ]),
      ),
    );
    show();
    expect(await screen.findByText('1 Nov, 8:00 am')).toBeTruthy();
    expect(screen.getByText('New version in review')).toBeTruthy();
  });

  it('does not repeat the status as a note for a post that is itself in review', async () => {
    call.mockResolvedValue(answer(page([row(1, { status: 'in_review', openState: 'in_review' })])));
    show();
    await screen.findByText('Post 1');
    expect(screen.queryByText('New version in review')).toBeNull();
  });

  it('asks the API for the status of the chosen tab, then the type and the author', async () => {
    call.mockResolvedValue(answer(page([row(1)])));
    show();
    await screen.findByText('Post 1');
    fireEvent.click(screen.getByRole('button', { name: 'In review' }));
    await waitFor(() => expect(lastPath()).toBe('blog/admin/posts?status=in_review'));
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'event' } });
    await waitFor(() => expect(lastPath()).toBe('blog/admin/posts?status=in_review&kind=event'));
    fireEvent.change(screen.getByLabelText('Author'), { target: { value: 'seller' } });
    await waitFor(() =>
      expect(lastPath()).toBe('blog/admin/posts?status=in_review&kind=event&owner=seller'),
    );
  });

  it('says so when nothing exists, and when the filters match nothing', async () => {
    call.mockResolvedValue(answer(page([])));
    show();
    expect(await screen.findByText(/No posts yet/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Drafts' }));
    expect(await screen.findByText('No posts match these filters.')).toBeTruthy();
  });

  it('shows a load error with a retry that reads again', async () => {
    call.mockResolvedValueOnce(failure(500)).mockResolvedValueOnce(answer(page([row(1)])));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Post 1')).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('sends a rejected session to sign-in', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    call.mockResolvedValue(failure(401));
    show();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    vi.unstubAllGlobals();
  });

  it('loads the next page by number and appends it; a failed page keeps the rows', async () => {
    call
      .mockResolvedValueOnce(answer(page([row(1)], { hasMore: true })))
      .mockResolvedValueOnce(failure(500))
      .mockResolvedValueOnce(answer(page([row(2)], { page: 2 })));
    show();
    await screen.findByText('Post 1');
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('Post 1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Post 2')).toBeTruthy();
    expect(lastPath()).toBe('blog/admin/posts?page=2');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('renders a title as plain text, never as markup', async () => {
    call.mockResolvedValue(answer(page([row(1, { title: '<img src=x onerror=alert(1)>' })])));
    const { container } = show();
    await screen.findByText('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
  });
});
