// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { BlogAccessCard, blogAccessOf } from './blog-access-card.tsx';

const call = vi.mocked(callApi);
const SELLER = '0190a000-0000-7000-8000-000000000009';
const view = (initial: Parameters<typeof BlogAccessCard>[0]['initial'], canView = true) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <BlogAccessCard sellerId={SELLER} csrfToken="tok" initial={initial} canView={canView} />
    </NextIntlClientProvider>,
  );
const toggle = () => screen.getByRole('switch', { name: 'Blog' });

beforeEach(() => call.mockReset());
afterEach(cleanup);

describe('seller blog switch card', () => {
  it('shows the setting as read and when it last changed', () => {
    view({ enabled: true, changedAt: '2026-11-02T01:00:00Z' });
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/Last changed/u)).toBeTruthy();
  });

  it('switches on with PUT and the CSRF token, and shows the answer', async () => {
    view({ enabled: false, changedAt: null });
    expect(screen.getByText('Not changed yet.')).toBeTruthy();
    call.mockResolvedValueOnce({ ok: true, status: 200, body: { enabled: true, changed: true } });
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
    expect(call).toHaveBeenCalledWith(
      'PUT',
      `sellers/admin/${SELLER}/blog-access`,
      { enabled: true },
      'tok',
    );
    expect(screen.getByText('Blog access is now on for this seller.')).toBeTruthy();
    expect(screen.getByText(/Last changed/u)).toBeTruthy();
  });

  it('switches off without touching the live posts unless the box was ticked', async () => {
    view({ enabled: true, changedAt: null });
    call.mockResolvedValueOnce({ ok: true, status: 200, body: { enabled: false, changed: true } });
    fireEvent.click(toggle());
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]![2]).toEqual({ enabled: false });
  });

  it('asks for the live posts to come off the site when the box is ticked first', async () => {
    view({ enabled: true, changedAt: null });
    fireEvent.click(
      screen.getByRole('checkbox', { name: /also take this seller's live posts off/u }),
    );
    call.mockResolvedValueOnce({ ok: true, status: 200, body: { enabled: false, changed: true } });
    fireEvent.click(toggle());
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]![2]).toEqual({ enabled: false, unpublishLive: true });
    await waitFor(() => expect(screen.queryByRole('checkbox')).toBeNull());
  });

  it('says what went wrong, and stays quiet when the code dialog is cancelled', async () => {
    view({ enabled: false, changedAt: null });
    call.mockResolvedValueOnce({ ok: false, failure: { status: 403, code: 'access.denied' } });
    fireEvent.click(toggle());
    expect(await screen.findByText("Your role can't change this setting.")).toBeTruthy();
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    call.mockResolvedValueOnce({ ok: false, failure: { status: 0, code: 'step-up.cancelled' } });
    fireEvent.click(toggle());
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows no switch when the role cannot read it or the read failed', () => {
    view(null, false);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText("You don't have access to this setting.")).toBeTruthy();
    cleanup();
    view(null);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText('The current setting could not be read.')).toBeTruthy();
  });

  it('checks the read before trusting it', () => {
    expect(blogAccessOf({ enabled: true, changedAt: '2026-11-02T01:00:00Z' })).toEqual({
      enabled: true,
      changedAt: '2026-11-02T01:00:00Z',
    });
    expect(blogAccessOf({ enabled: 'yes' })).toBeNull();
    expect(blogAccessOf(null)).toBeNull();
  });
});
