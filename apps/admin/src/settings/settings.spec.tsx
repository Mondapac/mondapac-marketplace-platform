// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from '@mondapac/ui';
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

const type = (value: string) =>
  fireEvent.change(screen.getByLabelText('Support email address'), { target: { value } });

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
    expect(screen.getByText(/you need the "Support email: manage" permission/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByLabelText('Support email address')).toBeNull();
  });

  it('shows the save bar only for a changed address, and Discard restores it', () => {
    mount(contact('help@example.com'));
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    type('care@example.com');
    expect(screen.getByText('1 unsaved change')).toBeTruthy();
    expect(screen.getByLabelText('Support email address').className).toContain(
      'border-attention-solid',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByLabelText<HTMLInputElement>('Support email address').value).toBe(
      'help@example.com',
    );
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
  });

  it('saves a trimmed address and shows the answer', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: contact('care@example.com', 1) });
    const success = vi.spyOn(toast, 'success').mockReturnValue('toast');
    mount(contact('help@example.com'));
    fireEvent.change(screen.getByLabelText('Support email address'), {
      target: { value: '  care@example.com ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'PUT',
      'notifications/admin/support-contact',
      { email: 'care@example.com', expectedVersion: 0 },
      'csrf',
    );
    await waitFor(() => expect(success).toHaveBeenCalledWith('Address saved.'));
    expect(screen.getByText('care@example.com')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
  });

  it('refuses a bad address before calling the API', () => {
    mount(contact('help@example.com'));
    for (const bad of [
      '',
      'plain',
      'a@b',
      'a@@b.com',
      'a b@c.com',
      'a@b.com, c@d.com',
      'su\u0070p\u043ert@x.com',
      'a?b=1@x.com',
    ]) {
      type(bad);
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      expect(screen.getByText('Enter one valid email address.')).toBeTruthy();
      // The error is counted, and Save waits until the field is edited.
      expect(screen.getByText(/1 needs fixing/)).toBeTruthy();
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save changes' }).disabled).toBe(
        true,
      );
    }
    expect(call).not.toHaveBeenCalled();
  });

  it('shows a refusal and a conflict in words', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 403, code: 'access.denied' } });
    mount(contact('help@example.com'));
    type('care@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Your role cannot change the support email.')).toBeTruthy();

    call.mockResolvedValue({ ok: false, failure: { status: 409, code: 'notifications.conflict' } });
    type('care2@example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
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
