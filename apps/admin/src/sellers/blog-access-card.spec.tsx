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
const view = (
  initial: Parameters<typeof BlogAccessCard>[0]['initial'],
  canView = true,
  canEdit = true,
) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <BlogAccessCard
        sellerId={SELLER}
        csrfToken="tok"
        initial={initial}
        canView={canView}
        canEdit={canEdit}
      />
    </NextIntlClientProvider>,
  );
const toggle = () => screen.getByRole('switch', { name: 'Allow this seller to write blog posts' });

beforeEach(() => {
  call.mockReset();
  // jsdom has no modal dialog: open and close the element by its attribute.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
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

  it('asks before switching off and sends nothing until the admin confirms', async () => {
    view({ enabled: true, changedAt: null });
    fireEvent.click(toggle());
    expect(await screen.findByText('Turn off blog posts for this seller?')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(call).not.toHaveBeenCalled();
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });

  it('switches off and leaves the live posts on the site by default', async () => {
    view({ enabled: true, changedAt: null });
    fireEvent.click(toggle());
    call.mockResolvedValueOnce({ ok: true, status: 200, body: { enabled: false, changed: true } });
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]![2]).toEqual({ enabled: false });
    expect(await screen.findByText('Blog access is now off for this seller.')).toBeTruthy();
  });

  it('takes the live posts off the site when that choice is made in the dialog', async () => {
    view({ enabled: true, changedAt: null });
    fireEvent.click(toggle());
    fireEvent.click(await screen.findByRole('radio', { name: /Take them off the site/u }));
    call.mockResolvedValueOnce({ ok: true, status: 200, body: { enabled: false, changed: true } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]![2]).toEqual({ enabled: false, unpublishLive: true });
    expect(await screen.findByText(/live posts were taken off the site/u)).toBeTruthy();
  });

  it('shows the switch locked, with a note, to a role that can only read', () => {
    view({ enabled: true, changedAt: null }, true, false);
    expect((toggle() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('This setting is read-only for your role.')).toBeTruthy();
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
