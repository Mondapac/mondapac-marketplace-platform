// @vitest-environment jsdom
import { toast, Toaster } from '@mondapac/ui';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { RoleEditor } from '../roles/role-editor.tsx';
import type { RoleCatalogue, RoleRecord } from '../roles/types.ts';
import { InviteAdminDialog } from './role-dialog.tsx';
import { RowActions, type RowTarget } from './row-actions.tsx';
import type { PlatformRole } from './types.ts';

const call = vi.mocked(callApi);
const ID = '0190a000-0000-7000-8000-000000000001';
const ok = { allowed: true, code: null };
const request = { id: 'req-1', number: 42 };
const NOTE_FIELD = 'Note for reviewers';
const roles: PlatformRole[] = [
  { roleId: 'r-current', kind: 'default', seedCode: 'viewer', permissionCount: 4, grantable: true },
  {
    roleId: 'r-finance',
    kind: 'default',
    seedCode: 'finance',
    permissionCount: 12,
    grantable: true,
  },
];

function target(status: 'active' | 'disabled'): RowTarget {
  return {
    kind: 'account',
    id: ID,
    name: 'Ada Admin',
    status,
    roleId: 'r-current',
    hints: { changeRole: ok, disable: ok, enable: ok, resetSecondFactor: ok },
  };
}

function wrap(node: React.ReactNode) {
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      {node}
      <Toaster labels={{ region: messages.toast.region, close: messages.toast.close }} />
    </NextIntlClientProvider>,
  );
}
const row = (status: 'active' | 'disabled', reviewed: boolean) =>
  wrap(<RowActions target={target(status)} csrfToken="csrf-1" roles={roles} reviewed={reviewed} />);
const openMenu = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Actions for Ada Admin' }));

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

describe('change role in a reviewed Market', () => {
  const choose = () => {
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change role' }));
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'r-finance' } });
  };

  it('shows no note field when the Market does not review the area', () => {
    row('active', false);
    choose();
    expect(screen.queryByLabelText(NOTE_FIELD)).toBeNull();
  });

  it('sends no note when the Market does not review the area', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { request: null } });
    row('active', false);
    choose();
    fireEvent.click(screen.getByRole('button', { name: 'Change role' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `identity/admin/accounts/${ID}/role`,
        { roleId: 'r-finance' },
        'csrf-1',
      ),
    );
  });

  it('refuses a whitespace-only note', () => {
    row('active', true);
    choose();
    fireEvent.change(screen.getByLabelText(NOTE_FIELD), { target: { value: '   \n ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change role' }));
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByText(/Write a note for the reviewers/)).toBeTruthy();
  });

  it('requires the note and sends nothing without it', () => {
    row('active', true);
    choose();
    fireEvent.click(screen.getByRole('button', { name: 'Change role' }));
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByText(/Write a note for the reviewers/)).toBeTruthy();
  });

  it('sends the trimmed note and announces the request', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { code: 'ok', accountId: ID, roleId: 'r-finance', request },
    });
    row('active', true);
    choose();
    fireEvent.change(screen.getByLabelText(NOTE_FIELD), { target: { value: '  Covers nights  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change role' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `identity/admin/accounts/${ID}/role`,
        { roleId: 'r-finance', note: 'Covers nights' },
        'csrf-1',
      ),
    );
    expect(await screen.findByText('Sent for review (SR-42)')).toBeTruthy();
    expect(screen.getByText(/role is changed/)).toBeTruthy();
  });

  it('shows a 400 on the note inline', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'note' }] },
      },
    } as never);
    row('active', true);
    choose();
    fireEvent.change(screen.getByLabelText(NOTE_FIELD), { target: { value: 'Because' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change role' }));
    expect(await screen.findByText(/The note was refused/)).toBeTruthy();
  });
});

describe('reactivate and deactivate in a reviewed Market', () => {
  it('asks for a note before reactivating, and sends it trimmed', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { code: 'ok', accountId: ID, request },
    });
    row('disabled', true);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reactivate account' }));
    expect(call).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByText(/Write a note for the reviewers/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(NOTE_FIELD), { target: { value: ' Back from leave ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `identity/admin/accounts/${ID}/enable`,
        { note: 'Back from leave' },
        'csrf-1',
      ),
    );
    expect(await screen.findByText('Sent for review (SR-42)')).toBeTruthy();
    expect(screen.getByText(/is active again/)).toBeTruthy();
  });

  it('shows a 400 on the note inline in the reactivate dialog', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'note' }] },
      },
    } as never);
    row('disabled', true);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reactivate account' }));
    fireEvent.change(screen.getByLabelText(NOTE_FIELD), { target: { value: 'Back' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reactivate' }));
    expect(await screen.findByText(/The note was refused/)).toBeTruthy();
  });

  it('reactivates at once, with no note, where the Market does not review', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { request: null } });
    row('disabled', false);
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
  });

  it('never sends a note on a deactivation', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { request: null } });
    row('active', true);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Deactivate account…' }));
    expect(screen.queryByLabelText(NOTE_FIELD)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Deactivate account' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `identity/admin/accounts/${ID}/disable`,
        {},
        'csrf-1',
      ),
    );
  });
});

describe('role editor in a reviewed Market', () => {
  const custom: RoleRecord = {
    roleId: ID,
    kind: 'custom',
    seedCode: null,
    name: 'Night shift',
    permissionCount: 1,
    permissionKeys: ['identity.admin-account.view'],
    grantable: true,
    version: 2,
    actions: { edit: ok, delete: ok },
  };
  const catalogue = (reviewed: boolean): RoleCatalogue => ({
    items: [custom],
    review: { reviewed, risk: 'high' },
    keys: [
      { key: 'identity.admin-account.view', protected: false, grantable: true },
      { key: 'identity.admin-account.invite', protected: false, grantable: true },
    ],
  });
  const mount = (reviewed: boolean, edit = true) =>
    wrap(
      <RoleEditor
        {...(edit ? { role: custom } : {})}
        catalogue={catalogue(reviewed)}
        csrfToken="csrf-1"
        initialName={edit ? 'Night shift' : ''}
        initialKeys={edit ? ['identity.admin-account.view'] : []}
      />,
    );

  it('has no note field when the area is not reviewed, and sends none', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { code: 'ok', roleId: ID } });
    mount(false);
    expect(screen.queryByLabelText(NOTE_FIELD)).toBeNull();
    fireEvent.click(screen.getByLabelText('Invite'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(call.mock.calls[0]?.[2]).not.toHaveProperty('note');
  });

  it('does not demand a note when nothing changed', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 409, code: 'role.unchanged' } });
    mount(true);
    fireEvent.submit(document.querySelector('form')!);
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(screen.queryByText(/Write a note for the reviewers/)).toBeNull();
    expect(call.mock.calls[0]?.[2]).not.toHaveProperty('note');
  });

  it('asks for a note when creating a role, sends it trimmed and announces the review on the new page', async () => {
    const flash = vi.spyOn(toast, 'flash').mockReturnValue(undefined);
    call.mockResolvedValue({
      ok: true,
      status: 201,
      body: { code: 'role.created', roleId: ID, request },
    });
    mount(true, false);
    fireEvent.change(screen.getByLabelText('Role name'), { target: { value: 'Support' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create role' }));
    expect(call).not.toHaveBeenCalled();
    expect(await screen.findByText(/Write a note for the reviewers/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(NOTE_FIELD), { target: { value: ' For support ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create role' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        'identity/admin/roles',
        { name: 'Support', permissionKeys: [], note: 'For support' },
        'csrf-1',
      ),
    );
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/settings/roles/${ID}`));
    expect(flash).toHaveBeenCalledWith('info', 'Sent for review (SR-42)');
    flash.mockRestore();
  });

  it('creates with no note where the area is not reviewed', async () => {
    call.mockResolvedValue({ ok: true, status: 201, body: { code: 'role.created', roleId: ID } });
    mount(false, false);
    expect(screen.queryByLabelText(NOTE_FIELD)).toBeNull();
    fireEvent.change(screen.getByLabelText('Role name'), { target: { value: 'Support' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create role' }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(call.mock.calls[0]?.[2]).not.toHaveProperty('note');
  });

  const askDelete = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Delete role' }));
  };
  /** The dialog's confirm: "Send for approval" where reviewed, "Delete role" otherwise. */
  const confirmDelete = () =>
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: /^(Send for approval|Delete role)$/,
      }),
    );

  it('a delete asks for a note, and on 202 says it was sent for approval and keeps the role', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 202,
      body: { code: 'role.delete-requested', roleId: ID, request },
    });
    mount(true);
    askDelete();
    const dialog = within(screen.getByRole('dialog'));
    // Nothing is deleted until a second admin approves: the dialog says so and asks for approval.
    expect(
      dialog.getByText(/Nothing is deleted yet: another admin must approve this/),
    ).toBeTruthy();
    expect(dialog.queryByText(/can't be undone/)).toBeNull();
    expect(dialog.getByRole('button', { name: 'Send for approval' })).toBeTruthy();
    expect(dialog.queryByRole('button', { name: 'Delete role' })).toBeNull();
    confirmDelete();
    expect(call).not.toHaveBeenCalled();
    expect(await screen.findByText(/Write a note for the reviewers/)).toBeTruthy();
    const deleteNote = within(screen.getByRole('dialog')).getByLabelText(NOTE_FIELD);
    fireEvent.change(deleteNote, { target: { value: ' Not used ' } });
    confirmDelete();
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'DELETE',
        `identity/admin/roles/${ID}`,
        { expectedVersion: 2, note: 'Not used' },
        'csrf-1',
      ),
    );
    expect(await screen.findByText('Sent for approval (SR-42)')).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
    expect(router.refresh).toHaveBeenCalled();
  });

  it('says which request a delete already waits on (409)', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 409,
        code: 'system-requests.already-pending',
        details: { pendingNumber: 7 },
      },
    });
    mount(true);
    askDelete();
    fireEvent.change(within(screen.getByRole('dialog')).getByLabelText(NOTE_FIELD), {
      target: { value: 'Again' },
    });
    confirmDelete();
    expect(await screen.findByText('This is already waiting for approval (SR-7).')).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('deletes at once, with no note, where the area is not reviewed', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { code: 'role.deleted', roleId: ID, request: null },
    });
    mount(false);
    askDelete();
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.queryByLabelText(NOTE_FIELD)).toBeNull();
    expect(dialog.getByText(/This can't be undone/)).toBeTruthy();
    expect(dialog.queryByRole('button', { name: 'Send for approval' })).toBeNull();
    confirmDelete();
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/settings/roles'));
    expect(call.mock.calls[0]?.[2]).toEqual({ expectedVersion: 2 });
  });

  it('requires the note, then sends it trimmed and announces the request', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { code: 'ok', roleId: ID, request },
    });
    mount(true);
    fireEvent.click(screen.getByLabelText('Invite'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(call).not.toHaveBeenCalled();
    expect(await screen.findByText(/Write a note for the reviewers/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(NOTE_FIELD), { target: { value: ' Needs invites ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'PUT',
        `identity/admin/roles/${ID}`,
        expect.objectContaining({ expectedVersion: 2, note: 'Needs invites' }),
        'csrf-1',
      ),
    );
    expect(await screen.findByText('Sent for review (SR-42)')).toBeTruthy();
    expect(screen.getByText(/Saved\./)).toBeTruthy();
  });

  it('shows a 400 on the note inline', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'note' }] },
      },
    } as never);
    mount(true);
    fireEvent.click(screen.getByLabelText('Invite'));
    fireEvent.change(screen.getByLabelText(NOTE_FIELD), { target: { value: 'Because' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findAllByText(/The note was refused/)).not.toHaveLength(0);
  });
});

describe('invite an admin in a reviewed Market', () => {
  const dialog = (reviewed: boolean) =>
    wrap(
      <InviteAdminDialog
        open
        onClose={() => undefined}
        roles={roles}
        csrfToken="csrf-1"
        reviewed={reviewed}
      />,
    );
  const fill = () => {
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'r-finance' } });
  };

  it('requires the note, then sends it trimmed and announces the request', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 201,
      body: { code: 'invitation.issued', invitationId: ID, request },
    });
    dialog(true);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(call).not.toHaveBeenCalled();
    expect(await screen.findByText(/Write a note for the reviewers/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(NOTE_FIELD), { target: { value: ' Joins support ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        'identity/admin/invitations',
        { email: 'new@example.com', roleId: 'r-finance', note: 'Joins support' },
        'csrf-1',
      ),
    );
    expect(await screen.findByText('Sent for review (SR-42)')).toBeTruthy();
  });

  it('shows a 400 on the note inline', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 400, code: 'validation.failed', details: { fields: [{ path: 'note' }] } },
    } as never);
    dialog(true);
    fill();
    fireEvent.change(screen.getByLabelText(NOTE_FIELD), { target: { value: 'Because' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    expect(await screen.findAllByText(/The note was refused/)).not.toHaveLength(0);
  });

  it('has no note field and sends none where the Market does not review', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 201,
      body: { code: 'invitation.issued', invitationId: ID, request: null },
    });
    dialog(false);
    expect(screen.queryByLabelText(NOTE_FIELD)).toBeNull();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(call.mock.calls[0]?.[2]).toEqual({ email: 'new@example.com', roleId: 'r-finance' });
  });
});

describe('invite with a sensitive role: it waits for approval (owner decision of 18 Nov 2026)', () => {
  const withSensitive: PlatformRole[] = [
    ...roles,
    {
      roleId: 'r-admin',
      kind: 'system',
      seedCode: 'platform-administrator',
      permissionCount: 90,
      grantable: true,
      sensitive: true,
    },
  ];
  const APPROVAL_TEXT = /another admin must approve the invitation/;
  const dialog = (reviewed: boolean) =>
    wrap(
      <InviteAdminDialog
        open
        onClose={() => undefined}
        roles={withSensitive}
        csrfToken="csrf-1"
        reviewed={reviewed}
      />,
    );
  const fill = (roleId: string) => {
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@example.com' } });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: roleId } });
  };

  it('says it waits for approval, asks "Send for approval", and on 202 announces the request only', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 202,
      body: { code: 'invitation.proposed', invitationId: ID, request },
    });
    dialog(true);
    fill('r-admin');
    expect(screen.getByText(APPROVAL_TEXT)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send invitation' })).toBeNull();
    fireEvent.change(screen.getByLabelText(NOTE_FIELD), {
      target: { value: ' Second administrator ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send for approval' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        'identity/admin/invitations',
        { email: 'new@example.com', roleId: 'r-admin', note: 'Second administrator' },
        'csrf-1',
      ),
    );
    expect(await screen.findByText('Sent for approval (SR-42)')).toBeTruthy();
    // Nothing was sent: no "Invitation sent" toast, no review toast.
    expect(screen.queryByText(/Invitation sent to/)).toBeNull();
    expect(screen.queryByText(/Sent for review/)).toBeNull();
  });

  it('keeps "Send invitation" and no approval text for a role that is not sensitive', () => {
    dialog(true);
    fill('r-finance');
    expect(screen.queryByText(APPROVAL_TEXT)).toBeNull();
    expect(screen.getByRole('button', { name: 'Send invitation' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send for approval' })).toBeNull();
  });

  it('invites at once where the Market does not review people, even for a sensitive role', () => {
    dialog(false);
    fill('r-admin');
    expect(screen.queryByText(APPROVAL_TEXT)).toBeNull();
    expect(screen.getByRole('button', { name: 'Send invitation' })).toBeTruthy();
  });

  it('says which request it already waits on (409)', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 409,
        code: 'system-requests.already-pending',
        details: { pendingNumber: 7 },
      },
    } as never);
    dialog(true);
    fill('r-admin');
    fireEvent.change(screen.getByLabelText(NOTE_FIELD), { target: { value: 'Again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send for approval' }));
    expect(await screen.findByText('This is already waiting for approval (SR-7).')).toBeTruthy();
  });
});
