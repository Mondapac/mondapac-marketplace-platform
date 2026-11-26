// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { AddOfferDialog, type PlatformProduct } from './add-offer-dialog.tsx';

// QA (PR 1334): the failure paths of "Sell this": a 401, a double click, a throttled run.

const call = vi.mocked(callApi);
const product = (over: Partial<PlatformProduct> = {}): PlatformProduct => ({
  productId: 'p1',
  productCode: 'P-1',
  name: 'Beef mince',
  brandName: null,
  categoryId: null,
  categoryName: null,
  variantCount: 1,
  alreadySelling: false,
  primaryImageId: null,
  ...over,
});
const ok = <T,>(body: T) => Promise.resolve({ ok: true as const, status: 200, body });
const page = (items: PlatformProduct[]) =>
  ok({ items, total: items.length, page: 1, pageSize: 25, notice: null, barcodeResults: [] });

function open(navigate = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <AddOfferDialog open csrfToken="csrf" marketId="AU" onClose={vi.fn()} navigate={navigate} />
    </NextIntlClientProvider>,
  );
  return navigate;
}

async function pickAndSell(label: RegExp, button = 'Sell this') {
  fireEvent.click(await screen.findByLabelText(label));
  const sell = await screen.findByRole('button', { name: button });
  await waitFor(() => expect((sell as HTMLButtonElement).disabled).toBe(false));
  return sell;
}

const assign = vi.fn();
beforeEach(() => {
  call.mockReset();
  assign.mockReset();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { assign },
  });
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('Add offer: create failures', () => {
  it('sends the seller to the session-ended page on a 401 while creating, and stops', async () => {
    const posts: string[] = [];
    call.mockImplementation((method, path, body) => {
      if (method === 'POST') {
        posts.push((body as { productId: string }).productId);
        return Promise.resolve({
          ok: false as const,
          failure: { status: 401, code: 'session.invalid' },
        });
      }
      return path.includes('options')
        ? ok({ conditions: ['new'] })
        : page([product(), product({ productId: 'p2', productCode: 'P-2', name: 'Lamb' })]);
    });
    const navigate = open();
    fireEvent.click(await screen.findByLabelText(/Lamb/));
    const sell = await pickAndSell(/Beef mince/, 'Sell these (2)');
    fireEvent.click(sell);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    // The second product is not tried after the first answered 401.
    expect(posts).toEqual(['p2']);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('creates one Offer for a double click on "Sell this"', async () => {
    let release: (value: unknown) => void = () => undefined;
    call.mockImplementation((method, path) => {
      if (method === 'POST') {
        return new Promise((resolve) => {
          release = () => resolve({ ok: true, status: 201, body: { offerId: 'o1' } });
        }) as never;
      }
      return path.includes('options') ? ok({ conditions: ['new'] }) : page([product()]);
    });
    const navigate = open();
    const sell = await pickAndSell(/Beef mince/);
    fireEvent.click(sell);
    fireEvent.click(sell);
    fireEvent.click(sell);
    release(undefined);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/offers/o1?new=1#sizes'));
    expect(call.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
  });

  it('names a taken SKU and keeps the product picked so the seller can see it', async () => {
    call.mockImplementation((method, path) => {
      if (method === 'POST') {
        return Promise.resolve({
          ok: false as const,
          failure: { status: 409, code: 'offer.sku-taken' },
        });
      }
      return path.includes('options') ? ok({ conditions: ['new'] }) : page([product()]);
    });
    const navigate = open();
    fireEvent.click(await pickAndSell(/Beef mince/));
    expect(await screen.findByText(/Beef mince: /)).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
    // Retry is possible: the button is enabled again.
    const again = await screen.findByRole('button', { name: 'Sell this' });
    await waitFor(() => expect((again as HTMLButtonElement).disabled).toBe(false));
  });

  it('shows an unknown refusal as a general reason, not a code', async () => {
    call.mockImplementation((method, path) => {
      if (method === 'POST') {
        return Promise.resolve({
          ok: false as const,
          failure: { status: 500, code: 'internal.error' },
        });
      }
      return path.includes('options') ? ok({ conditions: ['new'] }) : page([product()]);
    });
    open();
    fireEvent.click(await pickAndSell(/Beef mince/));
    expect(await screen.findByText(/Beef mince: /)).toBeTruthy();
    expect(screen.queryByText(/internal\.error/)).toBeNull();
  });
});
