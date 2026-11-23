// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { SellersQueuesMenu } from './sellers-queues-menu.tsx';

const mocks = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../api/client.ts', () => ({ callApi: mocks.call }));

const ok = (body: unknown) => ({ ok: true, status: 200, body });
const health = (all: number, truncated = false) => ok({ counts: { all }, truncated, items: [] });
const orphans = (n: number, next: string | null = null) =>
  ok({ items: Array.from({ length: n }, () => ({})), next });
const failed = { ok: false, failure: { status: 500, code: 'x' } };

const answer = (h: unknown, o: unknown) =>
  mocks.call.mockImplementation((_m: string, path: string) =>
    Promise.resolve(path.startsWith('sellers/') ? h : o),
  );

const view = (props: {
  current?: 'all' | 'needs-a-look' | 'without-owner';
  health: boolean;
  owner: boolean;
}) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <SellersQueuesMenu
        current={props.current ?? 'all'}
        canHealth={props.health}
        canOrphaned={props.owner}
      />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  mocks.call.mockReset();
});
afterEach(cleanup);

describe('SellersQueuesMenu', () => {
  it('draws no button without either permission, and makes no call', () => {
    view({ health: false, owner: false });
    expect(screen.queryByRole('button')).toBeNull();
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it('sums the queues and names the count', async () => {
    answer(health(3), orphans(2));
    view({ health: true, owner: true });
    expect(
      await screen.findByRole('button', { name: 'Queues, 5 items need attention' }),
    ).toBeTruthy();
  });

  it('shows only the queue the viewer may see, and asks only for it', async () => {
    answer(health(1), orphans(9));
    view({ health: true, owner: false });
    expect(
      await screen.findByRole('button', { name: 'Queues, 1 item needs attention' }),
    ).toBeTruthy();
    expect(mocks.call).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByRole('menuitem', { name: /without an owner/ })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Sellers that need a look, 1' })).toBeTruthy();
  });

  it('hides the badge at 0, never showing "0"', async () => {
    answer(health(0), orphans(0));
    view({ health: true, owner: true });
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Queues' })).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('hides the badge when a count fails, but keeps the links', async () => {
    answer(health(4), failed);
    view({ health: true, owner: true });
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Queues' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('menuitem', { name: /^Sellers without an owner/ })).toBeTruthy();
  });

  it('hides the badge when a call throws', async () => {
    mocks.call.mockRejectedValue(new Error('offline'));
    view({ health: true, owner: true });
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Queues' })).toBeTruthy();
  });

  it('marks a count as a floor when the owner-less list has more rows', async () => {
    answer(health(1), orphans(100, 'cursor'));
    view({ health: true, owner: true });
    expect(await screen.findByText('101+')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Queues, at least 101 items need attention' }),
    ).toBeTruthy();
  });

  it('ticks the current queue and offers All sellers off the main page, not on it', async () => {
    answer(health(1), orphans(1));
    view({ current: 'without-owner', health: true, owner: true });
    await screen.findByRole('button', { name: /Queues, 2/ });
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('menuitem', { name: 'All sellers' }).getAttribute('href')).toBe(
      '/sellers',
    );
    expect(
      screen.getByRole('menuitem', { name: /without an owner/ }).getAttribute('aria-current'),
    ).toBe('page');
    cleanup();
    view({ current: 'all', health: true, owner: true });
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByRole('menuitem', { name: 'All sellers' })).toBeNull();
  });
});
