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
import { AddressForm } from './address-form.tsx';
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
  status: 'details-incomplete',
  submission: null,
  latestWithdrawal: null,
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

describe('SlugForm checks', () => {
  it('says so when the check is throttled', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    call.mockResolvedValue({ ok: false, failure: { status: 429, code: 'request.throttled' } });
    render(wrap(<SlugForm file={emptyFile} csrfToken="t" storefrontAddress={null} />));
    fireEvent.change(screen.getByLabelText('Shop web address'), { target: { value: 'my-shop' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(await screen.findByText('Too many checks. Wait a moment.')).toBeTruthy();
    vi.useRealTimers();
  });
});

describe('AddressForm', () => {
  const addressDescriptors = {
    address: {
      fields: [
        { key: 'line1', labelKey: 'sellers.address.line1', required: true, maxLength: 100 },
        { key: 'state', labelKey: 'sellers.address.state', required: true, maxLength: 20 },
      ],
      postcodeField: 'postcode',
      regionField: 'state',
      postcodePattern: '^\\d{4}$',
      regions: ['QLD', 'NSW'],
    },
    timezones: { QLD: ['Australia/Brisbane'], NSW: ['Australia/Sydney'] },
  } as unknown as FormDescriptors;

  it('says so when a save gives no time zone', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { outsideServiceArea: false, timezone: null, zoneOptions: [] },
    });
    render(wrap(<AddressForm file={emptyFile} descriptors={addressDescriptors} csrfToken="t" />));
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByText(/work out your time zone/)).toBeTruthy();
  });

  it('shows a message when the problem is on the address as a whole', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'address', code: 'format' }] },
      },
    });
    render(wrap(<AddressForm file={emptyFile} descriptors={addressDescriptors} csrfToken="t" />));
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByText('Check the details below and try again.')).toBeTruthy();
  });
});

describe('SetupHub states', () => {
  const allSaved = { ...emptyFile, missing: [] as MyFile['missing'] };
  it('shows the details-needed badge and banner while steps are open', () => {
    render(wrap(<SetupHub file={emptyFile} csrfToken="t" />));
    expect(screen.getByText('Details needed')).toBeTruthy();
    expect(screen.getByText('Finish your details')).toBeTruthy();
    expect(screen.getByText('3 fields left')).toBeTruthy();
    expect(screen.getAllByText('Waiting')).toHaveLength(1);
  });

  it('shows the ready badge and banner when every step is saved', () => {
    render(wrap(<SetupHub file={allSaved} csrfToken="t" />));
    expect(screen.getByText('Ready to submit')).toBeTruthy();
    expect(screen.getByText('Your details are ready')).toBeTruthy();
    expect(screen.queryByText('Waiting')).toBeNull();
  });
});

describe('Back to checklist', () => {
  it('is on the step forms and goes to the account page', () => {
    render(
      wrap(
        <BusinessForm file={emptyFile} csrfToken="t" signInEmail="a@b.co" phoneMaxLength={20} />,
      ),
    );
    expect(screen.getByRole('link', { name: 'Back to checklist' }).getAttribute('href')).toBe(
      '/account-setup',
    );
    expect(screen.getByText('Sign-in email')).toBeTruthy();
    expect(screen.getByText('a@b.co', { selector: 'span' })).toBeTruthy();
  });
});

describe('SetupHub', () => {
  it('says the seller is outside the service area and marks the address step', () => {
    render(
      wrap(
        <SetupHub file={{ ...emptyFile, missing: [], outsideServiceArea: true }} csrfToken="t" />,
      ),
    );
    expect(screen.getAllByText("We're not in your area yet").length).toBeGreaterThan(0);
    expect(screen.getByText('Needs attention')).toBeTruthy();
  });

  it('marks a step done when none of its parts is missing', () => {
    render(wrap(<SetupHub file={{ ...emptyFile, missing: ['slug'] }} csrfToken="t" />));
    // Account created, Email confirmed and three finished steps.
    expect(screen.getAllByText('Done')).toHaveLength(5);
    // The shop web address and MondaPac reviews; Review and submit is Waiting.
    expect(screen.getAllByText('To do')).toHaveLength(2);
    expect(screen.getByText('1 field left')).toBeTruthy();
  });
});
