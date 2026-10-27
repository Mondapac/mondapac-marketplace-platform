// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../server/session.ts', () => ({ requireSession: vi.fn() }));
vi.mock('../server/admin-shell.tsx', () => ({
  AdminShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock('next-intl/server', () => ({
  getTranslations: () =>
    Promise.resolve((key: string) =>
      key
        .split('.')
        .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], messages),
    ),
}));

import { requireSession } from '../server/session.ts';
import { WalletPage } from './wallet-page.tsx';

const gate = vi.mocked(requireSession);
const session = (permissionKeys: string[]) =>
  ({
    kind: 'ok',
    session: { permissionKeys, csrfToken: 'csrf', accountId: 'a1' },
  }) as never;

async function show(keys: string[]) {
  gate.mockResolvedValue(session(keys));
  const page = await WalletPage({
    activeId: 'wallet-settings',
    title: 'Wallet switch',
    intro: 'Intro line',
    anyOf: ['wallet.settings.view'],
    stepUpNote: true,
    body: (_session, held) => <p>body for {[...held].join(',')}</p>,
  });
  render(page);
}
afterEach(cleanup);

describe('WalletPage', () => {
  it('shows the intro, the code-wait note and the body to an admin who may see it', async () => {
    await show(['wallet.settings.view']);
    expect(screen.getByRole('heading', { name: 'Wallet switch' })).toBeTruthy();
    expect(screen.getByText('Intro line')).toBeTruthy();
    expect(screen.getByText(/Wait for your authenticator app to show a new code/)).toBeTruthy();
    expect(screen.getByText('body for wallet.settings.view')).toBeTruthy();
  });

  it('shows the no-access message and no body without the permission', async () => {
    await show(['wallet.credit.view']);
    expect(screen.getByText('You do not have access to this page.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to dashboard' }).getAttribute('href')).toBe('/');
    expect(screen.queryByText(/^body for/)).toBeNull();
  });

  it('shows a load error when the session could not be read', async () => {
    gate.mockResolvedValue({ kind: 'unavailable' });
    const page = await WalletPage({
      activeId: 'x',
      title: 't',
      intro: 'i',
      anyOf: [],
      stepUpNote: false,
      body: () => null,
    });
    render(page);
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
