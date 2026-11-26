// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { OfferActions } from './offer-actions.tsx';
import { SubmitPreview } from './submit-preview.tsx';

const call = vi.mocked(callApi);
const mount = (heldPrice = false) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <SubmitPreview offerId="o1" csrfToken="csrf" heldPrice={heldPrice} />
    </NextIntlClientProvider>,
  );

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('SubmitPreview (slice 7b)', () => {
  it('asks the dry run once and says the offer goes on sale at once', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { outcome: 'publish', reasons: [] } });
    mount();
    expect(screen.getByText(/Checking whether/)).toBeTruthy();
    expect(await screen.findByText('Goes on sale when you submit')).toBeTruthy();
    expect(screen.getByText(/not a promise/)).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(
      'POST',
      'catalog/seller/offers/o1/submit-preview',
      undefined,
      'csrf',
    );
  });

  it('names only what the seller can fix; held-for-review is the generic line alone', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { outcome: 'review', reasons: ['handling', 'contact-text', 'held-for-review'] },
    });
    mount();
    expect(await screen.findByText("We'll check this offer first")).toBeTruthy();
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual([
      expect.stringMatching(/handling isn't Sealed original/),
      expect.stringMatching(/contact details or a link/),
    ]);
  });

  it('says only "we check it first" for a hidden reason, and ignores a code it does not know', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { outcome: 'review', reasons: ['held-for-review', 'sensitive-category'] },
    });
    const { container } = mount();
    expect(await screen.findByText("We'll check this offer first")).toBeTruthy();
    expect(screen.queryAllByRole('listitem')).toEqual([]);
    expect(container.textContent).not.toMatch(/sensitive|category|probation|stop|sample/i);
  });

  it.each([
    ['a 503', { ok: false, failure: { status: 503, code: 'access.unavailable' } }],
    ['a 429', { ok: false, failure: { status: 429, code: 'request.throttled' } }],
    ['an unknown shape', { ok: true, status: 200, body: { published: true } }],
    [
      'publish with reasons',
      { ok: true, status: 200, body: { outcome: 'publish', reasons: ['x'] } },
    ],
  ])('says it could not check, never a guess, on %s', async (_case, answer) => {
    call.mockResolvedValue(answer as never);
    mount();
    expect(await screen.findByText(/couldn't check this offer right now/)).toBeTruthy();
    expect(screen.queryByText(/Goes on sale/)).toBeNull();
  });

  it('adds the held price, from the size rows, without a number', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { outcome: 'publish', reasons: [] } });
    const { container } = mount(true);
    expect(await screen.findByText(/A price on this offer is waiting for our check/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/\d|%|median|similar/);
  });

  it('shows on a draft through OfferActions only when asked, and not on other states', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { outcome: 'publish', reasons: [] } });
    const page = (status: string, preview: boolean) =>
      render(
        <NextIntlClientProvider locale="en-AU" messages={messages}>
          <OfferActions offerId="o1" status={status} csrfToken="csrf" preview={preview} />
        </NextIntlClientProvider>,
      );
    page('draft', true);
    expect(await screen.findByText('Goes on sale when you submit')).toBeTruthy();
    cleanup();
    call.mockClear();
    page('changes-needed', true);
    page('draft', false);
    expect(call).not.toHaveBeenCalled();
  });
});
