// @vitest-environment jsdom
import { toast, Toaster } from '@mondapac/ui';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { RoleEditor } from '../roles/role-editor.tsx';
import type { RoleCatalogue, RoleRecord } from '../roles/types.ts';
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
    expect(await screen.findByText('Sent for review as SR-42')).toBeTruthy();
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
    expect(await screen.findByText('Sent for review as SR-42')).toBeTruthy();
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

  it('does not ask for a note when creating a role', () => {
    mount(true, false);
    expect(screen.queryByLabelText(NOTE_FIELD)).toBeNull();
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
    expect(await screen.findByText('Sent for review as SR-42')).toBeTruthy();
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
