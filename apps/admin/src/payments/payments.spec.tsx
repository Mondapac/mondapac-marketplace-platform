// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { visibleNavItems } from '@mondapac/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { adminNav } from '../nav.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { AccountDetail } from './account-detail.tsx';
import type { ConnectedAccountDetail, ConnectedAccountRow } from './types.ts';

const call = vi.mocked(callApi);
const row = (over: Partial<ConnectedAccountRow> = {}): ConnectedAccountRow => ({
  sellerId: '0190a000-0000-7000-8000-000000000001',
  sellerName: 'Cedar Lane Halal Meats',
  status: 'enabled',
  ready: true,
  requirementsDue: 0,
  requirementsPastDue: false,
  coolingOffUntil: null,
  payoutsPaused: false,
  lastReadAt: '2026-10-13T01:00:00.000Z',
  createdAt: '2026-10-01T00:00:00.000Z',
  ...over,
});
const wrap = (node: React.ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    {node}
  </NextIntlClientProvider>
);

beforeEach(() => call.mockReset());
afterEach(cleanup);

describe('connected account detail', () => {
  const detail = (over: Partial<ConnectedAccountDetail> = {}): ConnectedAccountDetail => ({
    ...row({ requirementsDue: 1, requirementsPastDue: true }),
    changes: [
      { detectedAt: '2026-10-13T01:00:00.000Z', kind: 'updated' },
      { detectedAt: '2026-10-01T01:00:00.000Z', kind: 'initial' },
    ],
    ...over,
  });

  it('shows the fields and the change history', () => {
    render(wrap(<AccountDetail account={detail()} />));
    expect(screen.getByRole('heading', { name: 'Cedar Lane Halal Meats' })).toBeTruthy();
    expect(screen.getByText('Requirements past due')).toBeTruthy();
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items[0]).toContain('Bank account updated');
    expect(items[1]).toContain('First bank account added');
  });

  it('says so when nothing changed', () => {
    render(wrap(<AccountDetail account={detail({ changes: [], sellerName: null })} />));
    expect(screen.getByText('No changes recorded.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Unnamed seller' })).toBeTruthy();
  });
});

describe('connected accounts nav', () => {
  it('shows the entry only with the view key', () => {
    const ids = (keys: string[]) => visibleNavItems(adminNav, new Set(keys)).map((item) => item.id);
    expect(ids([])).not.toContain('payout-accounts');
    expect(ids(['payments.connected-account.view'])).toContain('payout-accounts');
  });
});
