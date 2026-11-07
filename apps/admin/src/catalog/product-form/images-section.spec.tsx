// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('../../categories/image-prepare.ts', () => ({ prepareImage: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { prepareImage } from '../../categories/image-prepare.ts';
import { ImagesSection, MAX_IMAGES, moved } from './images-section.tsx';
import type { ProductImage } from './types.ts';

const call = vi.mocked(callApi);
const prepare = vi.mocked(prepareImage);
const PRODUCT = '0190a000-0000-7000-8000-0000000000c1';
const photo = (n: number): ProductImage => ({
  imageId: `0190a000-0000-7000-8000-0000000001${n.toString().padStart(2, '0')}`,
  width: 1600,
  height: 1200,
  createdAt: '2026-11-07T10:00:00Z',
});
const A = photo(1);
const B = photo(2);
const C = photo(3);

let onImageIds: ReturnType<typeof vi.fn<(ids: string[]) => void>>;

function mount(library: readonly ProductImage[] | null, imageIds: readonly string[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ImagesSection
        productId={PRODUCT}
        csrfToken="csrf-1"
        library={library}
        imageIds={imageIds}
        onImageIds={onImageIds}
      />
    </NextIntlClientProvider>,
  );
}

const openMenu = (n: number) =>
  fireEvent.click(screen.getByRole('button', { name: `Image ${n} options` }));
const pick = (name: string) => fireEvent.click(screen.getByRole('menuitem', { name }));
const live = () => document.querySelector('[aria-live="polite"]')?.textContent;

beforeEach(() => {
  call.mockReset();
  prepare.mockReset();
  onImageIds = vi.fn();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(() => cleanup());

describe('moved', () => {
  it('moves one id to a position, clamped to the ends', () => {
    expect(moved(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(moved(['a', 'b', 'c'], 'a', 1)).toEqual(['b', 'a', 'c']);
    expect(moved(['a', 'b', 'c'], 'a', 9)).toEqual(['b', 'c', 'a']);
    expect(moved(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
  });
});

describe('the images field', () => {
  it('shows the empty drop area with Upload images and the format caption', () => {
    mount([], []);
    expect(screen.getByText('Upload images')).toBeTruthy();
    expect(
      screen.getByText('JPG, PNG or WebP, at least 1200 px on the long side. Images only for now.'),
    ).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Images' })).toBeNull();
  });

  it('says so when the library could not be read', () => {
    mount(null, []);
    expect(screen.getByText(/Images could not be loaded/)).toBeTruthy();
  });

  it('shows the draft order first, the main image large with its badge, then library-only photos', () => {
    mount(
      [A, B, C],
      [B, A].map((p) => p.imageId),
    );
    const images = [
      ...within(screen.getByRole('list', { name: 'Images' })).getAllByRole('img'),
      ...within(screen.getByRole('list', { name: 'Images not in the product' })).getAllByRole(
        'img',
      ),
    ];
    expect(images.map((img) => img.getAttribute('src'))).toEqual([
      `/api/catalog/admin/products/${PRODUCT}/images/${B.imageId}/thumb`,
      `/api/catalog/admin/products/${PRODUCT}/images/${A.imageId}/thumb`,
      `/api/catalog/admin/products/${PRODUCT}/images/${C.imageId}/thumb`,
    ]);
    expect(images.map((img) => img.getAttribute('alt'))).toEqual([
      'Image 1 of 3',
      'Image 2 of 3',
      'Image 3 of 3',
    ]);
    expect(images[0]?.getAttribute('width')).toBe('168');
    expect(images[1]?.getAttribute('width')).toBe('80');
    expect(screen.getAllByText('Main')).toHaveLength(1);
    expect(screen.getAllByText('Not in product')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Add image' })).toBeTruthy();
  });

  it('offers the menu items for each position, and none that do nothing', () => {
    mount(
      [A, B, C],
      [A, B, C].map((p) => p.imageId),
    );
    openMenu(1);
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Move right',
      'Remove from product',
      'Delete',
    ]);
    fireEvent.keyDown(screen.getAllByRole('menuitem')[0]!, { key: 'Escape' });
    openMenu(3);
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Make main',
      'Move left',
      'Remove from product',
      'Delete',
    ]);
  });

  it('makes an image the main one, moves one and announces it, changing the draft only', () => {
    mount(
      [A, B, C],
      [A, B, C].map((p) => p.imageId),
    );
    openMenu(3);
    pick('Make main');
    expect(onImageIds).toHaveBeenLastCalledWith([C, A, B].map((p) => p.imageId));
    expect(live()).toBe('Image 3 is now the main image.');
    openMenu(1);
    pick('Move right');
    expect(onImageIds).toHaveBeenLastCalledWith([B, A, C].map((p) => p.imageId));
    expect(live()).toBe('Image moved to position 2 of 3.');
    expect(call).not.toHaveBeenCalled();
  });

  it('removes an image from the product and adds a library photo back', () => {
    mount([A, B], [A.imageId]);
    openMenu(1);
    pick('Remove from product');
    expect(onImageIds).toHaveBeenLastCalledWith([]);
    openMenu(2);
    pick('Add to product');
    expect(onImageIds).toHaveBeenLastCalledWith([A.imageId, B.imageId]);
    expect(call).not.toHaveBeenCalled();
  });

  it('deletes after the confirm dialog, with focus on Cancel, and drops the id from the draft', async () => {
    mount(
      [A, B],
      [A, B].map((p) => p.imageId),
    );
    openMenu(2);
    pick('Delete');
    const dialog = await screen.findByRole('dialog', { name: 'Delete this image?' });
    expect(within(dialog).getByText(/cannot be restored/)).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Cancel'));
    call.mockResolvedValueOnce({ ok: true, status: 200, body: { deleted: true } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onImageIds).toHaveBeenLastCalledWith([A.imageId]));
    expect(call).toHaveBeenCalledWith(
      'DELETE',
      `catalog/admin/platform-products/${PRODUCT}/images/${B.imageId}`,
      undefined,
      'csrf-1',
    );
    expect(screen.getAllByRole('img')).toHaveLength(1);
  });

  it('explains a photo that a published version holds', async () => {
    mount([A], [A.imageId]);
    openMenu(1);
    pick('Delete');
    const dialog = await screen.findByRole('dialog', { name: 'Delete this image?' });
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 409, code: 'image.in-use' },
    } as never);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(
      await screen.findByText(
        'This image is in a published version. Remove it from the product instead.',
      ),
    ).toBeTruthy();
    expect(screen.getAllByRole('img')).toHaveLength(1);
  });

  it('uploads each picked file, shrunk first, and appends it to the draft', async () => {
    mount([A], [A.imageId]);
    prepare.mockResolvedValue({ kind: 'ready', data: 'QUJD' });
    call.mockResolvedValueOnce({ ok: true, status: 201, body: B });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toBe('image/jpeg,image/png,image/webp');
    fireEvent.change(input, { target: { files: [new File(['x'], 'b.jpg')] } });
    await waitFor(() => expect(onImageIds).toHaveBeenLastCalledWith([A.imageId, B.imageId]));
    expect(call).toHaveBeenCalledWith(
      'POST',
      `catalog/admin/platform-products/${PRODUCT}/images`,
      { data: 'QUJD' },
      'csrf-1',
    );
    expect(await screen.findAllByRole('img')).toHaveLength(2);
  });

  it('names a refused file and keeps going', async () => {
    mount([], []);
    prepare.mockResolvedValueOnce({ kind: 'refused', reason: 'unreadable' });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(['x'], 'a.gif')] } });
    expect(await screen.findByText('The file could not be read as an image.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('hides the add tile at the limit and says how many a product holds', () => {
    const full = Array.from({ length: MAX_IMAGES }, (_, n) => photo(n + 1));
    mount(
      full,
      full.map((p) => p.imageId),
    );
    expect(screen.queryByRole('button', { name: 'Add image' })).toBeNull();
    expect(screen.getByText('Up to 8 images.')).toBeTruthy();
  });
});
