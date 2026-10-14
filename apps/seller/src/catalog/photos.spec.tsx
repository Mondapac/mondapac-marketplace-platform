// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('./photo-prepare.ts', () => ({ preparePhoto: vi.fn() }));
const refresh = vi.fn();
const assign = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { callApi } from '../api/client.ts';
import { EditForm } from './edit-form.tsx';
import { preparePhoto } from './photo-prepare.ts';
import type { ProductPhoto, ProductView } from './types.ts';

const call = vi.mocked(callApi);
const prepare = vi.mocked(preparePhoto);

const photo = (imageId: string): ProductPhoto => ({
  imageId,
  width: 1200,
  height: 800,
  createdAt: '2026-10-14T00:00:00Z',
});
const product = (content: Record<string, unknown>): ProductView => ({
  productId: 'p1',
  productCode: 'P00000001',
  typeCode: 'grocery',
  familyCode: 'food',
  variantModel: 'single',
  status: 'draft',
  variants: [{ variantId: 'v1', state: 'active' }],
  maxVariants: 5,
  sensitiveFields: [],
  lastChangedAt: '2026-10-01T00:00:00Z',
  createdAt: '2026-10-01T00:00:00Z',
  pendingSubmittedAt: null,
  form: { taxCategoryCodes: [], fields: [], categories: [] },
  workingCopy: { content, lastSavedAt: '2026-10-01T00:00:00Z', baseRevisionId: null },
  published: null,
  pending: null,
});
const mount = (library: readonly ProductPhoto[] | null, content: Record<string, unknown> = {}) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <EditForm
        product={product({ texts: { 'en-AU': { name: 'Dates' } }, ...content })}
        photos={library}
        locales={['en-AU']}
        defaultLocale="en-AU"
        csrfToken="csrf"
      />
    </NextIntlClientProvider>,
  );
const saved = { ok: true, status: 200, body: { variantIds: ['v1'], refusedFields: [] } } as const;
const file = (name = 'a.jpg') => new File(['x'], name, { type: 'image/jpeg' });
const tilesOf = (): HTMLElement[] =>
  within(screen.getByRole('list', { name: 'Photos' })).getAllByRole('listitem');
const pick = (files: File[]) =>
  fireEvent.change(screen.getByLabelText('Add photos'), { target: { files } });

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', { value: { assign }, writable: true });
});
afterEach(cleanup);

describe('photos on the product form', () => {
  it('shows the empty state and a notice when the photo list cannot be read', () => {
    mount([]);
    expect(screen.getByText('No photos yet. Add the first one.')).toBeTruthy();
    cleanup();
    mount(null);
    expect(screen.getByText(/Photos are unavailable right now/)).toBeTruthy();
    expect(screen.queryByLabelText('Add photos')).toBeNull();
  });

  it('lists the draft photos in order with the first as main, and the others as library photos', () => {
    mount([photo('i1'), photo('i2'), photo('i3')], { imageIds: ['i2', 'i1'] });
    const tiles = tilesOf();
    expect(tiles).toHaveLength(3);
    expect(within(tiles[0]!).getByText('Main photo')).toBeTruthy();
    expect(within(tiles[1]!).getByText('Photo 2')).toBeTruthy();
    expect(within(tiles[2]!).getByText('Not on the product')).toBeTruthy();
    expect(within(tiles[0]!).getByRole('img').getAttribute('src')).toBe(
      '/api/catalog/seller/products/p1/images/i2/medium',
    );
  });

  it('uploads a photo, adds it to the draft and saves it with the draft', async () => {
    prepare.mockResolvedValue({ kind: 'ready', data: 'QUJD' });
    call
      .mockResolvedValueOnce({ ok: true, status: 201, body: photo('new1') })
      .mockResolvedValue(saved);
    mount([]);
    pick([file()]);
    await waitFor(() => expect(screen.getByText('Main photo')).toBeTruthy());
    expect(call).toHaveBeenCalledWith(
      'POST',
      'catalog/seller/products/p1/images',
      { data: 'QUJD' },
      'csrf',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call).toHaveBeenLastCalledWith(
      'PUT',
      'catalog/seller/products/p1/draft',
      {
        content: { texts: { 'en-AU': { name: 'Dates' } }, imageIds: ['new1'] },
        variantIds: ['v1'],
      },
      'csrf',
    );
  });

  it('keeps an untouched draft without photos free of an imageIds key', async () => {
    call.mockResolvedValue(saved);
    mount([]);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]?.[2]).toEqual({
      content: { texts: { 'en-AU': { name: 'Dates' } } },
      variantIds: ['v1'],
    });
  });

  it('makes a photo the main one and takes one off the product, then saves the new order', async () => {
    call.mockResolvedValue(saved);
    mount([photo('i1'), photo('i2'), photo('i3')], { imageIds: ['i1', 'i2', 'i3'] });
    const second = tilesOf()[1]!;
    fireEvent.click(within(second).getByRole('button', { name: 'Make main' }));
    // i2 is first now; take i3 (last tile) off the product.
    const last = tilesOf()[2]!;
    fireEvent.click(within(last).getByRole('button', { name: 'Take off' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]?.[2]).toMatchObject({
      content: { imageIds: ['i2', 'i1'] },
    });
    // The photo taken off stays in the library and can be added back.
    expect(screen.getByRole('button', { name: 'Add back' })).toBeTruthy();
  });

  it('asks before deleting and drops a photo that the API deleted', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { deleted: true } });
    mount([photo('i1')], { imageIds: ['i1'] });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(call).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    await waitFor(() => expect(screen.getByText('No photos yet. Add the first one.')).toBeTruthy());
    expect(call).toHaveBeenCalledWith(
      'DELETE',
      'catalog/seller/products/p1/images/i1',
      undefined,
      'csrf',
    );
  });

  it('says why a photo cannot be deleted and keeps it', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 409, code: 'image.in-use' } });
    mount([photo('i1')], { imageIds: ['i1'] });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect(await screen.findByText(/part of a version you submitted/)).toBeTruthy();
    expect(tilesOf()).toHaveLength(1);
  });

  it('names a refused upload and a photo the browser cannot read, and adds nothing', async () => {
    prepare.mockResolvedValueOnce({ kind: 'refused', reason: 'unreadable' });
    mount([]);
    pick([file()]);
    expect(await screen.findByText('A photo could not be read. Choose another file.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();

    prepare.mockResolvedValue({ kind: 'ready', data: 'QUJD' });
    call.mockResolvedValue({ ok: false, failure: { status: 415, code: 'file.unsupported-type' } });
    pick([file('b.jpg')]);
    expect(await screen.findByText('Only JPEG, PNG and WebP photos are accepted.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Photos' })).toBeNull();
  });

  it('sends the seller to sign in again when the session ended during an upload', async () => {
    prepare.mockResolvedValue({ kind: 'ready', data: 'QUJD' });
    call.mockResolvedValue({ ok: false, failure: { status: 401, code: 'session.invalid' } });
    mount([]);
    pick([file()]);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });

  it('stops offering uploads at eight photos', () => {
    const eight = Array.from({ length: 8 }, (_, index) => photo(`i${index}`));
    mount(eight, { imageIds: eight.map((item) => item.imageId) });
    expect(screen.getByLabelText<HTMLInputElement>('Add photos').disabled).toBe(true);
  });
});
