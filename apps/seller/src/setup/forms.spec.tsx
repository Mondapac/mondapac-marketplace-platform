// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { BusinessForm } from './business-form.tsx';
import { NumberForm } from './number-form.tsx';
import { SetupHub } from './setup-hub.tsx';
import { SlugForm } from './slug-form.tsx';
import type { FormDescriptors, MyFile } from './types.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);

const emptyFile: MyFile = {
  version: 1,
  draftComplete: false,
  missing: ['storeName', 'businessName', 'phone', 'address', 'timezone', 'identifier', 'slug'],
  general: { storeName: null, businessName: null, phone: null, contactEmail: null },
  address: null,
  registeredAddress: null,
  serviceArea: null,
  outsideServiceArea: null,
  timezone: null,
  slug: null,
  identifier: null,
  registerResult: null,
  zoneOptions: [],
};

const descriptors = {
  identifier: {
    scheme: 'abn',
    labelKey: 'sellers.business-identifier.abn',
    required: false,
    maxLength: 20,
  },
} as unknown as FormDescriptors;

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('BusinessForm', () => {
  it('shows the phone problem on the phone field and keeps what was typed', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 422, code: 'phone.required' } });
    render(
      wrap(
        <BusinessForm file={emptyFile} csrfToken="t" signInEmail="a@b.co" phoneMaxLength={20} />,
      ),
    );
    fireEvent.change(screen.getByLabelText('Store name'), { target: { value: 'Halal Bites' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByText('Enter a phone number.')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Store name').value).toBe('Halal Bites');
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'sellers/my-file/general',
      expect.objectContaining({ storeName: 'Halal Bites' }),
      't',
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it('moves to the next step after a save', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { version: 2 } });
    render(
      wrap(
        <BusinessForm file={emptyFile} csrfToken="t" signInEmail="a@b.co" phoneMaxLength={20} />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/account-setup/address'));
  });
});

describe('NumberForm', () => {
  it('shows the register result after a save', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { registerResult: 'not-matched' } });
    render(wrap(<NumberForm file={emptyFile} descriptors={descriptors} csrfToken="t" />));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '51 824 753 556' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Continue' })).toBeTruthy();
  });
});

describe('SlugForm', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  const file = { ...emptyFile, general: { ...emptyFile.general, storeName: 'Halal Bites!' } };

  it('suggests a slug from the store name and checks it after typing stops', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { code: 'slug.available' } });
    render(wrap(<SlugForm file={file} csrfToken="t" storefrontAddress="mondapac.com.au/shop/" />));
    const input = screen.getByLabelText<HTMLInputElement>('Shop web address');
    expect(input.value).toBe('halal-bites');
    expect(screen.getByText('mondapac.com.au/shop/')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'halal-bites-brisbane' } });
    expect(call).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(call).toHaveBeenCalledWith(
      'POST',
      'sellers/my-file/slug-check',
      { slug: 'halal-bites-brisbane' },
      't',
    );
    expect(await screen.findByText(/Available now/)).toBeTruthy();
  });

  it('never checks an invalid slug and blocks save when the address is taken', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { code: 'slug.taken' } });
    render(wrap(<SlugForm file={file} csrfToken="t" storefrontAddress={null} />));
    const input = screen.getByLabelText<HTMLInputElement>('Shop web address');
    fireEvent.change(input, { target: { value: 'ab' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(call).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'taken-name' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(await screen.findByText("That address isn't available. Try another.")).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Save and continue' }).disabled,
    ).toBe(true);
  });
});

describe('SetupHub', () => {
  it('marks a step done when none of its parts is missing', () => {
    render(wrap(<SetupHub file={{ ...emptyFile, missing: ['slug'] }} />));
    expect(screen.getAllByText('Done')).toHaveLength(3);
    expect(screen.getAllByText('To do')).toHaveLength(1);
  });
});
