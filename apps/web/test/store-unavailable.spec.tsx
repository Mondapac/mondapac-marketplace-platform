// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import SellersError from '../app/sellers/error.tsx';
import { loadSeller, loadSellers } from '../src/storefront/source.ts';

// The API says `sellers.unavailable` (503): a store page or the sellers list must not show a
// half-empty page as if there were no stores. The read throws and the route's error card shows,
// with Try again.

vi.mock('../src/storefront/api.ts', () => ({
  apiGet: () => Promise.resolve({ kind: 'failed', status: 503, code: 'sellers.unavailable' }),
  apiGetBytes: () => Promise.resolve({ kind: 'failed', status: 503, code: 'sellers.unavailable' }),
}));

afterEach(cleanup);

const QUERY = {
  sort: 'name',
  limit: 12,
  filters: {
    newSellers: false,
    sameDay: false,
    certifications: [],
    categories: [],
    minimums: [],
  },
} as never;

describe('when the sellers read is unavailable', () => {
  it('throws instead of answering "no such store" or an empty list', async () => {
    await expect(loadSeller('kedron-halal')).rejects.toThrow('the store read failed');
    await expect(loadSellers(QUERY)).rejects.toThrow('the store read failed');
  });

  it('shows the error card with Try again, announced as an alert', () => {
    const reset = vi.fn();
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SellersError reset={reset} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: messages.sellers.retry }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
