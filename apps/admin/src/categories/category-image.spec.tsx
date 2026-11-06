// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('./image-prepare.ts', () => ({ prepareImage: vi.fn() }));

import { callApi, type ApiResult } from '../api/client.ts';
import { CategoryImageSection } from './category-image.tsx';
import { prepareImage } from './image-prepare.ts';
import type { DetailBody } from './types.ts';

// The category image section (categories package C3c): the preview through the relay, the exact
// copy, Upload / Replace / Remove with the category version the page read, the two refusals the
// browser makes itself, the API refusals in words, and a reader who sees the buttons off.

const call = vi.mocked(callApi);
const prepare = vi.mocked(prepareImage);
const CATEGORY = '0190a000-0000-7000-8000-000000000002';
const IMAGE = '0190a000-0000-7000-8000-0000000000aa';

const body = (over: { imageId?: string | null; status?: 'active' | 'hidden' | 'archived' } = {}) =>
  ({
    category: {
      id: CATEGORY,
      parentId: null,
      slug: 'dates',
      status: over.status ?? 'active',
      mergedIntoId: null,
      names: [{ locale: 'en', name: 'Dates' }],
      depth: 0,
      position: 0,
      version: 5,
      counts: { liveProducts: 0, liveProductsDirect: 0, offers: 0 },
    },
    path: [],
    requiredLocales: ['en'],
    missingLocales: [],
    revisions: [],
    complete: true,
    actions: {},
    details: {
      texts: [],
      seo: { title: null, description: null, noindex: false },
      showInMenu: true,
      imageId: over.imageId ?? null,
      hiddenById: null,
    },
    treeVersion: 7,
  }) as DetailBody;

const okAnswer = (imageId: string | null): ApiResult<unknown> => ({
  ok: true,
  status: 200,
  body: {
    category: {
      id: CATEGORY,
      slug: 'dates',
      status: 'active',
      version: 6,
      revisionNo: 2,
      treeVersion: 7,
    },
    image: imageId === null ? null : { imageId, width: 1200, height: 800 },
  },
});
const refusal = (status: number, code: string): ApiResult<unknown> =>
  ({ ok: false, failure: { status, code } }) as unknown as ApiResult<unknown>;

function show(detail: DetailBody, canEdit = true) {
  const onChanged = vi.fn();
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <CategoryImageSection
        body={detail}
        canEdit={canEdit}
        csrfToken="csrf"
        onChanged={onChanged}
      />
    </NextIntlClientProvider>,
  );
  return onChanged;
}

const pickFile = () => {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File(['x'], 'dates.png', { type: 'image/png' });
  fireEvent.change(input, { target: { files: [file] } });
  return input;
};

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

describe('category image (C3c)', () => {
  it('says there is no image yet, that it is optional, and offers Upload image', () => {
    show(body());
    expect(screen.getByRole('heading', { name: 'Image' })).toBeTruthy();
    expect(screen.getByText('No image yet.')).toBeTruthy();
    expect(
      screen.getByText(
        'Optional. JPEG, PNG or WebP. Shown on the category card and page. A category can be shown without an image.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Upload image')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove image' })).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('shows the current image through the relay, medium size, with Replace and Remove', () => {
    show(body({ imageId: IMAGE }));
    const img = screen.getByRole('img', { name: 'Image of the category dates' });
    expect(img.getAttribute('src')).toBe(
      `/api/catalog/admin/categories/${CATEGORY}/images/${IMAGE}/medium`,
    );
    expect(screen.getByText('Replace image')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove image' })).toBeTruthy();
  });

  it('uploads the shrunk picture with the category version and says Image added.', async () => {
    prepare.mockResolvedValue({ kind: 'ready', data: 'QUJD' });
    call.mockResolvedValue(okAnswer(IMAGE));
    const onChanged = show(body());
    const input = pickFile();
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('Image added.'));
    expect(call).toHaveBeenCalledWith(
      'PUT',
      `catalog/admin/categories/${CATEGORY}/image`,
      { version: 5, data: 'QUJD' },
      'csrf',
    );
    // The picker is cleared, so the same file can be picked again.
    expect(input.value).toBe('');
  });

  it('says Image replaced. when there was one', async () => {
    prepare.mockResolvedValue({ kind: 'ready', data: 'QUJD' });
    call.mockResolvedValue(okAnswer(IMAGE));
    const onChanged = show(body({ imageId: IMAGE }));
    pickFile();
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('Image replaced.'));
  });

  it('refuses a file the browser cannot read or that is too large, and sends nothing', async () => {
    prepare.mockResolvedValueOnce({ kind: 'refused', reason: 'unreadable' });
    show(body());
    pickFile();
    expect(
      await screen.findByText(
        'This file could not be read as a picture. Choose a JPEG, PNG or WebP file.',
      ),
    ).toBeTruthy();
    prepare.mockResolvedValueOnce({ kind: 'refused', reason: 'too-large' });
    pickFile();
    expect(
      await screen.findByText('This file is larger than 25 MB. Choose a smaller picture.'),
    ).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    [413, 'file.too-large', 'The picture is too large. Choose one under 4 MB.'],
    [
      415,
      'file.unsupported-type',
      'This file type is not supported. Choose a JPEG, PNG or WebP picture.',
    ],
    [
      422,
      'file.too-small',
      'The picture is too small. Choose one at least 200 pixels on its longest side.',
    ],
    [422, 'file.too-many-pixels', 'The picture has too many pixels. Choose a smaller one.'],
    [422, 'file.unreadable', 'The picture could not be read. Choose another file.'],
  ])('shows the API refusal %s %s in words', async (status, code, text) => {
    prepare.mockResolvedValue({ kind: 'ready', data: 'QUJD' });
    call.mockResolvedValue(refusal(status, code));
    const onChanged = show(body());
    pickFile();
    expect(await screen.findByText(text)).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('names a stale upload with the category text and offers Read again', async () => {
    prepare.mockResolvedValue({ kind: 'ready', data: 'QUJD' });
    call.mockResolvedValue(refusal(409, 'conflict.stale'));
    const onChanged = show(body());
    pickFile();
    expect(await screen.findByText('Someone changed this category. Reload.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Read again' }));
    expect(onChanged).toHaveBeenCalledWith();
  });

  it('removes the image after a confirmation, with the category version', async () => {
    call.mockResolvedValue(okAnswer(null));
    const onChanged = show(body({ imageId: IMAGE }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove image' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove the image?' });
    expect(
      within(dialog).getByText('The category will show no image until you upload a new one.'),
    ).toBeTruthy();
    // Focus starts on Cancel: a removal is not the default.
    expect(document.activeElement?.textContent).toBe('Cancel');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove image' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('Image removed.'));
    expect(call).toHaveBeenCalledWith(
      'POST',
      `catalog/admin/categories/${CATEGORY}/image/remove`,
      { version: 5 },
      'csrf',
    );
  });

  it('names a stale removal with the category text', async () => {
    call.mockResolvedValue(refusal(409, 'conflict.stale'));
    show(body({ imageId: IMAGE }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove image' }));
    const dialog = await screen.findByRole('dialog', { name: 'Remove the image?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove image' }));
    expect(await within(dialog).findByText('Someone changed this category. Reload.')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Read again' })).toBeTruthy();
  });

  it('shows a reader the buttons off, and an archived category too', () => {
    show(body({ imageId: IMAGE }), false);
    expect(document.querySelector<HTMLInputElement>('input[type="file"]')!.disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Remove image' }).disabled).toBe(
      true,
    );
    cleanup();
    show(body({ imageId: IMAGE, status: 'archived' }), true);
    expect(document.querySelector<HTMLInputElement>('input[type="file"]')!.disabled).toBe(true);
  });
});
