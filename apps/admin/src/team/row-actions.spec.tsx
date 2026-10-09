// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { NoticeProvider } from './notice.tsx';
import { RowActions, type RowTarget } from './row-actions.tsx';

const call = vi.mocked(callApi);
const ID = '0190a000-0000-7000-8000-000000000001';
const ok = { allowed: true, code: null };

const account = (over: Partial<Extract<RowTarget, { kind: 'account' }>> = {}): RowTarget => ({
  kind: 'account',
  id: ID,
  name: 'Ada Admin',
  status: 'active',
  hints: { disable: ok, enable: ok, resetSecondFactor: ok },
  ...over,
});

function show(target: RowTarget) {
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <NoticeProvider>
        <RowActions target={target} csrfToken="csrf-1" />
      </NoticeProvider>
    </NextIntlClientProvider>,
  );
}
const openMenu = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Ada Admin' }));

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

describe('team row actions', () => {
  it('offers reset and deactivate on an active admin, with the csrf token on the command', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: {} });
    show(account());
    openMenu();
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Reset two-step verification…',
      'Deactivate account…',
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Deactivate account…' }));
    expect(screen.getByRole('dialog').textContent).toContain(
      "Deactivate Ada Admin's admin account?",
    );
    expect(call).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate account' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `identity/admin/accounts/${ID}/disable`,
        {},
        'csrf-1',
      ),
    );
    expect(await screen.findByText(/is deactivated\. They've been signed out/)).toBeTruthy();
    expect(router.refresh).toHaveBeenCalled();
  });

  it('reactivates at once, with no dialog', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: {} });
    show(account({ status: 'disabled' }));
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reactivate account' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `identity/admin/accounts/${ID}/enable`,
        {},
        'csrf-1',
      ),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      await screen.findByText("Ada Admin's account is active again. They can sign in."),
    ).toBeTruthy();
  });

  it('keeps a forbidden action visible, disabled, with the reason, and never sends it', () => {
    show(
      account({
        hints: {
          disable: { allowed: false, code: 'member.self' },
          enable: ok,
          resetSecondFactor: { allowed: false, code: 'member.last-holder' },
        },
      }),
    );
    openMenu();
    const items = screen.getAllByRole('menuitem');
    expect(items.every((i) => i.getAttribute('aria-disabled') === 'true')).toBe(true);
    expect(screen.getByText("You can't do this to your own account.")).toBeTruthy();
    expect(screen.getByText('At least one Platform Administrator must remain.')).toBeTruthy();
    fireEvent.click(items[1]!);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('shows a refusal inside the dialog and leaves it open', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 403, code: 'member.outranks-actor' } });
    show(account());
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reset two-step verification…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(await screen.findByText("This person has permissions you don't have.")).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('closes, says so and refreshes when the row changed meanwhile', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 409, code: 'conflict.stale' } });
    show(account());
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Deactivate account…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate account' }));
    expect(
      await screen.findByText("Someone has just changed this. We've refreshed it."),
    ).toBeTruthy();
    expect(router.refresh).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('sends a rejected session to the session-ended page', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 401, code: 'session.invalid' } });
    show(account({ status: 'disabled' }));
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reactivate account' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/session-ended'));
  });

  it('resends an invitation at once and cancels it after a confirmation', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: {} });
    show({
      kind: 'invitation',
      id: ID,
      name: 'new@example.test',
      hints: { resend: ok, revoke: ok },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Actions for new@example.test' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resend invitation' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `identity/admin/invitations/${ID}/resend`,
        {},
        'csrf-1',
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Actions for new@example.test' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel invitation…' }));
    expect(screen.getByRole('dialog').textContent).toContain(
      'Cancel the invitation to new@example.test?',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Keep as it is' }));
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('closes the menu with Escape and returns focus to its button', () => {
    show(account());
    openMenu();
    fireEvent.keyDown(screen.getAllByRole('menuitem')[0]!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Actions for Ada Admin' }),
    );
  });
});
