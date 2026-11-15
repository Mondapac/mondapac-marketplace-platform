// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import type { ApiFailure, ApiResult } from '../../api/client.ts';
import type { ApiContent, ChecksBody, PostDetail } from '../editor/types.ts';
import { ReviewView } from './review-view.tsx';

const call = vi.hoisted(() => vi.fn());
vi.mock('../../api/client.ts', () => ({ callApi: call }));
vi.mock('../../step-up/step-up.tsx', () => ({
  useGuardedCall: () => call,
  isStepUpCancelled: () => false,
}));

const POST = '0190a000-0000-7000-8000-000000000001';
const content = (title: string): ApiContent => ({
  title,
  excerpt: 'Six blends.',
  body: [{ type: 'paragraph', text: 'Spring is here.' }],
  coverImageId: null,
  coverAlt: null,
  seoTitle: null,
  seoDescription: null,
  authorDisplay: null,
  categoryId: null,
  tagIds: [],
  links: [],
  event: null,
});
const version = (no: number, state: string, title: string) => ({
  id: `0190a000-0000-7000-8000-00000000010${no}`,
  versionNo: no,
  state,
  content: content(title),
  editedByReviewer: false,
  updatedAt: '2026-10-27T03:20:00.000Z',
  decision: null,
  decisionNote: null,
});
const post = (over: Partial<PostDetail> = {}): PostDetail => ({
  id: POST,
  kind: 'product',
  slug: 'spring-pantry',
  ownerType: 'seller',
  sellerId: '0190a000-0000-7000-8000-000000000009',
  status: 'in_review',
  open: version(3, 'in_review', 'Spring pantry 2'),
  live: version(2, 'published', 'Spring pantry'),
  ...over,
});
const ok = <T,>(body: T): ApiResult<T> => ({ ok: true, status: 200, body });
const failed = (
  status: number,
  code: string,
  details?: ApiFailure['details'],
): ApiResult<never> => ({
  ok: false,
  failure: { status, code, ...(details === undefined ? {} : { details }) },
});
const checks: ChecksBody = {
  versionNo: 3,
  findings: [{ severity: 'warning', code: 'x-unknown', path: null }],
};

function serve(detail: PostDetail = post()) {
  call.mockImplementation((...args: unknown[]) => {
    const [method, path] = args;
    if (method === 'GET' && path === `blog/admin/posts/${POST}`) return Promise.resolve(ok(detail));
    if (method === 'GET' && path === `blog/admin/posts/${POST}/checks`)
      return Promise.resolve(ok(checks));
    return Promise.resolve(ok(detail));
  });
}
function show(canReview = true) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <ReviewView postId={POST} canReview={canReview} csrfToken="csrf-1" />
    </NextIntlClientProvider>,
  );
}
const writes = () => call.mock.calls.filter(([method]) => method !== 'GET');

describe('admin blog review', () => {
  beforeEach(() => {
    call.mockReset();
  });
  afterEach(cleanup);

  it('shows the changed title with both texts and the checks', async () => {
    serve();
    show();
    expect(await screen.findByText('Spring pantry 2', { selector: 'p' })).toBeTruthy();
    expect(screen.getByText('Spring pantry', { selector: 'p' })).toBeTruthy();
    expect(screen.getByText(/x-unknown/u)).toBeTruthy();
  });

  it('approves the version in review with its number', async () => {
    serve();
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual([
      'POST',
      `blog/admin/posts/${POST}/approve`,
      { versionNo: 3 },
      'csrf-1',
    ]);
  });

  it('needs a note to send back, and sends it with the version number', async () => {
    serve();
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Request changes' }));
    const send = screen.getByRole<HTMLButtonElement>('button', { name: 'Send back' });
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Note to the author'), {
      target: { value: ' Fix it ' },
    });
    fireEvent.click(send);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toEqual([
      'POST',
      `blog/admin/posts/${POST}/request-changes`,
      { versionNo: 3, note: 'Fix it' },
      'csrf-1',
    ]);
  });

  it('says why a self-approval is refused and keeps the post as it is', async () => {
    serve();
    show();
    await screen.findByRole('button', { name: 'Approve' });
    call.mockImplementation((...args: unknown[]) =>
      args[0] === 'POST'
        ? Promise.resolve(failed(403, 'blog.self-approval-refused'))
        : Promise.resolve(ok(post())),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/cannot approve it/u);
  });

  it('shows refused checks from an approval as findings', async () => {
    serve();
    show();
    await screen.findByRole('button', { name: 'Approve' });
    call.mockImplementation((...args: unknown[]) =>
      args[0] === 'POST'
        ? Promise.resolve(
            failed(422, 'blog.checks-failed', {
              findings: [{ severity: 'error', code: 'cover-missing', path: null }],
            } as never),
          )
        : Promise.resolve(ok(post())),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Add a cover image.')).toBeTruthy();
  });

  it('disables the decisions for a role without blog.post.review and for a post not in review', async () => {
    serve();
    show(false);
    expect(
      (await screen.findByRole<HTMLButtonElement>('button', { name: 'Approve' })).disabled,
    ).toBe(true);
    expect(screen.getByText(/can read this post but not decide/u)).toBeTruthy();
    cleanup();
    serve(post({ status: 'draft', open: version(3, 'draft', 'Spring pantry 2') }));
    show();
    expect(
      (await screen.findByRole<HTMLButtonElement>('button', { name: 'Approve' })).disabled,
    ).toBe(true);
    expect(screen.getByText(/not waiting for review/u)).toBeTruthy();
  });

  it('moves focus to the note field when the form opens', async () => {
    serve();
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Request changes' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText('Note to the author')),
    );
  });

  it('shows the live title and no "in review" line when no version is open', async () => {
    serve(post({ status: 'archived', open: null }));
    show();
    expect(await screen.findByRole('heading', { name: 'Spring pantry' })).toBeTruthy();
    expect(screen.queryByText(/in review/u, { selector: 'p' })).toBeNull();
    expect(screen.getByText(/not waiting for review/u)).toBeTruthy();
  });
});
