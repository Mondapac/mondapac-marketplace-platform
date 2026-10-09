// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { RolesTable } from './roles-table.tsx';
import { RoleView } from './role-view.tsx';
import { groupByResource, humanise } from './role-name.ts';
import type { RoleCatalogue, RoleRecord } from './types.ts';

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
}));

const allowed = { allowed: true, code: null };
const role = (over: Partial<RoleRecord>): RoleRecord => ({
  roleId: '0190a000-0000-7000-8000-0000000000a1',
  kind: 'system',
  seedCode: 'platform-administrator',
  name: null,
  permissionCount: 3,
  permissionKeys: [],
  grantable: true,
  version: 1,
  actions: { edit: allowed, delete: allowed },
  ...over,
});
const catalogue: RoleCatalogue = {
  items: [],
  keys: [
    { key: 'identity.admin-account.view', protected: false, grantable: true },
    { key: 'identity.admin-account.invite', protected: false, grantable: true },
    { key: 'identity.platform-role.manage', protected: true, grantable: false },
  ],
};

describe('admin roles', () => {
  afterEach(cleanup);

  it('groups the roles by type, with counts and a way to view each', async () => {
    const roles = [
      role({}),
      role({
        roleId: '0190a000-0000-7000-8000-0000000000a2',
        kind: 'default',
        seedCode: 'viewer',
        permissionCount: 2,
      }),
      role({
        roleId: '0190a000-0000-7000-8000-0000000000a3',
        kind: 'custom',
        seedCode: null,
        name: 'Night shift',
        permissionCount: 0,
      }),
    ];
    render(await RolesTable({ roles }));
    expect(screen.getByRole('heading', { name: 'System' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Ready-made' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Custom' })).toBeTruthy();
    expect(screen.getByText('All permissions')).toBeTruthy();
    expect(screen.getByText('2 permissions')).toBeTruthy();
    expect(screen.getByText('No permissions yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View Night shift' }).getAttribute('href')).toBe(
      '/roles/0190a000-0000-7000-8000-0000000000a3',
    );
  });

  it('says when there are no custom roles yet', async () => {
    render(await RolesTable({ roles: [role({})] }));
    expect(screen.getByText('No custom roles yet')).toBeTruthy();
  });

  it('shows a system role read-only with every permission of the scope', async () => {
    render(await RoleView({ role: role({}), catalogue }));
    expect(screen.getByRole('heading', { name: 'Platform Administrator' })).toBeTruthy();
    expect(screen.getByText("This role has every permission and can't be changed.")).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText('Protected')).toBeTruthy();
  });

  it('shows a custom role by name with its own permissions and no read-only banner', async () => {
    render(
      await RoleView({
        role: role({
          kind: 'custom',
          seedCode: null,
          name: 'Night shift',
          permissionKeys: ['identity.admin-account.view'],
          permissionCount: 1,
        }),
        catalogue,
      }),
    );
    expect(screen.getByRole('heading', { name: 'Night shift' })).toBeTruthy();
    expect(screen.queryByText(/can't be changed/)).toBeNull();
    expect(screen.getByText('1 of 3 permissions selected')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('never shows a raw seed code or the role name as markup', async () => {
    render(
      await RoleView({
        role: role({ kind: 'custom', seedCode: null, name: '<b>x</b>', permissionKeys: [] }),
        catalogue,
      }),
    );
    expect(screen.getByRole('heading', { name: '<b>x</b>' })).toBeTruthy();
    expect(document.querySelector('h1 b')).toBeNull();
  });

  it('groups keys by resource and humanises a name without a copy key', () => {
    expect(groupByResource(['b.x.two', 'a.y.one', 'b.x.one'])).toEqual([
      ['a.y', ['a.y.one']],
      ['b.x', ['b.x.one', 'b.x.two']],
    ]);
    expect(humanise('admin-account')).toBe('Admin account');
  });
});
