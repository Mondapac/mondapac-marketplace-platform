// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { SuggestValue } from './suggest-value.tsx';
import type { ValueSuggestion } from './types.ts';

const call = vi.mocked(callApi);
const PRODUCT = '0190a000-0000-7000-8000-0000000000a1';

const suggestion = (over: Partial<ValueSuggestion>): ValueSuggestion => ({
  id: '0190a000-0000-7000-8000-0000000000b1',
  attributeCode: 'flavour',
  label: '<i>Oat</i>',
  status: 'open',
  optionCode: null,
  rejectReason: null,
  createdAt: '2026-11-03T10:00:00.000Z',
  ...over,
});

function mount(suggestions: readonly ValueSuggestion[], onSuggested = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <SuggestValue
        productId={PRODUCT}
        attributeCode="flavour"
        suggestions={suggestions}
        csrfToken="csrf-1"
        onSuggested={onSuggested}
      />
    </NextIntlClientProvider>,
  );
  return onSuggested;
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('suggest a value', () => {
  it('sends the trimmed words once and reads the product again', async () => {
    const done = mount([]);
    fireEvent.click(screen.getByRole('button', { name: 'Suggest a value' }));
    const send = screen.getByRole<HTMLButtonElement>('button', { name: 'Send suggestion' });
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  Oat honey  ' } });
    call.mockResolvedValue({ ok: true, status: 201, body: {} });
    fireEvent.click(send);
    fireEvent.click(send);
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith(
      'POST',
      `catalog/seller/products/${PRODUCT}/attribute-suggestions`,
      { attributeCode: 'flavour', label: 'Oat honey' },
      'csrf-1',
    );
  });

  it('keeps the form and says why when the suggestion is refused', async () => {
    mount([]);
    fireEvent.click(screen.getByRole('button', { name: 'Suggest a value' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Oat' } });
    call.mockResolvedValue({
      ok: false,
      failure: { status: 422, code: 'suggestion.limit-reached' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send suggestion' }));
    expect(await screen.findByText(/too many suggestions waiting/)).toBeTruthy();
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('shows an open suggestion as plain text and offers no second one', () => {
    mount([suggestion({})]);
    expect(screen.getByRole('status').textContent).toContain('<i>Oat</i>');
    expect(document.querySelector('i')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Suggest a value' })).toBeNull();
  });

  it('shows the reviewer words of a rejected one and lets the seller ask again', () => {
    mount([suggestion({ status: 'rejected', rejectReason: 'Not a flavour' })]);
    expect(screen.getByText(/Not a flavour/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Suggest a value' })).toBeTruthy();
  });

  it.each([
    ['attribute.not-suggestable', /does not take suggestions/],
    ['suggestion.value-exists', /already on the list/],
    ['product.not-editable', /can't be changed now/],
    ['access.seller-not-approved', /has to be approved/],
    ['seller.not-eligible', /cannot make suggestions yet/],
    ['unheard.of', /could not be sent/],
  ])('says %s plainly and keeps the form', async (code, text) => {
    mount([]);
    fireEvent.click(screen.getByRole('button', { name: 'Suggest a value' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Oat' } });
    call.mockResolvedValue({ ok: false, failure: { status: 422, code } });
    fireEvent.click(screen.getByRole('button', { name: 'Send suggestion' }));
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('says the service is unreachable on a 5xx and sends an ended session to sign-in', async () => {
    mount([]);
    fireEvent.click(screen.getByRole('button', { name: 'Suggest a value' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Oat' } });
    call.mockResolvedValueOnce({ ok: false, failure: { status: 503, code: 'unknown' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send suggestion' }));
    expect(await screen.findByText(/not reachable/)).toBeTruthy();
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    call.mockResolvedValueOnce({ ok: false, failure: { status: 401, code: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send suggestion' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
    vi.unstubAllGlobals();
  });

  it('moves focus into the form and back to the button on cancel', async () => {
    mount([]);
    fireEvent.click(screen.getByRole('button', { name: 'Suggest a value' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox')));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Suggest a value' })),
    );
  });

  it('tells what a reviewer did with an approved, mapped or reason-less rejected one', () => {
    mount([suggestion({ status: 'approved', optionCode: 'oat' })]);
    expect(screen.getByText(/added “<i>Oat<\/i>” to the list/)).toBeTruthy();
    cleanup();
    mount([suggestion({ status: 'mapped', optionCode: 'plain' })]);
    expect(screen.getByText(/matched “<i>Oat<\/i>”/)).toBeTruthy();
    cleanup();
    mount([suggestion({ status: 'rejected', rejectReason: null })]);
    expect(screen.getByText(/did not add “<i>Oat<\/i>”\./)).toBeTruthy();
  });
});
