// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast, Toaster, visibleNavItems } from '@mondapac/ui';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { sellerNav } from '../nav.ts';
import { StepUpProvider } from '../step-up/step-up.tsx';
import { InviteMemberButton } from './invite-member-button.tsx';
import { RowActions, type RowTarget } from './row-actions.tsx';
import type { SellerRole } from './types.ts';

const call = vi.mocked(callApi);
const ID = '0190a000-0000-7000-8000-000000000001';
const ok = { allowed: true, code: null };
const roles: SellerRole[] = [
  {
    roleId: 'r-current',
    kind: 'default',
    seedCode: 'bookkeeper',
    name: null,
    permissionCount: 4,
    grantable: true,
  },
  {
    roleId: 'r-stock',
    kind: 'default',
    seedCode: 'catalogue-stock',
    name: null,
    permissionCount: 8,
    grantable: true,
  },
  {
    roleId: 'r-custom',
    kind: 'custom',
    seedCode: null,
    name: 'Packers',
    permissionCount: 2,
    grantable: true,
  },
  {
    roleId: 'r-owner',
    kind: 'system',
    seedCode: 'seller-owner',
    name: null,
    permissionCount: 40,
    grantable: false,
  },
];

function wrap(node: React.ReactNode) {
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <StepUpProvider>
        {node}
        <Toaster labels={{ region: messages.toast.region, close: messages.toast.close }} />
      </StepUpProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(() => {
  cleanup();
  toast.dismiss();
});

const member = (hints?: Partial<Extract<RowTarget, { kind: 'account' }>['hints']>): RowTarget => ({
  kind: 'account',
  id: ID,
  name: 'Sam Seller',
  roleId: 'r-current',
  hints: { changeRole: ok, remove: ok, ...hints },
});
const invitation = (
  hints?: Partial<Extract<RowTarget, { kind: 'invitation' }>['hints']>,
): RowTarget => ({
  kind: 'invitation',
  id: ID,
  name: 'new@example.test',
  hints: { resend: ok, revoke: ok, ...hints },
});
const show = (target: RowTarget, roleList: readonly SellerRole[] | null = roles) =>
  wrap(<RowActions target={target} csrfToken="csrf-1" roles={roleList ?? undefined} />);
const openMenu = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const openMember = () => openMenu('Actions for Sam Seller');

const refused = (status: number, code: string, details?: object) => ({
  ok: false as const,
  failure: { status, code, ...(details ? { details } : {}) },
});

describe('change role', () => {
  const choose = () => {
    show(member());
    openMember();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change role' }));
  };

  it('offers only grantable roles, without the current one', () => {
    choose();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Choose a role',
      'Catalogue and Stock · 8 permissions',
      'Packers · 2 permissions',
    ]);
    expect(screen.getByText('Current role: Bookkeeper')).toBeTruthy();
  });

  it('sends the chosen role with the csrf token and says when it applies', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: {} });
    choose();
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'r-stock' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change role' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `identity/seller/team/accounts/${ID}/role`,
        { roleId: 'r-stock' },
        'csrf-1',
      ),
    );
    expect(
      await screen.findByText(/role is changed\. It applies from their next action/),
    ).toBeTruthy();
    expect(router.refresh).toHaveBeenCalled();
  });

  it('asks for a role first and sends nothing', () => {
    choose();
    fireEvent.click(screen.getByRole('button', { name: 'Change role' }));
    expect(screen.getByText('Choose a role.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('keeps the dialog open on a refusal and closes and reloads when the role vanished', async () => {
    call.mockResolvedValueOnce(refused(403, 'role.not-grantable'));
    choose();
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'r-stock' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change role' }));
    expect(await screen.findByText("You can't give that role.")).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
    call.mockResolvedValueOnce(refused(404, 'role.unknown'));
    fireEvent.click(screen.getByRole('button', { name: 'Change role' }));
    expect(await screen.findByText(/That role no longer exists/)).toBeTruthy();
    expect(router.refresh).toHaveBeenCalled();
  });

  it('is left out without a role list', () => {
    show(member(), null);
    openMember();
    expect(screen.queryByRole('menuitem', { name: 'Change role' })).toBeNull();
  });

  it('asks for a two-step code when the rule needs one, then changes the role', async () => {
    call
      .mockResolvedValueOnce(
        refused(403, 'second-factor.required', { actionKey: 'identity.team.change-role' }),
      )
      .mockResolvedValueOnce({ ok: true, status: 200, body: { code: 'step-up-verified' } })
      .mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    choose();
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'r-stock' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change role' }));
    const dialog = await screen.findByRole('dialog', { name: 'Enter your 6-digit code' });
    expect(dialog.textContent).toContain("Changing a team member's role");
    fireEvent.paste(screen.getAllByRole('textbox', { name: /Digit \d of 6/ })[0] as HTMLElement, {
      clipboardData: { getData: () => '654321' },
    });
    await waitFor(() => expect(call).toHaveBeenCalledTimes(3));
    expect(call).toHaveBeenLastCalledWith(
      'POST',
      `identity/seller/team/accounts/${ID}/role`,
      { roleId: 'r-stock' },
      'csrf-1',
    );
    expect(router.refresh).toHaveBeenCalled();
  });

  it('goes to the signed-out page on a 401', async () => {
    call.mockResolvedValue(refused(401, 'session.invalid'));
    choose();
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'r-stock' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change role' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/session-ended'));
  });
});

describe('remove a member', () => {
  const confirm = () => {
    show(member());
    openMember();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from team…' }));
  };

  it('asks first, sends an empty body and says so', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: {} });
    confirm();
    expect(screen.getByRole('dialog', { name: 'Remove Sam Seller from the team?' })).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove from team' }).className).toContain(
      'text-critical-fg',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove from team' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `identity/seller/team/accounts/${ID}/remove`,
        {},
        'csrf-1',
      ),
    );
    expect(await screen.findByText(/Sam Seller is removed from the team/)).toBeTruthy();
    expect(router.refresh).toHaveBeenCalled();
  });

  it.each([
    [409, 'member.last-holder', 'At least one Seller Owner must remain.'],
    [403, 'access.denied', "Your role doesn't include this."],
    [403, 'member.self', "You can't do this to your own account."],
  ])('shows %s %s in the dialog', async (status, code, text) => {
    call.mockResolvedValue(refused(status, code));
    confirm();
    fireEvent.click(screen.getByRole('button', { name: 'Remove from team' }));
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keep as it is' })).toBeTruthy();
  });

  it('closes, says so and reloads when the person is already gone', async () => {
    call.mockResolvedValue(refused(404, 'account.unknown'));
    confirm();
    fireEvent.click(screen.getByRole('button', { name: 'Remove from team' }));
    expect(await screen.findByText(/no longer on the team/)).toBeTruthy();
    expect(router.refresh).toHaveBeenCalled();
  });

  it('asks for a two-step code when the rule needs one, then removes', async () => {
    call
      .mockResolvedValueOnce(
        refused(403, 'second-factor.required', { actionKey: 'identity.team.invite-remove' }),
      )
      .mockResolvedValueOnce({ ok: true, status: 200, body: { code: 'step-up-verified' } })
      .mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    confirm();
    fireEvent.click(screen.getByRole('button', { name: 'Remove from team' }));
    await screen.findByRole('dialog', { name: 'Enter your 6-digit code' });
    fireEvent.paste(screen.getAllByRole('textbox', { name: /Digit \d of 6/ })[0] as HTMLElement, {
      clipboardData: { getData: () => '123456' },
    });
    expect(await screen.findByText(/Sam Seller is removed from the team/)).toBeTruthy();
    expect(call).toHaveBeenNthCalledWith(
      2,
      'POST',
      'identity/seller/step-up/verify',
      { actionKey: 'identity.team.invite-remove', code: '123456' },
      'csrf-1',
    );
    expect(call).toHaveBeenNthCalledWith(
      3,
      'POST',
      `identity/seller/team/accounts/${ID}/remove`,
      {},
      'csrf-1',
    );
  });

  it('keeps the confirmation as it was when the code dialog is closed', async () => {
    call.mockResolvedValueOnce(
      refused(403, 'second-factor.required', { actionKey: 'identity.team.invite-remove' }),
    );
    confirm();
    fireEvent.click(screen.getByRole('button', { name: 'Remove from team' }));
    await screen.findByRole('dialog', { name: 'Enter your 6-digit code' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Enter your 6-digit code' })).toBeNull(),
    );
    expect(screen.getByRole('dialog', { name: 'Remove Sam Seller from the team?' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when dismissed', () => {
    confirm();
    fireEvent.click(screen.getByRole('button', { name: 'Keep as it is' }));
    expect(call).not.toHaveBeenCalled();
  });

  it('disables an action the hint refuses, with its reason', () => {
    show(member({ remove: { allowed: false, code: 'member.last-holder' } }));
    openMember();
    const item = screen.getByRole('menuitem', { name: /Remove from team/ });
    expect(item.getAttribute('aria-disabled') ?? String(item.hasAttribute('disabled'))).toBe(
      'true',
    );
    expect(screen.getByText('At least one Seller Owner must remain.')).toBeTruthy();
  });
});

describe('invitation rows', () => {
  const menu = 'Actions for new@example.test';

  it('resends at once and says so', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: {} });
    show(invitation());
    openMenu(menu);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resend invitation' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `identity/seller/team/invitations/${ID}/resend`,
        {},
        'csrf-1',
      ),
    );
    expect(await screen.findByText('Invitation sent again to new@example.test.')).toBeTruthy();
  });

  it('shows the wait of a throttled resend as a notice', async () => {
    call.mockResolvedValue(refused(429, 'request.throttled', { retryAfterSeconds: 130 }));
    show(invitation());
    openMenu(menu);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resend invitation' }));
    expect(
      await screen.findByText('Too many invitations sent. Try again in 3 minutes.'),
    ).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('confirms before cancelling and posts to revoke', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: {} });
    show(invitation());
    openMenu(menu);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel invitation…' }));
    expect(call).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel invitation' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `identity/seller/team/invitations/${ID}/revoke`,
        {},
        'csrf-1',
      ),
    );
    expect(await screen.findByText('Invitation to new@example.test cancelled.')).toBeTruthy();
  });

  it('reloads when the invitation changed meanwhile', async () => {
    call.mockResolvedValue(refused(409, 'invitation.rejected'));
    show(invitation());
    openMenu(menu);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resend invitation' }));
    expect(await screen.findByText(/can't be sent again/)).toBeTruthy();
    expect(router.refresh).toHaveBeenCalled();
  });

  it('sends a resend once when selected twice before the answer', () => {
    call.mockReturnValue(new Promise(() => undefined));
    show(invitation());
    openMenu(menu);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resend invitation' }));
    openMenu(menu);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Resend invitation' }));
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe('invite a team member', () => {
  const open = () => {
    wrap(<InviteMemberButton roles={roles} csrfToken="csrf-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Invite team member' }));
  };
  const fill = () => {
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: ' new@example.test ' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'r-stock' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
  };

  it('offers only the roles the actor may give', () => {
    open();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Choose a role',
      'Bookkeeper · 4 permissions',
      'Catalogue and Stock · 8 permissions',
      'Packers · 2 permissions',
    ]);
  });

  it('sends the address and role and shows the toast', async () => {
    call.mockResolvedValue({ ok: true, status: 201, body: { code: 'invitation.issued' } });
    open();
    fill();
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        'identity/seller/team/invitations',
        { email: 'new@example.test', roleId: 'r-stock' },
        'csrf-1',
      ),
    );
    expect(await screen.findByText('Invitation sent to new@example.test.')).toBeTruthy();
  });

  it('checks the fields before sending', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(screen.getByText('Enter your email.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(screen.getByText('Choose a role.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it.each([
    [
      409,
      'invitation.already-pending',
      'This person already has an invitation. Resend it from the list.',
    ],
    [
      409,
      'member.limit',
      'Your team has reached its limit. Remove a member or cancel an invitation first.',
    ],
    [403, 'role.not-grantable', "You can't give that role."],
    [403, 'access.denied', "Your role doesn't include this."],
  ])('shows %s %s in the dialog', async (status, code, text) => {
    call.mockResolvedValue(refused(status, code));
    open();
    fill();
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Email').value).toBe('new@example.test');
  });

  it('shows the wait of a throttled invitation', async () => {
    call.mockResolvedValue(refused(429, 'request.throttled', { retryAfterSeconds: 45 }));
    open();
    fill();
    expect(
      await screen.findByText('Too many invitations sent. Try again in 1 minute.'),
    ).toBeTruthy();
  });

  it('shows an email format error from the API', async () => {
    call.mockResolvedValue(
      refused(400, 'validation.failed', { fields: [{ path: 'email', code: 'format' }] }),
    );
    open();
    fill();
    expect(await screen.findByText('Enter an email address like name@example.com.')).toBeTruthy();
  });
});

describe('team nav', () => {
  it('shows Settings (the way to the team) only with the team view key among the settings keys', () => {
    const ids = (keys: string[]) => visibleNavItems(sellerNav, new Set(keys)).map((i) => i.id);
    expect(ids([])).not.toContain('s_settings');
    expect(ids(['identity.team-member.view'])).toContain('s_settings');
    expect(ids(['identity.team-member.view'])).not.toContain('s_team');
  });
});
