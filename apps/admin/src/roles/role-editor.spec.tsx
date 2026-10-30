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
    expect(call).toHaveBeenCalledWith('DELETE', `identity/admin/roles/${ID}`, undefined, 'csrf-1');
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

  it('says another admin saved first, and reloads the page', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 409, code: 'conflict.stale' } });
    mount({ role: custom, initialName: 'Night shift', initialKeys: custom.permissionKeys });
    fireEvent.click(screen.getByLabelText('Invite'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('This role changed while you were editing')).toBeTruthy();
    expect(router.refresh).toHaveBeenCalled();
  });
});
