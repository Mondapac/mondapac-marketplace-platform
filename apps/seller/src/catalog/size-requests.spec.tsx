// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

import { callApi } from '../api/client.ts';
import { expectToast } from '../../test/toast-spy.ts';
import type { RequestAxis, SizeRequestItem } from './size-request-logic.ts';
import { SizeRequests } from './size-requests.tsx';

const call = vi.mocked(callApi);

/** Two Markets: a test that only passes for AU is a bug. */
const MARKETS = [
  { name: 'AU', locale: 'en-AU' },
  { name: 'ZZ', locale: 'ja-JP' },
] as const;

const AXES: RequestAxis[] = [
  {
    code: 'size',
    name: 'Size',
    options: [
      { code: 'm', label: 'M' },
      { code: 'xl', label: 'XL' },
    ],
  },
];

const item = (over: Partial<SizeRequestItem> = {}): SizeRequestItem => ({
  id: 'r1',
  offerId: 'o1',
  productId: 'p1',
  productCode: 'MP-1',
  status: 'open',
  options: [{ attributeCode: 'size', attributeName: 'Size', optionCode: 'xl', optionLabel: 'XL' }],
  resolvedVariantId: null,
  declineReason: null,
  createdAt: '2026-11-10T10:00:00.000Z',
  decidedAt: null,
  ...over,
});

function mount(locale: string, over: Partial<Parameters<typeof SizeRequests>[0]> = {}) {
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <SizeRequests
        offerId="o1"
        axes={AXES}
        items={[]}
        openCount={0}
        maxOpen={10}
        canRequest
        csrfToken="csrf-1"
        {...over}
      />
    </NextIntlClientProvider>,
  );
}

afterEach(() => cleanup());

describe.each(MARKETS)('Request a size ($name)', ({ locale }) => {
  beforeEach(() => {
    call.mockReset();
    refresh.mockReset();
  });

  it('sends the chosen option codes for the offer, then refreshes the page', async () => {
    mount(locale);
    fireEvent.click(screen.getByRole('button', { name: 'Request a size' }));
    const send = screen.getByRole<HTMLButtonElement>('button', { name: 'Send request' });
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'xl' } });
    call.mockResolvedValueOnce({ ok: true, status: 201, body: { id: 'r9' } });
    fireEvent.click(send);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith(
      'POST',
      'catalog/seller/offers/o1/variant-requests',
      { optionValues: { size: 'xl' } },
      'csrf-1',
    );
    await expectToast('Request sent.');
  });

  it('keeps the form open and says why when the size exists', async () => {
    mount(locale);
    fireEvent.click(screen.getByRole('button', { name: 'Request a size' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'm' } });
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 409, code: 'variant-request.variant-exists' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByText(/already has this size/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send request' })).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('sends a request once on a double click', () => {
    mount(locale);
    fireEvent.click(screen.getByRole('button', { name: 'Request a size' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'm' } });
    call.mockReturnValueOnce(new Promise(() => undefined));
    const send = screen.getByRole('button', { name: 'Send request' });
    fireEvent.click(send);
    fireEvent.click(send);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('offers no request at the limit, and none without the edit key, but still lists them', () => {
    mount(locale, { openCount: 10, items: [item()] });
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Request a size' });
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/10 requests waiting/)).toBeTruthy();
    cleanup();
    mount(locale, { canRequest: false, items: [item()] });
    expect(screen.queryByRole('button', { name: 'Request a size' })).toBeNull();
    expect(screen.getByRole('list', { name: 'Sizes you asked for' })).toBeTruthy();
  });

  it('shows each status, and a declined reason as plain text', () => {
    mount(locale, {
      items: [
        item({ id: 'a' }),
        item({ id: 'b', status: 'approved', decidedAt: '2026-11-11T10:00:00.000Z' }),
        item({ id: 'c', status: 'mapped', decidedAt: '2026-11-11T10:00:00.000Z' }),
        item({
          id: 'd',
          status: 'declined',
          declineReason: '<b>Not made</b> in XL',
          decidedAt: '2026-11-11T10:00:00.000Z',
        }),
      ],
    });
    expect(screen.getByText('Waiting')).toBeTruthy();
    expect(screen.getByText('Added')).toBeTruthy();
    expect(screen.getByText('Already offered')).toBeTruthy();
    expect(screen.getByText('Declined')).toBeTruthy();
    expect(screen.getByText('Reason: <b>Not made</b> in XL')).toBeTruthy();
    expect(document.querySelector('b')).toBeNull();
  });

  it('says so when nothing was asked', () => {
    mount(locale);
    expect(screen.getByText('You have not asked for a size on this product.')).toBeTruthy();
  });
});
