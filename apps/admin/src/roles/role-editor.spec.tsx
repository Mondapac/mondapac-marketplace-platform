// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

  it('checks the name as it is typed or left, and keeps Save off while it is wrong', () => {
    mount();
    const name = screen.getByLabelText('Role name');
    // Nothing is flagged on a new, untouched form.
    expect(screen.queryByText('Enter a name for the role.')).toBeNull();
    fireEvent.blur(name);
    expect(screen.getByText('Enter a name for the role.')).toBeTruthy();
    expect(screen.getByText(/1 needs fixing/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Create role' }).disabled).toBe(
      true,
    );
    fireEvent.change(name, { target: { value: 'Night shift' } });
    expect(screen.queryByText('Enter a name for the role.')).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Create role' }).disabled).toBe(
      false,
    );
    fireEvent.change(name, { target: { value: `Bad\u202Ename` } });
    expect(screen.getByRole('alert').textContent).toContain('1 setting needs fixing');
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

  it('guards leaving again when something is edited after a save', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { code: 'role.updated', roleId: ID },
    });
    mount({ role: custom, initialName: 'Night shift', initialKeys: custom.permissionKeys });
    const leaves = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    fireEvent.click(screen.getByLabelText('Invite'));
    expect(leaves()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await expectToast(/Saved\./);
    expect(leaves()).toBe(false);
    fireEvent.click(screen.getByLabelText('View'));
    expect(leaves()).toBe(true);
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
    fireEvent.click(screen.getByLabelText('Invite'));
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
    fireEvent.click(screen.getByLabelText('Invite'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/session-ended'));
  });

  it('shows the save bar from the first change, marks what changed and discards it', () => {
    mount({ role: custom, initialName: 'Night shift', initialKeys: custom.permissionKeys });
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();

    fireEvent.click(screen.getByLabelText('Invite'));
    fireEvent.change(screen.getByLabelText('Role name'), { target: { value: 'Late shift' } });
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(bar.textContent).toContain('2 unsaved changes');
    expect(screen.getByLabelText('Invite').className).toContain('outline-attention-solid');
    expect(screen.getByLabelText('View').className).not.toContain('outline-attention-solid');

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Role name').value).toBe('Night shift');
    expect(screen.getByLabelText<HTMLInputElement>('Invite').checked).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });

  it('shows a new role with its bar from the start, named Create role', () => {
    mount({ initialName: '' });
    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(bar.textContent).toContain('New role · nothing entered yet');
    expect(bar.textContent).not.toContain('unsaved change');
    expect(screen.getByRole('button', { name: 'Create role' })).toBeTruthy();
  });

  it('lists a missing name in the error summary, which links to the field', () => {
    mount({ initialName: '' });
    fireEvent.click(screen.getByRole('button', { name: 'Create role' }));
    const summary = screen.getByRole('alert');
    expect(summary.textContent).toContain('1 setting needs fixing before you can save');
    fireEvent.click(within(summary).getByRole('link', { name: 'Role name' }));
    expect(document.activeElement).toBe(screen.getByLabelText('Role name'));
    expect(call).not.toHaveBeenCalled();
  });

  it('puts Delete role in a danger zone at the end of the page', () => {
    mount({ role: custom, initialName: 'Night shift', initialKeys: custom.permissionKeys });
    const headings = screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent);
    expect(headings.at(-1)).toBe('Danger zone');
    const zone = screen.getByRole('heading', { name: 'Danger zone' }).closest('section')!;
    expect(zone.getAttribute('data-variant')).toBe('danger');
    expect(within(zone).getByRole('button', { name: 'Delete role' })).toBeTruthy();
  });
});
