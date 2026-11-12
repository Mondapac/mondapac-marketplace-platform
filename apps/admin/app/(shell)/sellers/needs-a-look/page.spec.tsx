// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../../messages/en.json';
import type { AdminSession } from '../../../../src/server/session.ts';
import SellersNeedingALookPage from './page.tsx';

const mocks = vi.hoisted(() => ({ session: vi.fn(), get: vi.fn() }));

vi.mock('next-intl/server', () => ({
  getTranslations: (namespace?: string) =>
    Promise.resolve(
      createTranslator({
        locale: 'en-AU',
        messages,
        ...(namespace === undefined ? {} : { namespace }),
      } as never),
    ),
  getLocale: () => Promise.resolve('en-AU'),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock('../../../../src/server/session.ts', () => ({ requireSession: mocks.session }));
vi.mock('../../../../src/server/server-fetch.ts', () => ({ serverGet: mocks.get }));
vi.mock('../../../../src/server/admin-shell.tsx', () => ({
  AdminShell: ({ children }: { readonly children: ReactNode }) => <main>{children}</main>,
}));

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
const signedIn = (...keys: string[]) =>
  mocks.session.mockResolvedValue({ kind: 'ok', session: session(keys) });
const SELLER = '0190a000-0000-7000-8000-0000000000a1';

const renderPage = (page: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      {page}
    </NextIntlClientProvider>,
  );

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the sellers that need a look page', () => {
  it('lists the unhealthy sellers with score and lowest measure, linking to each', async () => {
    signedIn('sellers.seller.view');
    mocks.get.mockResolvedValue({
      kind: 'ok',
      body: {
        truncated: true,
        items: [
          {
            sellerId: SELLER,
            storeName: 'Cedar Lane',
            slug: 'cedar-lane',
            day: '2026-11-10',
            score: 20,
            lowestMetric: 'late-ready',
          },
          {
            sellerId: '0190a000-0000-7000-8000-0000000000a2',
            storeName: null,
            slug: null,
            day: '2026-11-10',
            score: 30,
            lowestMetric: 'something-new',
          },
        ],
      },
    });
    renderPage(await SellersNeedingALookPage());
    expect(mocks.get).toHaveBeenCalledWith('sellers/admin/health-queue');
    expect(screen.getByRole('link', { name: 'Cedar Lane' }).getAttribute('href')).toBe(
      `/sellers/${SELLER}`,
    );
    expect(screen.getByText('Unhealthy · 20')).toBeTruthy();
    expect(screen.getByText('Orders ready late')).toBeTruthy();
    expect(screen.getByText('Unnamed store')).toBeTruthy();
    // The measured day is a date with no time of day.
    expect(screen.getAllByText('10 Nov 2026')).toHaveLength(2);
    expect(screen.getByText('Only the worst sellers are shown.')).toBeTruthy();
  });

  it('says so when no seller needs a look', async () => {
    signedIn('sellers.seller.view');
    mocks.get.mockResolvedValue({ kind: 'ok', body: { items: [], truncated: false } });
    renderPage(await SellersNeedingALookPage());
    expect(screen.getByText('No seller needs a look')).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('makes no call and shows no-access without the key', async () => {
    signedIn('identity.seller-access.view');
    renderPage(await SellersNeedingALookPage());
    expect(mocks.get).not.toHaveBeenCalled();
    expect(screen.getByText("You don't have access to this page")).toBeTruthy();
  });

  it('shows a load error when the read fails and goes to sign-in when signed out', async () => {
    signedIn('sellers.seller.view');
    mocks.get.mockResolvedValue({ kind: 'unavailable' });
    renderPage(await SellersNeedingALookPage());
    expect(screen.getByText("We couldn't load the sellers. Try again.")).toBeTruthy();
    mocks.get.mockResolvedValue({ kind: 'signed-out' });
    await expect(SellersNeedingALookPage()).rejects.toThrow('redirect:/session-ended');
  });
});
