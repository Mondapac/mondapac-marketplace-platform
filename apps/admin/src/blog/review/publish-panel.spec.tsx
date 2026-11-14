// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import type { ApiResult } from '../../api/client.ts';
import type { PostDetail } from '../editor/types.ts';
import { PublishPanel } from './publish-panel.tsx';

const call = vi.hoisted(() => vi.fn());
vi.mock('../../step-up/step-up.tsx', () => ({
  useGuardedCall: () => call,
  isStepUpCancelled: () => false,
}));

const POST = '0190a000-0000-7000-8000-000000000001';
const content = {
  title: 'Spring pantry',
  excerpt: '',
  body: [],
  coverImageId: null,
  coverAlt: null,
  seoTitle: null,
  seoDescription: null,
  authorDisplay: null,
  categoryId: null,
  tagIds: [],
  links: [],
  event: null,
};
const version = (state: string) => ({
  id: '0190a000-0000-7000-8000-000000000101',
  versionNo: 3,
  state,
  content,
  editedByReviewer: false,
  updatedAt: '2026-10-27T03:20:00.000Z',
  decision: null,
  decisionNote: null,
});
const post = (over: Partial<PostDetail> = {}): PostDetail => ({
  id: POST,
  kind: 'product',
  slug: 'spring-pantry',
  ownerType: 'platform',
  sellerId: null,
  status: 'approved',
  open: version('approved'),
  live: null,
  ...over,
});
const ok = (): ApiResult<PostDetail> => ({ ok: true, status: 200, body: post() });
const changed = vi.fn();

function show(detail: PostDetail, flags: { canPublish?: boolean; canPause?: boolean } = {}) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <PublishPanel
        post={detail}
        zone="Australia/Sydney"
        canPublish={flags.canPublish ?? true}
        canPause={flags.canPause ?? true}
        csrfToken="csrf-1"
        locale="en-AU"
        onChanged={changed}
      />
    </NextIntlClientProvider>,
  );
}

describe('admin blog publish panel', () => {
  beforeEach(() => {
    call.mockReset();
    changed.mockReset();
    call.mockImplementation(() => Promise.resolve(ok()));
  });
  afterEach(cleanup);

  it('publishes the approved version now and tells the page', async () => {
    show(post());
    fireEvent.click(screen.getByRole('button', { name: 'Publish now' }));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith(
      'POST',
      `blog/admin/posts/${POST}/publish`,
      { versionNo: 3 },
      'csrf-1',
    );
  });

  it('schedules on the Market clock: a Sydney wall time becomes the right UTC instant', async () => {
    show(post());
    const schedule = screen.getByRole<HTMLButtonElement>('button', { name: 'Schedule' });
    expect(schedule.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Publish at'), {
      target: { value: '2026-12-01T08:00' },
    });
    fireEvent.click(schedule);
    await waitFor(() => expect(call).toHaveBeenCalled());
    // 08:00 AEDT (UTC+11) is 21:00 UTC the day before
    expect(call).toHaveBeenCalledWith(
      'PUT',
      `blog/admin/posts/${POST}/schedule`,
      { versionNo: 3, scheduledAt: '2026-11-30T21:00:00.000Z' },
      'csrf-1',
    );
  });

  it('removes a schedule', async () => {
    show(post({ status: 'scheduled', scheduledAt: '2026-11-30T21:00:00.000Z' }));
    expect(screen.getByText(/Goes live at/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove schedule' }));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith(
      'DELETE',
      `blog/admin/posts/${POST}/schedule`,
      undefined,
      'csrf-1',
    );
  });

  it('needs a reason to take a live post off the site', async () => {
    show(post({ status: 'published', open: null }));
    const pause = screen.getByRole<HTMLButtonElement>('button', { name: 'Take off the site' });
    expect(pause.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason for taking it off the site'), {
      target: { value: ' Wrong price ' },
    });
    fireEvent.click(pause);
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith(
      'POST',
      `blog/admin/posts/${POST}/pause`,
      { reason: 'Wrong price' },
      'csrf-1',
    );
  });

  it('offers nothing without the permission and shows the server refusal as it is', async () => {
    show(post(), { canPublish: false, canPause: false });
    expect(screen.queryByRole('button', { name: 'Publish now' })).toBeNull();
    cleanup();
    call.mockImplementation(() =>
      Promise.resolve({ ok: false, failure: { status: 403, code: 'blog.access-off' } }),
    );
    show(post());
    fireEvent.click(screen.getByRole('button', { name: 'Publish now' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/access of this seller is off/u);
    expect(changed).not.toHaveBeenCalled();
  });

  it('shows no panel for a draft', () => {
    show(post({ status: 'draft', open: version('draft') }));
    expect(screen.queryByText('Publish')).toBeNull();
  });

  it('asks twice before archiving, and Cancel backs out', async () => {
    show(post({ status: 'published', open: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByText(/Archive this post\?/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/Archive this post\?/u)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Archive' })[0]!);
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith(
      'POST',
      `blog/admin/posts/${POST}/archive`,
      undefined,
      'csrf-1',
    );
  });

  it('offers to publish a newly approved edit of a live post, and keeps the live controls', () => {
    show(post({ status: 'published', open: version('approved'), live: version('published') }));
    expect(screen.getByRole('button', { name: 'Publish now' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Take off the site' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy();
  });

  it('puts a taken-off post back, and features and renames a live one', async () => {
    show(post({ status: 'unpublished', open: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Put back on the site' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenLastCalledWith(
      'POST',
      `blog/admin/posts/${POST}/resume`,
      undefined,
      'csrf-1',
    );
    cleanup();
    show(post({ status: 'published', open: null, featured: false }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Feature on the blog home/u }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call).toHaveBeenLastCalledWith(
      'PUT',
      `blog/admin/posts/${POST}/featured`,
      { featured: true },
      'csrf-1',
    );
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: ' new-address ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change address' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(3));
    expect(call).toHaveBeenLastCalledWith(
      'PUT',
      `blog/admin/posts/${POST}/slug`,
      { slug: 'new-address' },
      'csrf-1',
    );
  });

  it('hides take-off without blog.post.pause, and archive for a seller post', () => {
    show(post({ status: 'published', open: null, ownerType: 'seller' }), { canPause: false });
    expect(screen.queryByRole('button', { name: 'Take off the site' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Change address' })).toBeTruthy();
  });

  it('says that an address is taken, and leaves the page as it is', async () => {
    call.mockImplementation(() =>
      Promise.resolve({ ok: false, failure: { status: 409, code: 'blog.slug-taken' } }),
    );
    show(post({ status: 'published', open: null }));
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'taken' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change address' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/already used by another post/u);
    expect(changed).not.toHaveBeenCalled();
  });
});
