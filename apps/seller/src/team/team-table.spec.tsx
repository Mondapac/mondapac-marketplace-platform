// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { TeamTable } from './team-table.tsx';
import type { InvitationRow, MemberRow, SellerRole, TeamPage } from './types.ts';

vi.mock('./row-actions.tsx', () => ({ RowActions: () => null }));
vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
  getLocale: () => Promise.resolve('en-AU'),
  getTimeZone: () => Promise.resolve('UTC'),
}));

const hint = { allowed: true, code: null };
const member = (over: Partial<MemberRow>): MemberRow => ({
  type: 'account',
  accountId: '0190a000-0000-7000-8000-000000000001',
  email: 'owen@example.test',
  displayName: 'Owen Owner',
  self: false,
  role: {
    roleId: '0190a000-0000-7000-8000-0000000000a1',
    kind: 'system',
    seedCode: 'seller-owner',
  },
  actions: { changeRole: hint, remove: hint },
  ...over,
});
const invitation = (over: Partial<InvitationRow>): InvitationRow => ({
  type: 'invitation',
  invitationId: '0190a000-0000-7000-8000-000000000002',
  email: 'new@example.test',
  role: {
    roleId: '0190a000-0000-7000-8000-0000000000a2',
    kind: 'default',
    seedCode: 'bookkeeper',
  },
  invitedByAccountId: null,
  status: 'pending',
  createdAt: '2026-10-08T00:00:00Z',
  expiresAt: '2026-10-11T02:30:00Z',
  actions: { resend: hint, revoke: hint },
  ...over,
});

async function show(page: TeamPage, after: string | null = null, roleList: SellerRole[] = []) {
  render(await TeamTable({ page, after, csrfToken: 'csrf', roleList }));
}

describe('seller team table', () => {
  afterEach(cleanup);

  it('lists members and invitations with roles, status and expiry, and marks the own row', async () => {
    await show(
      {
        items: [
          member({ self: true }),
          member({
            accountId: '0190a000-0000-7000-8000-000000000003',
            email: 'pat@example.test',
            displayName: null,
            role: {
              roleId: '0190a000-0000-7000-8000-0000000000a3',
              kind: 'custom',
              seedCode: null,
            },
          }),
          invitation({}),
          invitation({
            invitationId: '0190a000-0000-7000-8000-000000000004',
            status: 'expired',
            role: null,
            expiresAt: '2026-10-09T00:00:00Z',
          }),
        ],
        next: null,
      },
      null,
      [
        {
          roleId: '0190a000-0000-7000-8000-0000000000a3',
          kind: 'custom',
          seedCode: null,
          name: 'Packers',
          permissionCount: 2,
          grantable: true,
        },
      ],
    );
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(5);
    expect(
      screen.getByRole('table', { name: 'Team members and pending invitations' }),
    ).toBeTruthy();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Person',
      'Role',
      'Status',
      'Actions',
    ]);
    expect(within(rows[1]!).getByText('You')).toBeTruthy();
    expect(within(rows[1]!).getByText('Seller Owner')).toBeTruthy();
    expect(within(rows[1]!).getByText('Active')).toBeTruthy();
    expect(within(rows[2]!).getByText('pat@example.test')).toBeTruthy();
    expect(within(rows[2]!).getByText('Packers')).toBeTruthy();
    expect(within(rows[3]!).getByText('Bookkeeper')).toBeTruthy();
    expect(within(rows[3]!).getByText('Invited')).toBeTruthy();
    expect(within(rows[3]!).getByText(/^Expires .*11 Oct 2026/)).toBeTruthy();
    expect(within(rows[4]!).getByText('Invitation expired')).toBeTruthy();
    expect(within(rows[4]!).getByText('No role')).toBeTruthy();
  });

  it('says it is just the actor so far on an empty first page only', async () => {
    await show({ items: [], next: null });
    expect(screen.getByText("It's just you so far")).toBeTruthy();
    cleanup();
    await show({ items: [], next: null }, '0190a000-0000-7000-8000-000000000009');
    expect(screen.queryByText("It's just you so far")).toBeNull();
    expect(screen.getByText('There is nobody on this page.')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
