// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import SecurityPage from './page.tsx';

const mocks = vi.hoisted(() => ({ session: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next-intl/server', () => ({
  getTranslations: (namespace?: string) =>
    Promise.resolve(createTranslator({ locale: 'en-AU', messages, namespace: namespace as never })),
}));
vi.mock('../../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({
    children,
    activeId,
    title,
  }: {
    readonly children: ReactNode;
    readonly activeId: string;
    readonly title: string;
  }) => (
    <main data-active={activeId} data-title={title}>
      {children}
    </main>
  ),
}));

const session = (secondFactorActive: boolean) => ({
  accountId: 'a',
  roleId: 'r',
  permissionKeys: [],
  secondFactorActive,
  lastSignInAt: null,
  timezone: null,
  locale: null,
  email: 'ada@example.test',
  displayName: 'Ada',
  csrfToken: 'c',
});

async function show(active: boolean) {
  mocks.session.mockResolvedValue({ kind: 'ok', session: session(active) });
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      {await SecurityPage()}
    </NextIntlClientProvider>,
  );
}
afterEach(cleanup);

describe('admin account security page', () => {
  it('shows two-step On from the session, on the account page of the shell', async () => {
    await show(true);
    expect(screen.getByText('On')).toBeTruthy();
    expect(document.querySelector('main')?.getAttribute('data-active')).toBe('account');
    expect(document.querySelector('main')?.getAttribute('data-title')).toBe('Account security');
  });

  it('shows two-step Off from the session', async () => {
    await show(false);
    expect(screen.getByText('Off')).toBeTruthy();
  });

  it('shows the load error when the session cannot be read', async () => {
    mocks.session.mockResolvedValue({ kind: 'unavailable' });
    render(await SecurityPage());
    expect(screen.getByText(messages.security.unavailable)).toBeTruthy();
  });
});
