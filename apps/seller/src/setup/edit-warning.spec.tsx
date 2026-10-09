// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { BusinessForm } from './business-form.tsx';
import { NumberForm } from './number-form.tsx';
import type { FormDescriptors, MyFile } from './types.ts';

const call = vi.mocked(callApi);

const file: MyFile = {
  version: 3,
  status: 'awaiting-review',
  submission: { revisionNo: 1, submittedAt: '2026-10-08T23:30:00Z' },
  latestWithdrawal: null,
  draftComplete: true,
  missing: [],
  general: {
    storeName: 'Noor Grocers',
    businessName: 'Noor Pty Ltd',
    phone: '0400 000 000',
    contactEmail: null,
  },
  address: null,
  registeredAddress: null,
  serviceArea: null,
  outsideServiceArea: false,
  timezone: null,
  slug: 'noor-grocers',
  identifier: { value: '51824753556', display: '51 824 753 556' },
  registerResult: 'matched',
  zoneOptions: [],
};

const business = (f: MyFile) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <BusinessForm file={f} csrfToken="csrf-1" signInEmail="a@b.co" phoneMaxLength={20} />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  call.mockResolvedValue({ ok: true, status: 200, body: { version: 4 } });
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('editing while the submission waits (D3)', () => {
  it('warns on the page and saves an unchanged page without asking', async () => {
    business(file);
    expect(screen.getByText(/If you change anything, your submission is withdrawn/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Save and withdraw your submission?')).toBeNull();
  });

  it('asks before saving a change, and keeps editing without sending', async () => {
    business(file);
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '0411 111 111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(await screen.findByText('Save and withdraw your submission?')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByLabelText<HTMLInputElement>(/Phone/).value).toBe('0411 111 111');
  });

  it('saves after the owner confirms', async () => {
    business(file);
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '0411 111 111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save and withdraw' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
  });

  it('shows no warning and no dialog when nothing waits', async () => {
    business({ ...file, status: 'details-incomplete', submission: null });
    expect(screen.queryByText(/If you change anything/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/Phone/), { target: { value: '0411 111 111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
  });

  it('guards the business number step too', async () => {
    const descriptors = {
      identifier: {
        scheme: 'abn',
        labelKey: 'sellers.business-identifier.abn',
        required: false,
        maxLength: 20,
      },
    } as unknown as FormDescriptors;
    render(
      <NextIntlClientProvider locale="en-AU" messages={messages}>
        <NumberForm file={file} descriptors={descriptors} csrfToken="csrf-1" />
      </NextIntlClientProvider>,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '12 345 678 901' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));
    expect(await screen.findByText('Save and withdraw your submission?')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });
});
