// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { supportProblemOf } from './errors.ts';
import { SupportEmailCard } from './support-email-card.tsx';
import type { SupportContact } from './types.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);
const contact = (email: string | null, version = 0): SupportContact => ({ email, version });
const mount = (initial: SupportContact, canManage = true) =>
  render(wrap(<SupportEmailCard initial={initial} canManage={canManage} csrfToken="csrf" />));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('SupportEmailCard', () => {
  it('says so while no address is set', () => {
    mount(contact(null));
    expect(screen.getByText('No support email is set yet.')).toBeTruthy();
  });

  it('shows the current address, and no form without the manage permission', () => {
    mount(contact('help@example.com'), false);
    expect(screen.getByText('help@example.com')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('saves a trimmed address and shows the answer', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: contact('care@example.com', 1) });
    mount(contact('help@example.com'));
    fireEvent.change(screen.getByLabelText('Support email address'), {
      target: { value: '  care@example.com ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'notifications/admin/support-contact',
      { email: 'care@example.com' },
      'csrf',
    );
    expect(await screen.findByText('Address saved.')).toBeTruthy();
    expect(screen.getByText('care@example.com')).toBeTruthy();
  });

  it('refuses a bad address before calling the API', () => {
    mount(contact('help@example.com'));
    for (const bad of ['', 'plain', 'a@b', 'a@@b.com', 'a b@c.com', 'a@b.com, c@d.com']) {
      fireEvent.change(screen.getByLabelText('Support email address'), {
        target: { value: bad },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save address' }));
      expect(screen.getByText('Enter one valid email address.')).toBeTruthy();
    }
    expect(call).not.toHaveBeenCalled();
  });

  it('shows a refusal and a conflict in words', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 403, code: 'access.denied' } });
    mount(contact('help@example.com'));
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }));
    expect(await screen.findByText('Your role cannot change the support email.')).toBeTruthy();

    call.mockResolvedValue({ ok: false, failure: { status: 409, code: 'notifications.conflict' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }));
    expect(await screen.findByText(/Someone else changed the address first/)).toBeTruthy();
  });
});

describe('supportProblemOf', () => {
  it('names a failed write', () => {
    expect(supportProblemOf({ status: 409, code: 'notifications.conflict' })).toBe('conflict');
    expect(supportProblemOf({ status: 400, code: 'validation.failed' })).toBe('invalid');
    expect(supportProblemOf({ status: 503, code: 'x' })).toBe('unavailable');
    expect(supportProblemOf({ status: 500, code: 'x' })).toBe('unknown');
  });
});
