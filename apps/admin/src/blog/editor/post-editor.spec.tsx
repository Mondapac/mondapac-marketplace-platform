// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi, type ApiFailure, type ApiResult } from '../../api/client.ts';
import { editorProblemOf } from './editor-errors.ts';
import { PostEditor } from './post-editor.tsx';
import type { ApiContent, PostDetail, Taxonomy } from './types.ts';

const call = vi.mocked(callApi);
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const POST = id(1);

const content: ApiContent = {
  title: 'Spring pantry',
  excerpt: 'Six blends.',
  body: [
    { type: 'paragraph', text: 'Spring is here.' },
    { type: 'image', imageId: id(9), alt: 'Jars', caption: null },
  ],
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
const post = (over: Partial<PostDetail> = {}): PostDetail => ({
  id: POST,
  kind: 'product',
  slug: 'spring-pantry',
  ownerType: 'platform',
  sellerId: null,
  status: 'draft',
  open: {
    id: id(2),
    versionNo: 1,
    state: 'draft',
    content,
    editedByReviewer: false,
    updatedAt: '2026-10-27T03:20:00.000Z',
    decision: null,
    decisionNote: null,
  },
  live: null,
  ...over,
});
const taxonomy: Taxonomy = {
  categories: [{ id: id(5), slug: 'pantry', names: { en: 'Pantry' } }],
  tags: [{ id: id(6), slug: 'spices', name: 'Spices' }],
};
const ok = <T,>(body: T): ApiResult<T> => ({ ok: true, status: 200, body });
const failed = (
  status: number,
  code: string,
  details?: ApiFailure['details'],
): ApiResult<never> => ({
  ok: false,
  failure: { status, code, ...(details === undefined ? {} : { details }) },
});

function serve(detail: PostDetail = post()) {
  call.mockImplementation((...args: unknown[]) => {
    const path = args[1];
    if (path === `blog/admin/posts/${POST}`) return Promise.resolve(ok(detail) as never);
    if (path === 'blog/admin/taxonomy') return Promise.resolve(ok(taxonomy) as never);
    return Promise.reject(new Error(`unexpected ${String(path)}`));
  });
}
function show(props: { canEdit?: boolean; canReview?: boolean } = {}) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <PostEditor
        postId={POST}
        canEdit={props.canEdit ?? true}
        canReview={props.canReview ?? false}
        csrfToken="csrf-1"
      />
    </NextIntlClientProvider>,
  );
}
const writes = () => call.mock.calls.filter(([method]) => method !== 'GET');

describe('admin blog post editor', () => {
  beforeEach(() => {
    call.mockReset();
  });
  afterEach(cleanup);

  it('loads the working version and the taxonomy and shows them', async () => {
    serve();
    show();
    expect(await screen.findByDisplayValue('Spring pantry')).toBeTruthy();
    expect(screen.getByDisplayValue('spring-pantry')).toBeTruthy();
    expect(screen.getByText('All changes saved')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Pantry' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Spices' })).toBeTruthy();
    // The image block is kept, not edited.
    expect(screen.getByText(/Images are kept as they are/u)).toBeTruthy();
  });

  it('saves the whole content and the address with PUT, and keeps the image block', async () => {
    serve();
    show();
    const title = await screen.findByLabelText('Title');
    fireEvent.change(title, { target: { value: 'Spring pantry 2' } });
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    call.mockResolvedValueOnce(ok(post()));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const [method, path, body, csrf] = writes()[0]!;
    expect(method).toBe('PUT');
    expect(path).toBe(`blog/admin/posts/${POST}/draft`);
    expect(csrf).toBe('csrf-1');
    const sent = body as { content: ApiContent; slug: string };
    expect(sent.slug).toBe('spring-pantry');
    expect(sent.content.title).toBe('Spring pantry 2');
    expect(sent.content.body[1]).toEqual(content.body[1]);
    expect(sent.content.coverImageId).toBeNull();
  });

  it('adds, edits, moves and removes text blocks', async () => {
    serve();
    show();
    await screen.findByLabelText('Title');
    fireEvent.click(screen.getByRole('button', { name: 'Heading' }));
    const heading = screen.getAllByLabelText('Text').at(-1)!;
    fireEvent.change(heading, { target: { value: 'Baharat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move block 3 up' }));
    const items = screen.getAllByRole('listitem').filter((li) => li.getAttribute('aria-label'));
    expect(items.map((li) => li.getAttribute('aria-label'))).toEqual([
      'Block 1: Paragraph',
      'Block 2: Heading',
      'Block 3: Kept block',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove block 2' }));
    expect(screen.queryByDisplayValue('Baharat')).toBeNull();
  });

  it('sends for review: saves first when there are changes, then submits', async () => {
    serve();
    show();
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'New title' } });
    call.mockResolvedValueOnce(ok(post())).mockResolvedValueOnce(ok(post({ status: 'in_review' })));
    fireEvent.click(screen.getByRole('button', { name: 'Send for review' }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes().map(([m, p]) => `${m} ${p}`)).toEqual([
      `PUT blog/admin/posts/${POST}/draft`,
      `POST blog/admin/posts/${POST}/submit`,
    ]);
  });

  it('shows the findings of a refused submit', async () => {
    serve();
    show();
    await screen.findByLabelText('Title');
    call.mockResolvedValueOnce(
      failed(422, 'blog.checks-failed', {
        findings: [
          { severity: 'error', code: 'cover-missing', path: 'coverImageId' },
          { severity: 'warning', code: 'price-in-text', path: 'body[0].text' },
        ],
      } as never),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Send for review' }));
    expect(await screen.findByText('Add a cover image. (coverImageId)')).toBeTruthy();
    expect(screen.getByText(/A price is typed into the text/u)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/checks found problems/u);
  });

  it('marks the refused field and says a taken address is taken', async () => {
    serve();
    show();
    fireEvent.change(await screen.findByLabelText('Address'), { target: { value: 'taken-one' } });
    call.mockResolvedValueOnce(
      failed(400, 'validation.failed', { fields: [{ path: 'slug', code: 'taken' }] }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByLabelText('Address').getAttribute('aria-invalid')).toBe('true');
  });

  it('reloads the post after a conflict and saves nothing more', async () => {
    serve();
    show();
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'Mine' } });
    call.mockResolvedValueOnce(failed(409, 'conflict.stale'));
    serve();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText(/Someone else changed this post/u)).toBeTruthy();
    expect(writes()).toHaveLength(1);
  });

  it('maps a too-large refusal to its own message', () => {
    expect(editorProblemOf({ status: 413, code: 'request.too-large' }).key).toBe(
      'blog.editor.error.too-large',
    );
  });

  it('is read-only for a role without blog.post.edit, and for a post in review', async () => {
    serve();
    show({ canEdit: false });
    expect(await screen.findByText(/can read this post but not change it/u)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Title').disabled).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Send for review' }).disabled,
    ).toBe(true);
    cleanup();
    serve(post({ status: 'in_review' }));
    show();
    expect(await screen.findByText(/in review and cannot be changed/u)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Title').disabled).toBe(true);
  });

  it('runs the checks for a reviewer and lists the findings', async () => {
    serve();
    show({ canReview: true });
    await screen.findByLabelText('Title');
    call.mockResolvedValueOnce(
      ok({
        versionNo: 1,
        findings: [{ severity: 'error', code: 'category-missing', path: 'categoryId' }],
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Run checks' }));
    expect(await screen.findByText('Choose a category. (categoryId)')).toBeTruthy();
    expect(call).toHaveBeenLastCalledWith('GET', `blog/admin/posts/${POST}/checks`);
  });

  it('hides Run checks from a role that cannot review', async () => {
    serve();
    show({ canReview: false });
    await screen.findByLabelText('Title');
    expect(screen.queryByRole('button', { name: 'Run checks' })).toBeNull();
  });

  it('edits the live version when no new draft is open, and says a reviewer edited a draft', async () => {
    serve(post({ status: 'published', open: null, live: post().open }));
    show();
    expect(await screen.findByDisplayValue('Spring pantry')).toBeTruthy();
    cleanup();
    const detail = post();
    serve({ ...detail, open: { ...detail.open!, editedByReviewer: true } });
    show();
    expect(await screen.findByText(/A reviewer edited this version/u)).toBeTruthy();
  });

  it('shows a load error with a retry, and sends a rejected session to sign-in', async () => {
    call.mockResolvedValue(failed(500, 'x'));
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(4));
    cleanup();
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    call.mockReset();
    call.mockResolvedValue(failed(401, 'x'));
    show();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    vi.unstubAllGlobals();
  });

  it('renders text as plain text, never as markup', async () => {
    serve(
      post({
        open: { ...post().open!, content: { ...content, title: '<img src=x onerror=alert(1)>' } },
      }),
    );
    const { container } = show();
    await screen.findByDisplayValue('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
  });
});
