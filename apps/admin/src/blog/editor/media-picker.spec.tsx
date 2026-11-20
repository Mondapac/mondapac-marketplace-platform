// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('../../categories/image-prepare.ts', () => ({ prepareImage: vi.fn() }));

import { callApi, type ApiResult } from '../../api/client.ts';
import { prepareImage } from '../../categories/image-prepare.ts';
import { MAX_BASE64_CHARS, MediaPickerDialog } from './media-picker.tsx';
import type { MediaItem, MediaPage } from './types.ts';

const call = vi.mocked(callApi);
const prepare = vi.mocked(prepareImage);
const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const item = (n: number): MediaItem => ({
  id: id(n),
  width: 1600,
  height: 900,
  createdAt: '2026-11-07T10:00:00Z',
  uploadedBy: null,
});
const page = (items: MediaItem[], n = 1, hasMore = false): ApiResult<MediaPage> => ({
  ok: true,
  status: 200,
  body: { items, page: n, pageSize: 40, hasMore },
});
const failed = (status: number, code: string): ApiResult<never> => ({
  ok: false,
  failure: { status, code },
});

let onPick: ReturnType<typeof vi.fn<(id: string) => void>>;
let onClose: ReturnType<typeof vi.fn<() => void>>;

function mount(props: { canUpload?: boolean; currentId?: string } = {}) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <MediaPickerDialog
        open
        onClose={onClose}
        onPick={onPick}
        currentId={props.currentId ?? ''}
        canUpload={props.canUpload ?? true}
        csrfToken="csrf-1"
      />
    </NextIntlClientProvider>,
  );
}
const upload = (file: File) => {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [file] } });
};
const png = () => new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' });

beforeEach(() => {
  call.mockReset();
  prepare.mockReset();
  onPick = vi.fn();
  onClose = vi.fn();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(() => cleanup());

describe('blog media picker', () => {
  it('shows a loading state, then a grid of thumbnails named by date and size', async () => {
    call.mockResolvedValueOnce(page([item(1), item(2)]));
    mount();
    expect(screen.getByText('Loading the media library')).toBeTruthy();
    const buttons = await screen.findAllByRole('button', {
      name: /^Choose the image uploaded on/u,
    });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.getAttribute('aria-label')).toContain('1600 by 900 pixels');
    expect(call).toHaveBeenCalledWith('GET', 'blog/admin/media?page=1');
    const thumb = buttons[0]!.querySelector('img')!;
    expect(thumb.getAttribute('src')).toBe(`/api/blog/admin/media/${id(1)}/thumb`);
    // The thumbnail is decoration: the button carries the name.
    expect(thumb.getAttribute('alt')).toBe('');
  });

  it('marks the picture already chosen by name and by a visible badge, not by colour alone', async () => {
    call.mockResolvedValueOnce(page([item(1), item(2)]));
    mount({ currentId: id(2) });
    const buttons = await screen.findAllByRole('button', { name: /^Choose the image/u });
    expect(buttons.map((b) => b.getAttribute('aria-current'))).toEqual([null, 'true']);
    expect(buttons[0]!.getAttribute('aria-label')).not.toContain('(current image)');
    expect(buttons[1]!.getAttribute('aria-label')).toMatch(/\(current image\)$/u);
    expect(buttons[0]!.querySelector('svg')).toBeNull();
    expect(buttons[1]!.querySelector('svg')).toBeTruthy();
    expect(buttons.map((b) => b.hasAttribute('aria-pressed'))).toEqual([false, false]);
  });

  it('names a tile with date and time, and shows its size as 1600×900', async () => {
    call.mockResolvedValueOnce(page([item(1)]));
    mount();
    const tile = await screen.findByRole('button', { name: /^Choose the image/u });
    expect(tile.getAttribute('aria-label')).toMatch(/\d{1,2}:\d{2}/u);
    expect(tile.textContent).toContain('1600×900');
  });

  it('shows skeleton tiles while loading', () => {
    call.mockReturnValueOnce(new Promise(() => undefined));
    mount();
    expect(document.querySelectorAll('ul[aria-hidden="true"] > li')).toHaveLength(6);
  });

  it('picks a picture and closes', async () => {
    call.mockResolvedValueOnce(page([item(1), item(2)]));
    mount();
    const buttons = await screen.findAllByRole('button', { name: /^Choose the image/u });
    fireEvent.click(buttons[1]!);
    expect(onPick).toHaveBeenCalledWith(id(2), false);
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the empty state, with the upload hint only for a role that can upload', async () => {
    call.mockResolvedValueOnce(page([]));
    mount();
    expect(
      await screen.findByText('The library has no images yet. Upload the first one.'),
    ).toBeTruthy();
    cleanup();
    call.mockResolvedValueOnce(page([]));
    mount({ canUpload: false });
    expect(await screen.findByText('The library has no images yet.')).toBeTruthy();
  });

  it('shows a load error and reads again on retry', async () => {
    call.mockResolvedValueOnce(failed(500, 'unknown'));
    mount();
    expect(await screen.findByText(/media library could not be loaded/u)).toBeTruthy();
    call.mockResolvedValueOnce(page([item(1)]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: /^Choose the image/u })).toBeTruthy();
  });

  it('loads the next page on Load more, without repeating a picture, and hides the button at the end', async () => {
    call.mockResolvedValueOnce(page([item(1), item(2)], 1, true));
    mount();
    await screen.findAllByRole('button', { name: /^Choose the image/u });
    call.mockResolvedValueOnce(page([item(2), item(3)], 2, false));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    // The announcement is the last thing the load does (after the pictures and the focus move), so
    // wait for it: the pictures alone show up one render earlier and the checks below would race.
    await waitFor(() =>
      expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(
        'More images loaded.',
      ),
    );
    expect(screen.getAllByRole('button', { name: /^Choose the image/u })).toHaveLength(3);
    expect(call).toHaveBeenLastCalledWith('GET', 'blog/admin/media?page=2');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    // The button is gone: focus moved to the first new picture, and the load is announced.
    const tiles = screen.getAllByRole('button', { name: /^Choose the image/u });
    expect(document.activeElement).toBe(tiles[2]);
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('More images loaded.');
  });

  it('says so when more pictures cannot be loaded and keeps the ones shown', async () => {
    call.mockResolvedValueOnce(page([item(1)], 1, true));
    mount();
    await screen.findByRole('button', { name: /^Choose the image/u });
    call.mockResolvedValueOnce(failed(0, 'network'));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('More images could not be loaded. Try again.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^Choose the image/u })).toHaveLength(1);
  });

  describe('upload', () => {
    beforeEach(() => {
      call.mockResolvedValueOnce(page([item(1)]));
    });

    it('prepares the file, posts it as base64 with the csrf token and uses the new picture at once', async () => {
      prepare.mockResolvedValueOnce({ kind: 'ready', data: 'QUJD' });
      mount();
      await screen.findByRole('button', { name: /^Choose the image/u });
      call.mockResolvedValueOnce({ ok: true, status: 201, body: item(7) });
      upload(png());
      await waitFor(() => expect(onPick).toHaveBeenCalledWith(id(7), true));
      expect(call).toHaveBeenLastCalledWith('POST', 'blog/admin/media', { data: 'QUJD' }, 'csrf-1');
      expect(onClose).toHaveBeenCalled();
    });

    it('shows a busy state while the upload runs and blocks a second one', async () => {
      prepare.mockResolvedValueOnce({ kind: 'ready', data: 'QUJD' });
      mount();
      await screen.findByRole('button', { name: /^Choose the image/u });
      let finish: (value: ApiResult<MediaItem>) => void = () => undefined;
      call.mockReturnValueOnce(new Promise((resolve) => (finish = resolve as never)));
      upload(png());
      expect(await screen.findAllByText('Uploading the image')).not.toHaveLength(0);
      expect(document.querySelector<HTMLInputElement>('input[type="file"]')!.disabled).toBe(true);
      expect(
        screen.getByRole('button', { name: /^Choose the image/u }).hasAttribute('disabled'),
      ).toBe(true);
      finish({ ok: true, status: 201, body: item(7) });
      await waitFor(() => expect(onPick).toHaveBeenCalledWith(id(7), true));
    });

    it('does not send a prepared picture over 4 MiB decoded, and sends one at the limit', async () => {
      prepare.mockResolvedValueOnce({ kind: 'ready', data: 'A'.repeat(MAX_BASE64_CHARS + 1) });
      mount();
      await screen.findByRole('button', { name: /^Choose the image/u });
      upload(png());
      expect(await screen.findByText('This file is too large. The limit is 4 MB.')).toBeTruthy();
      expect(call).toHaveBeenCalledTimes(1);
      prepare.mockResolvedValueOnce({ kind: 'ready', data: 'A'.repeat(MAX_BASE64_CHARS) });
      call.mockResolvedValueOnce({ ok: true, status: 201, body: item(7) });
      upload(png());
      await waitFor(() => expect(onPick).toHaveBeenCalledWith(id(7), true));
    });

    it('cannot be closed while the upload runs (Close and Escape), and can after', async () => {
      prepare.mockResolvedValueOnce({ kind: 'ready', data: 'QUJD' });
      mount();
      await screen.findByRole('button', { name: /^Choose the image/u });
      let finish: (value: ApiResult<MediaItem>) => void = () => undefined;
      call.mockReturnValueOnce(new Promise((resolve) => (finish = resolve as never)));
      upload(png());
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Close' }).hasAttribute('disabled')).toBe(true),
      );
      fireEvent(document.querySelector('dialog')!, new Event('cancel', { cancelable: true }));
      expect(onClose).not.toHaveBeenCalled();
      finish(failed(422, 'file.too-small'));
      await screen.findByRole('alert');
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Close' }).hasAttribute('disabled')).toBe(false),
      );
      fireEvent(document.querySelector('dialog')!, new Event('cancel', { cancelable: true }));
      expect(onClose).toHaveBeenCalled();
    });

    it('refuses a file of another type in the browser, without a request', async () => {
      mount();
      await screen.findByRole('button', { name: /^Choose the image/u });
      upload(new File(['x'], 'a.gif', { type: 'image/gif' }));
      expect(
        await screen.findByText('This file type is not supported. Use JPEG, PNG or WebP.'),
      ).toBeTruthy();
      expect(prepare).not.toHaveBeenCalled();
      expect(call).toHaveBeenCalledTimes(1);
    });

    it('refuses a file that is far too large or cannot be decoded, in the browser', async () => {
      prepare.mockResolvedValueOnce({ kind: 'refused', reason: 'too-large' });
      mount();
      await screen.findByRole('button', { name: /^Choose the image/u });
      upload(png());
      expect(await screen.findByText('This file is too large. The limit is 4 MB.')).toBeTruthy();
      prepare.mockResolvedValueOnce({ kind: 'refused', reason: 'unreadable' });
      upload(png());
      expect(
        await screen.findByText('This file could not be read as an image. Try another file.'),
      ).toBeTruthy();
      expect(call).toHaveBeenCalledTimes(1);
    });

    it.each([
      [413, 'file.too-large', 'This file is too large. The limit is 4 MB.'],
      [415, 'file.unsupported-type', 'This file type is not supported. Use JPEG, PNG or WebP.'],
      [
        422,
        'file.too-small',
        'This image is too small. The longest side must be at least 400 pixels.',
      ],
      [422, 'file.too-many-pixels', 'This image has too many pixels. Use a smaller one.'],
      [422, 'file.unreadable', 'This file could not be read as an image. Try another file.'],
      [400, 'validation.failed', 'The image could not be read. Try another file.'],
      [503, 'blog.unavailable', 'The library is busy. Wait a moment and try again.'],
      [403, 'access.denied', 'Your role cannot upload images.'],
      [0, 'network', 'The image could not be uploaded. Check your connection and try again.'],
      [418, 'something.else', 'The image could not be uploaded. Try again.'],
    ])('explains a %s %s refusal and lets the person try again', async (status, code, text) => {
      prepare.mockResolvedValue({ kind: 'ready', data: 'QUJD' });
      mount();
      await screen.findByRole('button', { name: /^Choose the image/u });
      call.mockResolvedValueOnce(failed(status, code));
      upload(png());
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe(text);
      expect(onPick).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(document.querySelector<HTMLInputElement>('input[type="file"]')!.disabled).toBe(
          false,
        ),
      );
    });

    it('clears the earlier message when a new upload starts', async () => {
      prepare.mockResolvedValue({ kind: 'ready', data: 'QUJD' });
      mount();
      await screen.findByRole('button', { name: /^Choose the image/u });
      call.mockResolvedValueOnce(failed(422, 'file.too-small'));
      upload(png());
      await screen.findByRole('alert');
      call.mockResolvedValueOnce({ ok: true, status: 201, body: item(8) });
      upload(png());
      await waitFor(() => expect(onPick).toHaveBeenCalledWith(id(8), true));
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  it('offers no upload to a session without blog.media.edit, but still lets it choose', async () => {
    call.mockResolvedValueOnce(page([item(1)]));
    mount({ canUpload: false });
    expect(await screen.findByRole('button', { name: /^Choose the image/u })).toBeTruthy();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(screen.getByText('Your role can choose images but not upload new ones.')).toBeTruthy();
  });

  it('closes with the Close button', async () => {
    call.mockResolvedValueOnce(page([item(1)]));
    mount();
    await screen.findByRole('button', { name: /^Choose the image/u });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });
});
