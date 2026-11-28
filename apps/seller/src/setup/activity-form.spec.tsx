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
import { ActivityForm, activityName } from './activity-form.tsx';
import { SetupHub } from './setup-hub.tsx';
import type { ActivityChoice, MyFile } from './types.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);

const file = {
  version: 1,
  status: 'details-incomplete',
  submission: null,
  latestWithdrawal: null,
  draftComplete: false,
  missing: ['storeName'],
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
} as unknown as MyFile;

const choices: ActivityChoice[] = [
  { id: 'a1', code: 'butcher', names: { 'en-AU': 'Butcher', fa: 'قصاب' } },
  { id: 'a2', code: 'grocery', names: { 'en-AU': 'Grocery' } },
  { id: 'a3', code: 'bakery', names: { fa: 'نانوایی' } },
];

const form = (initialMain: string | null = null, initialExtras: string[] = []) =>
  wrap(
    <ActivityForm
      file={file}
      csrfToken="csrf"
      choices={choices}
      locale="en-AU"
      defaultLocale="en-AU"
      initialMain={initialMain}
      initialExtras={initialExtras}
    />,
  );

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('activityName', () => {
  it('uses the seller language, then the default, then any name, then the code', () => {
    expect(activityName(choices[0]!, 'fa', 'en-AU')).toBe('قصاب');
    expect(activityName(choices[1]!, 'fa', 'en-AU')).toBe('Grocery');
    expect(activityName(choices[2]!, 'en-AU', 'en-AU')).toBe('نانوایی');
    expect(activityName({ id: 'x', code: 'code-only', names: {} }, 'en-AU', 'en-AU')).toBe(
      'code-only',
    );
  });
});

describe('ActivityForm', () => {
  it('saves the saved choice as a request and goes to the next step', async () => {
    call.mockResolvedValue({ ok: true, body: { changed: true } } as never);
    render(form('a1', ['a2']));
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/account-setup/address'));
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'sellers/my-file/activities',
      { mainActivityId: 'a1', extraActivityIds: ['a2'] },
      expect.anything(),
    );
  });

  it('never sends the main activity among the extras', async () => {
    call.mockResolvedValue({ ok: true, body: { changed: true } } as never);
    render(form('a1', ['a1', 'a2']));
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(call.mock.calls[0]?.[2]).toEqual({ mainActivityId: 'a1', extraActivityIds: ['a2'] });
  });

  it('continues without a request when nothing was chosen', () => {
    render(form());
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(call).not.toHaveBeenCalled();
    expect(router.push).toHaveBeenCalledWith('/account-setup/address');
  });

  it('tells a no longer available choice on the main field and keeps the page', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'mainActivityId', code: 'not-active' }] },
      },
    } as never);
    render(form('a1'));
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(
      await screen.findByText('This choice is no longer available. Choose another.'),
    ).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('says so when the Market has no activity yet, and still lets the seller continue', () => {
    render(
      wrap(
        <ActivityForm
          file={file}
          csrfToken="csrf"
          choices={[]}
          locale="en-AU"
          defaultLocale="en-AU"
          initialMain={null}
          initialExtras={[]}
        />,
      ),
    );
    expect(screen.getByText(/No business activities are available yet/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save and continue' })).toBeTruthy();
  });
});

describe('SetupHub activity row', () => {
  it('shows the step as to do, then done once a choice exists', () => {
    const { rerender } = render(wrap(<SetupHub file={file} csrfToken="csrf" />));
    expect(screen.getByText('What you sell')).toBeTruthy();
    expect(screen.getByText('Tell us what your business sells.')).toBeTruthy();
    rerender(wrap(<SetupHub file={file} csrfToken="csrf" activityChosen />));
    expect(screen.queryByText('Tell us what your business sells.')).toBeNull();
  });
});
