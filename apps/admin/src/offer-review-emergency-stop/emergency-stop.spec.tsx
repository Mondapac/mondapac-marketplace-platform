// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: () => '/orders' }));
vi.mock('../step-up/step-up.tsx', async () => {
  const api = await import('../api/client.ts');
  return {
    useGuardedCall: () => api.callApi,
    isStepUpCancelled: (result: { ok: boolean; failure?: { code: string } }) =>
      !result.ok && result.failure?.code === 'step-up.cancelled',
  };
});

import { callApi } from '../api/client.ts';
import { EmergencyStopBanner } from './emergency-stop-banner.tsx';
import { EmergencyStopPanel } from './emergency-stop-panel.tsx';
import { emergencyStopOf, type EmergencyStop } from './types.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="Australia/Brisbane">
    {node}
  </NextIntlClientProvider>
);
const OFF: EmergencyStop = { on: false, version: 0, changedAt: null, changedBy: null };
const ON: EmergencyStop = {
  on: true,
  version: 1,
  changedAt: '2026-11-25T06:50:00Z',
  changedBy: 'Leila Admin',
};
const ok = (body: unknown) => ({ ok: true as const, status: 200, body });
const mount = (initial = OFF, canSwitch = true) =>
  render(
    wrap(
      <EmergencyStopPanel
        initial={initial}
        canSwitch={canSwitch}
        csrfToken="csrf"
        zone="Australia/Brisbane"
      />,
    ),
  );

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no modal <dialog>.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('emergency stop answers', () => {
  it('reads the API answer and refuses anything else', () => {
    expect(emergencyStopOf(ON)).toEqual(ON);
    expect(emergencyStopOf({ ...ON, changedBy: '' })).toEqual({ ...ON, changedBy: null });
    expect(emergencyStopOf({ on: 'yes', version: 1 })).toBeNull();
    expect(emergencyStopOf(null)).toBeNull();
  });
});

describe('EmergencyStopPanel', () => {
  it('refuses to switch without a reason and sends nothing', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on emergency stop' }));
    expect(screen.getByText('Enter a reason of up to 500 characters.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('switches on with the reason and the version it saw, then shows who and when', async () => {
    call.mockResolvedValueOnce(ok({ settings: [] }));
    call.mockResolvedValueOnce(ok(ON));
    mount();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: ' Fraud wave ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on emergency stop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on', hidden: true }));
    await waitFor(() =>
      expect(screen.getByText('On: every new offer waits for review')).toBeTruthy(),
    );
    expect(call).toHaveBeenNthCalledWith(
      1,
      'PUT',
      'settings/admin/offer-review/emergency-stop',
      { value: 'on', expectedVersion: 0, note: 'Fraud wave' },
      'csrf',
    );
    expect(screen.getByText(/Last switched by Leila Admin/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Turn off emergency stop' })).toBeTruthy();
  });

  it('reloads and says so when someone switched it first', async () => {
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 409, code: 'settings.conflict' },
    } as never);
    call.mockResolvedValueOnce(ok(ON));
    mount();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on emergency stop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on', hidden: true }));
    await waitFor(() => expect(screen.getByText(/Someone switched it a moment ago/)).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Turn off emergency stop' })).toBeTruthy();
  });

  it('shows the state only to an admin without the permission', () => {
    mount(ON, false);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/Only an admin with the emergency stop permission/)).toBeTruthy();
  });
});

describe('EmergencyStopBanner', () => {
  it('shows nothing while the stop is off or the read fails', async () => {
    call.mockResolvedValueOnce(ok(OFF));
    const { container } = render(wrap(<EmergencyStopBanner zone="Australia/Brisbane" />));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('warns on every page while it is on, with who, when and a link', async () => {
    call.mockResolvedValueOnce(ok(ON));
    render(wrap(<EmergencyStopBanner zone="Australia/Brisbane" />));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByText('Emergency stop is on')).toBeTruthy();
    expect(screen.getByText(/Turned on by Leila Admin/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open emergency stop' }).getAttribute('href')).toBe(
      '/settings/emergency-stop',
    );
  });
});
