// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import type { AdminSession } from '../../../src/server/session.ts';
import WorkQueuePage from './page.tsx';

// The work-queue page: the read only with a queue's key, no access when no known queue answers,
// the error and sign-in states, and the view from a link.

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  session: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`redirect:${to}`);
  }),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({ children }: { readonly children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock('../../../src/server/bff.ts', () => ({ panelHostFor: () => ({ marketId: 'AU' }) }));
vi.mock('../../../src/server/config.ts', () => ({ panelConfig: () => ({}) }));
vi.mock('../../../src/work-queue/work-queue-list.tsx', () => ({
  WorkQueueList: ({ initialView }: { readonly initialView: string }) => (
    <p>{`list ${initialView}`}</p>
  ),
}));

const session = (permissionKeys: string[]): AdminSession => ({
  accountId: 'a',
  roleId: 'r',
  permissionKeys,
  secondFactorActive: true,
  lastSignInAt: null,
  timezone: null,
  marketTimezone: 'UTC',
  locale: null,
  email: 'ada@example.test',
  displayName: 'Ada',
  csrfToken: 'c',
});
const search = (values: Record<string, string> = {}) => ({ searchParams: Promise.resolve(values) });
const answer = (key: string) => ({
  kind: 'ok',
  body: {
    panel: 'admin',
    generatedAt: '2026-11-22T12:00:00.000Z',
    queues: [{ key, level: 'today', status: 'ok', count: 1, overdue: 0, oldestAt: null }],
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ kind: 'ok', session: session(['sellers.seller.view']) });
  mocks.get.mockResolvedValue(answer('sellers.applications'));
});
afterEach(cleanup);

describe('work-queue page', () => {
  it('reads the work queue and opens the view a link asks for, else Needs action', async () => {
    render(await WorkQueuePage(search({ view: 'review' })));
    expect(mocks.get).toHaveBeenCalledWith('dashboard/admin/work-queue');
    expect(screen.getByRole('heading', { level: 1, name: 'Work queue' })).toBeTruthy();
    expect(screen.getByText('list review')).toBeTruthy();
    cleanup();
    render(await WorkQueuePage(search({ view: '<b>x</b>' })));
    expect(screen.getByText('list needs-action')).toBeTruthy();
  });

  it('reads nothing without any queue key, and says there is no access', async () => {
    mocks.session.mockResolvedValue({ kind: 'ok', session: session(['customers.customers.view']) });
    render(await WorkQueuePage(search()));
    expect(mocks.get).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: "You can't see the work queue" })).toBeTruthy();
  });

  it('says there is no access, not All clear, when no queue the panel knows answers', async () => {
    mocks.get.mockResolvedValue(answer('future.queue'));
    render(await WorkQueuePage(search()));
    expect(screen.getByRole('heading', { name: "You can't see the work queue" })).toBeTruthy();
    expect(screen.queryByText(/^list /)).toBeNull();
  });

  it('shows the error with the page title when the read fails', async () => {
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    render(await WorkQueuePage(search()));
    expect(screen.getByRole('heading', { level: 1, name: 'Work queue' })).toBeTruthy();
    expect(screen.getByText(/The work queue could not be loaded/)).toBeTruthy();
  });

  it('sends a rejected session to the session-ended page', async () => {
    mocks.get.mockResolvedValue({ kind: 'signed-out' });
    await expect(WorkQueuePage(search())).rejects.toThrow('redirect:/session-ended');
  });
});
