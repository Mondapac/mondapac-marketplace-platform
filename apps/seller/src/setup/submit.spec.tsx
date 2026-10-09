// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { ReviewSubmit } from './review-submit.tsx';
import { SetupHub } from './setup-hub.tsx';
import type { FormDescriptors, MyFile } from './types.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);

const file: MyFile = {
  version: 3,
  status: 'ready-to-submit',
  submission: null,
  latestWithdrawal: null,
  draftComplete: true,
  missing: [],
  general: {
    storeName: 'Noor Grocers',
    businessName: 'Noor Pty Ltd',
    phone: '0400 000 000',
    contactEmail: null,
  },
  address: { line1: '1 Queen St', suburb: 'Brisbane', postcode: '4000' },
  registeredAddress: null,
  serviceArea: { code: 'AU-BNE', sellerOnboardingEnabled: true },
  outsideServiceArea: false,
  timezone: {
    operatingTimezone: 'Australia/Brisbane',
    timezoneSource: 'address',
    addressTimezone: 'Australia/Brisbane',
  },
  slug: 'noor-grocers',
  identifier: { value: '51824753556', display: '51 824 753 556' },
  registerResult: 'matched',
  zoneOptions: [],
};
const descriptors = {
  address: {
    fields: [
      { key: 'line1', labelKey: 'sellers.address.line1', required: true, maxLength: 100 },
      { key: 'suburb', labelKey: 'sellers.address.suburb', required: true, maxLength: 100 },
      { key: 'postcode', labelKey: 'sellers.address.postcode', required: true, maxLength: 4 },
    ],
  },
  identifier: { scheme: 'abn', labelKey: 'sellers.business-identifier.abn', required: false },
} as unknown as FormDescriptors;

beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

const review = (f: MyFile) =>
  render(wrap(<ReviewSubmit file={f} descriptors={descriptors} csrfToken="csrf-1" />));

describe('review and submit (S6)', () => {
  it('lists the saved values and submits once, then returns to the account page', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: {} });
    review(file);
    expect(screen.getByText('1 Queen St, Brisbane, 4000')).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Submit for review' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/account-setup'));
    expect(call).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledWith('POST', 'sellers/my-file/submit', {}, 'csrf-1');
  });

  it('disables submit and names what is missing', () => {
    review({ ...file, draftComplete: false, missing: ['slug'], slug: null });
    expect(screen.getByText('Missing')).toBeTruthy();
    expect(screen.getByText('Finish 1 item first.')).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Submit for review' }).disabled,
    ).toBe(true);
  });

  it('blocks an address outside the service area and a register mismatch', () => {
    review({ ...file, outsideServiceArea: true, registerResult: 'not-matched' });
    expect(screen.getAllByText('Blocked')).toHaveLength(2);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Submit for review' }).disabled,
    ).toBe(true);
  });

  it('says "Submit again" after changes were needed, and has no button while waiting', () => {
    review({ ...file, status: 'changes-needed' });
    expect(screen.getByRole('button', { name: 'Submit again' })).toBeTruthy();
    cleanup();
    review({ ...file, status: 'awaiting-review' });
    expect(screen.queryByRole('button', { name: /Submit/ })).toBeNull();
  });

  it('shows the reason when the file is incomplete and reloads', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 422, code: 'file.incomplete' } });
    review(file);
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    expect(await screen.findByText(/Some required details are missing/)).toBeTruthy();
    expect(router.refresh).toHaveBeenCalled();
  });
});

describe('S1 while waiting and after a withdrawal', () => {
  it('shows the status, the submitted time and withdraws after a confirm', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { version: 4 } });
    render(
      wrap(
        <SetupHub
          file={{
            ...file,
            status: 'awaiting-review',
            submission: { revisionNo: 1, submittedAt: '2026-10-08T23:30:00Z' },
          }}
          csrfToken="csrf-1"
        />,
      ),
    );
    expect(screen.getByText("We're reviewing your application")).toBeTruthy();
    expect(screen.getByText(/Submitted on 9 Oct 2026/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw submission' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Withdraw submission' })[1]!);
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('POST', 'sellers/my-file/withdraw', {}, 'csrf-1'),
    );
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('says who withdrew and when, and offers the submit step again', () => {
    render(
      wrap(
        <SetupHub
          file={{
            ...file,
            latestWithdrawal: { cause: 'edited', byKind: 'admin', at: '2026-10-08T23:30:00Z' },
          }}
          csrfToken="t"
        />,
      ),
    );
    expect(screen.getByText(/withdrawn on 9 Oct 2026 because MondaPac edited/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Review and submit/ }).getAttribute('href')).toBe(
      '/account-setup/review',
    );
  });
});
