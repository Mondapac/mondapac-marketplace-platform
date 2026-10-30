// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

const router = { replace: vi.fn(), push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { RoleEditor } from './role-editor.tsx';
import type { RoleCatalogue, RoleRecord } from './types.ts';
import { expectFlash, expectToast } from '../../test/toast-spy.ts';

const call = vi.mocked(callApi);
const ID = '0190a000-0000-7000-8000-0000000000a3';
const allowed = { allowed: true, code: null };
const catalogue: RoleCatalogue = {
  items: [],
  keys: [
    { key: 'identity.admin-account.view', protected: false, grantable: true },
    { key: 'identity.admin-account.invite', protected: false, grantable: true },
    { key: 'identity.platform-role.manage', protected: true, grantable: false },
  ],
};
const custom: RoleRecord = {
  roleId: ID,
  kind: 'custom',
  seedCode: null,
  name: 'Night shift',
  permissionCount: 1,
  permissionKeys: ['identity.admin-account.view'],
  grantable: true,
  version: 2,
  actions: { edit: allowed, delete: allowed },
};

function mount(props: Partial<React.ComponentProps<typeof RoleEditor>> = {}) {
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <RoleEditor
        catalogue={catalogue}
        csrfToken="csrf-1"
        initialName=""
        initialKeys={[]}
        {...props}
      />
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
afterEach(cleanup);

describe('role editor', () => {
  it('creates a role with the chosen keys and opens it', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 201,
      body: { code: 'role.created', roleId: ID },
    });
    mount();
    fireEvent.change(screen.getByLabelText('Role name'), { target: { value: '  Night shift ' } });
    fireEvent.click(screen.getByLabelText('Invite'));
    fireEvent.click(screen.getByRole('button', { name: 'Create role' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/settings/roles/${ID}`));
    // The outcome waits for the page of the new role; nothing is announced here.
    expectFlash('Saved. People with this role see the change now.');
    expect(call).toHaveBeenCalledWith(
      'POST',
      'identity/admin/roles',
      { name: 'Night shift', permissionKeys: ['identity.admin-account.invite'] },
      'csrf-1',
    );
  });

  it('asks for a name before calling the API', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Create role' }));
    expect(await screen.findByText('Enter a name for the role.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('shows a key the admin may not give as locked, and a protected one with its note', () => {
    mount();
    const locked = screen.getByLabelText<HTMLInputElement>('Manage');
    expect(locked.disabled).toBe(true);
    expect(
      screen.getByText('Protected. Only a Platform Administrator can give this.'),
    ).toBeTruthy();
  });

  it('saves an edit with PUT and shows the saved status', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'role.updated', roleId: ID },
    });
    mount({ role: custom, initialName: 'Night shift', initialKeys: custom.permissionKeys });
    expect(screen.getByLabelText<HTMLInputElement>('View').checked).toBe(true);
    fireEvent.click(screen.getByLabelText('Invite'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await expectToast(/Saved\./);
    expect(call).toHaveBeenCalledWith(
      'PUT',
      `identity/admin/roles/${ID}`,
      {
        name: 'Night shift',
        permissionKeys: ['identity.admin-account.invite', 'identity.admin-account.view'],
        expectedVersion: 2,
      },
      'csrf-1',
    );
    expect(router.refresh).toHaveBeenCalled();
  });

  it('on a stale save keeps the draft, shows the conflict banner, and the next save sends the new version', async () => {
    const saved: RoleRecord = {
      ...custom,
      name: 'Night shift (renamed)',
      permissionKeys: ['identity.admin-account.view', 'identity.admin-account.invite'],
      version: 3,
    };
    call
      .mockResolvedValueOnce({ ok: false, failure: { status: 409, code: 'conflict.stale' } })
      .mockResolvedValueOnce({ ok: true, status: 200, body: { ...catalogue, items: [saved] } })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: { code: 'role.updated', roleId: ID },
      });
    mount({ role: custom, initialName: 'Night shift', initialKeys: custom.permissionKeys });
    fireEvent.change(screen.getByLabelText('Role name'), { target: { value: 'My draft name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Someone saved this role first')).toBeTruthy();
    // The role is read again, the page is not refreshed (that would drop the draft).
    expect(call).toHaveBeenNthCalledWith(2, 'GET', 'identity/admin/roles');
    expect(router.refresh).not.toHaveBeenCalled();
    expect(screen.getByLabelText<HTMLInputElement>('Role name').value).toBe('My draft name');
    expect(screen.getByLabelText<HTMLInputElement>('View').checked).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    expect(
      screen.getByText('Saved name: Night shift (renamed). Your name: My draft name.'),
    ).toBeTruthy();
    expect(screen.getByText('In the saved role but not in yours: Invite.')).toBeTruthy();
    expect(screen.getByText('Every permission in yours is in the saved role.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(3));
    expect(call).toHaveBeenNthCalledWith(
      3,
      'PUT',
      `identity/admin/roles/${ID}`,
      {
        name: 'My draft name',
        permissionKeys: ['identity.admin-account.view'],
        expectedVersion: 3,
      },
      'csrf-1',
    );
    await waitFor(() => expect(screen.queryByText('Someone saved this role first')).toBeNull());
  });

  it('on a stale delete closes the dialog, keeps the draft and shows the conflict banner', async () => {
    call
      .mockResolvedValueOnce({ ok: false, failure: { status: 409, code: 'conflict.stale' } })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: { ...catalogue, items: [{ ...custom, version: 5 }] },
      });
    mount({ role: custom, initialName: 'Night shift', initialKeys: custom.permissionKeys });
    fireEvent.change(screen.getByLabelText('Role name'), { target: { value: 'Kept text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete role' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete role' }).at(-1)!);

    expect(await screen.findByText('Someone saved this role first')).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(screen.getByLabelText<HTMLInputElement>('Role name').value).toBe('Kept text');
  });

  it('a stale save of a role that is gone refreshes the page instead of showing a banner', async () => {
    call
      .mockResolvedValueOnce({ ok: false, failure: { status: 409, code: 'conflict.stale' } })
      .mockResolvedValueOnce({ ok: true, status: 200, body: { ...catalogue, items: [] } });
    mount({ role: custom, initialName: 'Night shift', initialKeys: custom.permissionKeys });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(screen.queryByText('Someone saved this role first')).toBeNull();
  });

  it('puts a taken name on the name field', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 409, code: 'role.name-taken' } });
    mount({ initialName: 'Ops' });
    fireEvent.click(screen.getByRole('button', { name: 'Create role' }));
    expect(await screen.findByText('Another custom role already has this name.')).toBeTruthy();
  });

  it('explains a role that is still held, and deletes after confirmation', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 409, code: 'role.in-use' } });
    mount({ role: custom, initialName: 'Night shift', initialKeys: custom.permissionKeys });
    fireEvent.click(screen.getByRole('button', { name: 'Delete role' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete role' }).at(-1)!);
    expect(
      await screen.findByText(
        'Someone still has this role. Give them another role, then delete it.',
      ),
    ).toBeTruthy();
    expect(call).toHaveBeenCalledWith(
      'DELETE',
      `identity/admin/roles/${ID}`,
      { expectedVersion: 2 },
      'csrf-1',
    );
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'role.deleted', roleId: ID },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete role' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete role' }).at(-1)!);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/settings/roles'));
  });

  it('hides delete when the API says it is not allowed, and ends the session on 401', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 401, code: 'session.invalid' } });
    mount({
      role: {
        ...custom,
        actions: { edit: allowed, delete: { allowed: false, code: 'role.in-use' } },
      },
      initialName: 'Night shift',
      initialKeys: [],
    });
    expect(screen.queryByRole('button', { name: 'Delete role' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/session-ended'));
  });
});
