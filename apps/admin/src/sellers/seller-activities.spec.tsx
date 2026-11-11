// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { STEP_UP_CANCELLED } from '../step-up/step-up.tsx';
import type { ActivityOption, SellerActivities } from './activities-types.ts';
import { SellerActivitiesCard } from './seller-activities-card.tsx';

const call = vi.mocked(callApi);
const SELLER = '0190a000-0000-7000-8000-0000000000a1';
const A1 = '0190a000-0000-7000-8000-0000000000b1';
const A2 = '0190a000-0000-7000-8000-0000000000b2';
const A3 = '0190a000-0000-7000-8000-0000000000b3';
const options: ActivityOption[] = [
  { id: A1, name: 'Butcher', active: true },
  { id: A2, name: 'Grocer', active: true },
  { id: A3, name: 'Bakery', active: false },
];
const seller = (over: Partial<SellerActivities> = {}): SellerActivities => ({
  mainActivityId: A1,
  extraActivityIds: [A2],
  lastChange: null,
  ...over,
});

const mount = (initial: SellerActivities, canEdit = true) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <SellerActivitiesCard
        sellerId={SELLER}
        initial={initial}
        activities={options}
        canEdit={canEdit}
        csrfToken="csrf"
      />
    </NextIntlClientProvider>,
  );

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('SellerActivitiesCard', () => {
  it('names the main and the other activities', () => {
    mount(seller());
    expect(screen.getByText('Butcher')).toBeTruthy();
    expect(screen.getByText('Grocer')).toBeTruthy();
    expect(screen.getByText('Main activity')).toBeTruthy();
  });

  it('says so when no activity is set, and shows an unknown id without a name', () => {
    mount(seller({ mainActivityId: null, extraActivityIds: [] }));
    expect(screen.getByText('No activity set yet.')).toBeTruthy();
    cleanup();
    mount(seller({ mainActivityId: 'unlisted', extraActivityIds: [] }));
    expect(screen.getByText('Unknown activity')).toBeTruthy();
  });

  it('shows the last change with its reason', () => {
    mount(
      seller({ lastChange: { changedBy: 'x', changedAt: '2026-11-01T00:00:00Z', reason: 'Fix' } }),
    );
    expect(screen.getByText(/Reason: Fix/)).toBeTruthy();
  });

  it('has no edit button without the manage key', () => {
    mount(seller(), false);
    expect(screen.queryByRole('button', { name: 'Change activities' })).toBeNull();
  });

  it('asks for a reason before it calls the API', async () => {
    mount(seller());
    fireEvent.click(screen.getByRole('button', { name: 'Change activities' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save activities' }));
    expect(await screen.findByText('Give a reason.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('replaces the set with a reason and shows the result', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { mainActivityId: A1, extraActivityIds: [], changed: true },
    });
    mount(seller());
    fireEvent.click(screen.getByRole('button', { name: 'Change activities' }));
    fireEvent.change(screen.getByLabelText(/Reason for the change/), {
      target: { value: 'Seller asked' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save activities' }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(call).toHaveBeenCalledWith(
      'PUT',
      `sellers/admin/${SELLER}/business-activities`,
      { mainActivityId: A1, extraActivityIds: [A2], reason: 'Seller asked' },
      'csrf',
    );
    expect(await screen.findByText(/Reason: Seller asked/)).toBeTruthy();
  });

  it('stays quiet when the admin closes the code dialog', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 0, code: STEP_UP_CANCELLED } });
    mount(seller());
    fireEvent.click(screen.getByRole('button', { name: 'Change activities' }));
    fireEvent.change(screen.getByLabelText(/Reason for the change/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save activities' }));
    await waitFor(() => expect(call).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a refusal in words', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 400, code: 'validation.failed' } });
    mount(seller());
    fireEvent.click(screen.getByRole('button', { name: 'Change activities' }));
    fireEvent.change(screen.getByLabelText(/Reason for the change/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save activities' }));
    expect(await screen.findByText(/no longer available|not available any more/)).toBeTruthy();
  });
});
