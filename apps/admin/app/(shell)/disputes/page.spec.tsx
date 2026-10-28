// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import type { AdminSession } from '../../../src/server/session.ts';
import DisputesPageRoute from './page.tsx';
import DisputePageRoute from './[disputeId]/page.tsx';

// The two dispute pages: the permission gate (no API read without
// commission-payouts.dispute.view), the states of the detail read, and a heading on every branch.

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  session: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('not-found');
  }),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect, notFound: mocks.notFound }));
vi.mock('../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../src/disputes/disputes-list.tsx', () => ({
  DisputesList: () => <p>the list</p>,
}));
vi.mock('../../../src/disputes/dispute-detail.tsx', () => ({
  DisputeDetailView: ({ canDecide }: { readonly canDecide: boolean }) => (
    <p data-can-decide={String(canDecide)}>the case</p>
  ),
}));
vi.mock('../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({ children }: { readonly children: ReactNode }) => <main>{children}</main>,
}));

const VIEW = 'commission-payouts.dispute.view';
const ATTRIBUTE = 'commission-payouts.dispute.attribute';
const ID = '0190a000-0000-7000-8000-0000000000a1';
const session = (permissionKeys: string[]): AdminSession => ({
  accountId: 'a',
  roleId: 'r',
  permissionKeys,
  secondFactorActive: true,
  lastSignInAt: null,
  timezone: null,
  locale: null,
  email: 'ada@example.test',
  displayName: 'Ada',
  csrfToken: 'c',
});
const params = (disputeId = ID) => ({ params: Promise.resolve({ disputeId }) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ kind: 'ok', session: session([VIEW]) });
  mocks.get.mockResolvedValue({ kind: 'ok', body: { disputeId: ID } });
});
afterEach(cleanup);

describe('disputes list page', () => {
  it('shows the list to an admin who may view disputes', async () => {
    render(await DisputesPageRoute());
    expect(screen.getByText('the list')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Disputes' })).toBeTruthy();
  });

  it('shows no list without the view permission, but still a heading and a way back', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([]) });
    render(await DisputesPageRoute());
    expect(screen.queryByText('the list')).toBeNull();
    expect(screen.getByText(messages.disputes['no-access'])).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Disputes' })).toBeTruthy();
    expect(screen.getByRole('link', { name: messages.disputes['back-home'] })).toBeTruthy();
  });

  it('keeps its heading when the session cannot be read', async () => {
    mocks.session.mockResolvedValue({ kind: 'unavailable' });
    render(await DisputesPageRoute());
    expect(screen.getByRole('heading', { level: 1, name: 'Disputes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('dispute detail page', () => {
  it('refuses without the view permission and never calls the API', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([ATTRIBUTE]) });
    render(await DisputePageRoute(params()));
    expect(screen.getByText(messages.disputes['no-access'])).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'No access' })).toBeTruthy();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('reads the case and tells the view whether this admin may decide', async () => {
    const { container, rerender } = render(await DisputePageRoute(params()));
    expect(mocks.get).toHaveBeenCalledWith(`commission-payouts/admin/disputes/${ID}`);
    expect(container.querySelector('[data-can-decide]')?.getAttribute('data-can-decide')).toBe(
      'false',
    );
    mocks.session.mockResolvedValue({ kind: 'ok', session: session([VIEW, ATTRIBUTE]) });
    rerender(await DisputePageRoute(params()));
    expect(container.querySelector('[data-can-decide]')?.getAttribute('data-can-decide')).toBe(
      'true',
    );
  });

  it('answers not-found for a bad id without any read, and for an unknown case', async () => {
    await expect(DisputePageRoute(params('nope'))).rejects.toThrow('not-found');
    expect(mocks.get).not.toHaveBeenCalled();
    mocks.get.mockResolvedValue({ kind: 'not-found' });
    render(await DisputePageRoute(params()));
    expect(screen.getByRole('heading', { level: 1, name: 'Dispute not found' })).toBeTruthy();
  });

  it('treats a 403 from the API as no access, and sends a rejected session out', async () => {
    mocks.get.mockResolvedValue({ kind: 'forbidden' });
    render(await DisputePageRoute(params()));
    expect(screen.getByRole('heading', { level: 1, name: 'No access' })).toBeTruthy();
    cleanup();
    mocks.get.mockResolvedValue({ kind: 'signed-out' });
    await expect(DisputePageRoute(params())).rejects.toThrow('redirect:/session-ended');
  });

  it('keeps a heading above the retry when the case cannot be loaded', async () => {
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    render(await DisputePageRoute(params()));
    expect(screen.getByRole('heading', { level: 1, name: 'Dispute' })).toBeTruthy();
    expect(screen.getByText(messages.disputes.error.unavailable)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('keeps a heading when the session cannot be read', async () => {
    mocks.session.mockResolvedValue({ kind: 'unavailable' });
    render(await DisputePageRoute(params()));
    expect(screen.getByRole('heading', { level: 1, name: 'Dispute' })).toBeTruthy();
  });
});
