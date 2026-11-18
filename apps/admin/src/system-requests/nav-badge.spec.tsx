// @vitest-environment jsdom
import { NavBadgeProvider, useNavBadges } from '@mondapac/ui';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { notifyChanged } from './errors.ts';
import { SystemRequestsNavBadge } from './nav-badge.tsx';

const call = vi.mocked(callApi);
const ok = (body: unknown) => ({ ok: true as const, status: 200, body });

function Show() {
  const badge = useNavBadges()['system-requests'];
  return (
    <output>{badge === undefined ? 'none' : `${badge.count}|${badge.tone}|${badge.label}`}</output>
  );
}

function mount(enabled: boolean) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <NavBadgeProvider>
        <SystemRequestsNavBadge enabled={enabled} />
        <Show />
      </NavBadgeProvider>
    </NextIntlClientProvider>,
  );
}

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

describe('SystemRequestsNavBadge', () => {
  it('never calls the API without the view permission', () => {
    mount(false);
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toBe('none');
  });

  it('shows the waiting count, in the critical tone when something is overdue', async () => {
    call.mockResolvedValue(ok({ needsMyReview: 3, overdue: 1 }));
    mount(true);
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^3\|critical\|/));
    expect(call).toHaveBeenCalledWith('GET', 'system-requests/admin/requests-count');
  });

  it('uses the info tone with nothing overdue and shows nothing for zero', async () => {
    call.mockResolvedValue(ok({ needsMyReview: 2, overdue: 0 }));
    mount(true);
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^2\|info\|/));
    call.mockResolvedValue(ok({ needsMyReview: 0, overdue: 0 }));
    act(() => notifyChanged());
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('none'));
  });

  it('shows no badge, and no error, when the count cannot be read', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 500, code: 'internal' } });
    mount(true);
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(screen.getByRole('status').textContent).toBe('none');
  });
});
