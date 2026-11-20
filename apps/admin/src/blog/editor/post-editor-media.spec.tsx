// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('../../categories/image-prepare.ts', () => ({ prepareImage: vi.fn() }));

import { callApi, type ApiFailure, type ApiResult } from '../../api/client.ts';
import { prepareImage } from '../../categories/image-prepare.ts';
import { PostEditor } from './post-editor.tsx';
import type { ApiContent, PostDetail, Taxonomy } from './types.ts';

const call = vi.mocked(callApi);
const prepare = vi.mocked(prepareImage);
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const POST = id(1);
const COVER = id(20);
const OTHER = id(21);

const content: ApiContent = {
  title: 'Spring pantry',
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
};
const post = (over: Partial<ApiContent> = {}): PostDetail => ({
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
    content: { ...content, ...over },
    editedByReviewer: false,
    updatedAt: '2026-10-27T03:20:00.000Z',
    decision: null,
    decisionNote: null,
  },
  live: null,
});
const taxonomy: Taxonomy = { categories: [], tags: [] };
const ok = <T,>(body: T): ApiResult<T> => ({ ok: true, status: 200, body });
const library = ok({
  items: [
    { id: COVER, width: 1600, height: 900, createdAt: '2026-11-07T10:00:00Z', uploadedBy: null },
    { id: OTHER, width: 800, height: 800, createdAt: '2026-11-06T10:00:00Z', uploadedBy: null },
  ],
  page: 1,
  pageSize: 40,
  hasMore: false,
});

function serve(detail: PostDetail) {
  call.mockImplementation((...args: unknown[]) => {
    const path = args[1];
    if (path === `blog/admin/posts/${POST}`) return Promise.resolve(ok(detail) as never);
    if (path === 'blog/admin/taxonomy') return Promise.resolve(ok(taxonomy) as never);
    if (path === 'blog/admin/media?page=1') return Promise.resolve(library as never);
    return Promise.reject(new Error(`unexpected ${String(path)}`));
  });
}
function show(props: { canUploadMedia?: boolean; canEdit?: boolean } = {}) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <PostEditor
        postId={POST}
        canEdit={props.canEdit ?? true}
        canReview={false}
        canUploadMedia={props.canUploadMedia ?? true}
        csrfToken="csrf-1"
        zone="Australia/Brisbane"
      />
    </NextIntlClientProvider>,
  );
}
const writes = () => call.mock.calls.filter(([method]) => method !== 'GET');
const refused = (details: ApiFailure['details']): ApiResult<never> => ({
  ok: false,
  failure: { status: 400, code: 'validation.failed', details },
});
const chooseInPicker = async (index: number) => {
  const buttons = await screen.findAllByRole('button', { name: /^Choose the image uploaded on/u });
  fireEvent.click(buttons[index]!);
};

describe('blog editor: cover and image blocks', () => {
  beforeEach(() => {
    call.mockReset();
    prepare.mockReset();
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  });
  afterEach(cleanup);

  it('chooses a cover from the library and asks for its alt text, then saves both', async () => {
    serve(post());
    show();
    await screen.findByLabelText('Title');
    expect(screen.getByText('No image chosen.')).toBeTruthy();
    // Without a cover the alt text is not asked for yet.
    expect(screen.queryByText('Describe the cover image.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Choose image, Cover image' }));
    await chooseInPicker(0);
    // The button now says Replace, on the same element, so focus is not lost.
    const replace = screen.getByRole('button', { name: 'Replace image, Cover image' });
    expect(replace).toBeTruthy();
    // Help, not an error, until the field is left or a save is tried.
    expect(screen.queryByText('Describe the cover image.')).toBeNull();
    expect(screen.getByText(/Say what the picture shows/u)).toBeTruthy();
    const alt = screen.getByLabelText(/Cover image description/u);
    expect(alt.hasAttribute('required')).toBe(true);
    fireEvent.blur(alt);
    expect(screen.getByText('Describe the cover image.')).toBeTruthy();
    fireEvent.change(alt, { target: { value: 'A shelf of jars' } });
    expect(screen.queryByText('Describe the cover image.')).toBeNull();
    call.mockResolvedValueOnce(ok(post({ coverImageId: COVER, coverAlt: 'A shelf of jars' })));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const sent = writes()[0]![2] as { content: ApiContent };
    expect(sent.content.coverImageId).toBe(COVER);
    expect(sent.content.coverAlt).toBe('A shelf of jars');
  });

  it('shows the cover alt error after a save attempt, not before', async () => {
    serve(post({ coverImageId: COVER, coverAlt: null }));
    show();
    await screen.findByLabelText('Title');
    expect(screen.queryByText('Describe the cover image.')).toBeNull();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New' } });
    call.mockResolvedValueOnce(ok(post({ coverImageId: COVER, coverAlt: null })));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('Describe the cover image.')).toBeTruthy();
  });

  it('shows only help, never an error, on an image block with empty alt text', async () => {
    serve(post({ body: [{ type: 'image', imageId: OTHER, alt: '', caption: null }] }));
    show();
    await screen.findByLabelText('Title');
    fireEvent.blur(screen.getByLabelText(/^Image description/u));
    expect(screen.getByText(/Needed before you send the post for review/u)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New' } });
    call.mockResolvedValueOnce(ok(post()));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  describe('focus after an upload', () => {
    const uploadFile = async () => {
      prepare.mockResolvedValue({ kind: 'ready', data: 'QUJD' });
      await screen.findAllByRole('button', { name: /^Choose the image uploaded on/u });
      call.mockResolvedValueOnce({
        ok: true,
        status: 201,
        body: {
          id: OTHER,
          width: 800,
          height: 800,
          createdAt: '2026-11-08T10:00:00Z',
          uploadedBy: null,
        },
      });
      const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
      fireEvent.change(input, {
        target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] },
      });
    };

    it('goes to the cover alt text when it is empty', async () => {
      serve(post());
      show();
      await screen.findByLabelText('Title');
      fireEvent.click(screen.getByRole('button', { name: 'Choose image, Cover image' }));
      await uploadFile();
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByLabelText(/Cover image description/u)),
      );
    });

    it('goes back to the Replace button when the alt text is already there', async () => {
      serve(post({ coverImageId: COVER, coverAlt: 'Jars' }));
      show();
      await screen.findByLabelText('Title');
      fireEvent.click(screen.getByRole('button', { name: 'Replace image, Cover image' }));
      await uploadFile();
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole('button', { name: 'Replace image, Cover image' }),
        ),
      );
    });

    it('goes to the alt text of an image block', async () => {
      serve(post());
      show();
      await screen.findByLabelText('Title');
      fireEvent.click(screen.getByRole('button', { name: 'Image' }));
      const block = screen.getByRole('listitem', { name: 'Block 2: Image' });
      fireEvent.click(within(block).getByRole('button', { name: /^Choose image/u }));
      await uploadFile();
      await waitFor(() =>
        expect(document.activeElement).toBe(within(block).getByLabelText(/^Image description/u)),
      );
    });
  });

  it('shows the thumbnail of a cover, replaces it, and removes it', async () => {
    serve(post({ coverImageId: COVER, coverAlt: 'Jars' }));
    const { container } = show();
    await screen.findByLabelText('Title');
    expect(container.querySelector(`img[src="/api/blog/admin/media/${COVER}/thumb"]`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Replace image, Cover image' }));
    await chooseInPicker(1);
    expect(container.querySelector(`img[src="/api/blog/admin/media/${OTHER}/thumb"]`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove image, Cover image' }));
    expect(screen.getByText('No image chosen.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove image, Cover image' })).toBeNull();
    // Focus stays in the slot.
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Choose image, Cover image' }),
    );
    call.mockResolvedValueOnce(ok(post()));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const sent = writes()[0]![2] as { content: ApiContent };
    expect(sent.content.coverImageId).toBeNull();
  });

  it('shows the reason on the cover when the save names an image the library does not know', async () => {
    serve(post({ coverImageId: COVER, coverAlt: 'Jars' }));
    show();
    await screen.findByLabelText('Title');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New title' } });
    call.mockResolvedValueOnce(
      refused({ fields: [{ path: 'content.coverImageId', code: 'not-found' }] }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(
      await screen.findByText('This image is no longer in the media library. Choose another one.'),
    ).toBeTruthy();
  });

  it('adds an image block, chooses its picture, and saves it with alt text and caption', async () => {
    serve(post());
    show();
    await screen.findByLabelText('Title');
    fireEvent.click(screen.getByRole('button', { name: 'Image' }));
    const block = screen.getByRole('listitem', { name: 'Block 2: Image' });
    fireEvent.click(within(block).getByRole('button', { name: /^Choose image/u }));
    await chooseInPicker(0);
    fireEvent.change(within(block).getByLabelText(/^Image description/u), {
      target: { value: 'Jars on a shelf' },
    });
    fireEvent.change(within(block).getByLabelText(/^Caption/u), { target: { value: 'Our shelf' } });
    call.mockResolvedValueOnce(ok(post()));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const sent = writes()[0]![2] as { content: ApiContent };
    expect(sent.content.body[1]).toEqual({
      type: 'image',
      imageId: COVER,
      alt: 'Jars on a shelf',
      caption: 'Our shelf',
    });
  });

  it('leaves an image block with no picture out of the saved body', async () => {
    serve(post());
    show();
    await screen.findByLabelText('Title');
    fireEvent.click(screen.getByRole('button', { name: 'Image' }));
    // The cover slot and the new block both show an empty slot.
    expect(screen.getAllByText('No image chosen.')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Other' } });
    call.mockResolvedValueOnce(ok(post()));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect((writes()[0]![2] as { content: ApiContent }).content.body).toHaveLength(1);
  });

  it('marks the image block the API refused, counting only the blocks that were saved', async () => {
    serve(
      post({
        body: [
          { type: 'paragraph', text: 'One.' },
          { type: 'image', imageId: OTHER, alt: 'Jars', caption: null },
        ],
      }),
    );
    show();
    await screen.findByLabelText('Title');
    // An empty paragraph before the image is not saved, so the API counts the image as block 1.
    fireEvent.click(screen.getByRole('button', { name: 'Paragraph' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Other' } });
    call.mockResolvedValueOnce(
      refused({ fields: [{ path: 'content.body[1].imageId', code: 'not-found' }] }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    const block = await screen.findByRole('listitem', { name: 'Block 2: Image' });
    expect(
      within(block).getByText('This image is no longer in the media library. Choose another one.'),
    ).toBeTruthy();
    expect(
      within(screen.getByRole('listitem', { name: 'Block 1: Paragraph' })).queryByText(
        /no longer in the media library/u,
      ),
    ).toBeNull();
  });

  it('hides Upload from a session without blog.media.edit but still lets it choose', async () => {
    serve(post());
    show({ canUploadMedia: false });
    await screen.findByLabelText('Title');
    fireEvent.click(screen.getByRole('button', { name: 'Choose image, Cover image' }));
    await chooseInPicker(0);
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Replace image, Cover image' })).toBeTruthy();
  });

  it('offers Upload in the picker to a session with blog.media.edit', async () => {
    serve(post());
    show();
    await screen.findByLabelText('Title');
    fireEvent.click(screen.getByRole('button', { name: 'Choose image, Cover image' }));
    await screen.findAllByRole('button', { name: /^Choose the image uploaded on/u });
    expect(screen.getByLabelText('Upload a new image')).toBeTruthy();
  });

  it('disables the picture controls when the post cannot be edited', async () => {
    serve(post({ coverImageId: COVER, coverAlt: 'Jars' }));
    show({ canEdit: false });
    await screen.findByLabelText('Title');
    expect(
      screen.getByRole('button', { name: 'Replace image, Cover image' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(
      screen.getByRole('button', { name: 'Remove image, Cover image' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(screen.getByRole('button', { name: 'Image' }).hasAttribute('disabled')).toBe(true);
  });
});
