// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
const guarded = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../step-up/step-up.tsx', () => ({
  useGuardedCall: () => guarded.call,
  isStepUpCancelled: (result: { ok: boolean; failure?: { code: string } }) =>
    !result.ok && result.failure?.code === 'step-up.cancelled',
}));

import { callApi } from '../api/client.ts';
import { OfferReviewCard } from '../sellers/offer-review-card.tsx';
import { CategoryFlags } from './category-flags.tsx';
import { flagsOf, standingOf, type Flags } from './standing.ts';

const plain = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="Australia/Brisbane">
    {node}
  </NextIntlClientProvider>
);
const ok = (body: unknown) => ({ ok: true as const, status: 200, body });
const fail = (status: number, code: string) => ({ ok: false as const, failure: { status, code } });

const SELLER = '0190a000-0000-7000-8000-0000000000c1';
const FLAGS: Flags = {
  trusted: { on: false, changedAt: null },
  'full-review': { on: true, changedAt: '2026-11-20T00:00:00Z' },
  stop: { on: false, changedAt: null },
  version: 4,
};
const STANDING = standingOf({
  status: 'probation',
  source: null,
  trustedSince: null,
  count: 4,
  target: 10,
  targetKind: 'initial',
  consecutiveChangesNeeded: 0,
})!;
const ALL = { trusted: true, 'full-review': true, stop: true };

const mountCard = (can = ALL, initial: Flags | null = FLAGS) =>
  render(
    wrap(
      <OfferReviewCard
        sellerId={SELLER}
        csrfToken="csrf"
        standing={STANDING}
        initial={initial}
        can={can}
        zone="Australia/Brisbane"
      />,
    ),
  );
const reason = () => screen.getByRole('textbox', { name: /Reason/ });

beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('standing and flag reads', () => {
  it('reads the three flags and the version, and refuses a shape it does not know', () => {
    expect(
      flagsOf({
        trustedFromStart: { on: true, changedAt: null },
        fullReview: { on: false, changedAt: '2026-01-01T00:00:00Z' },
        reviewStop: { on: false, changedAt: null },
        version: 2,
      }),
    ).toEqual({
      trusted: { on: true, changedAt: null },
      'full-review': { on: false, changedAt: '2026-01-01T00:00:00Z' },
      stop: { on: false, changedAt: null },
      version: 2,
    });
    expect(flagsOf({ trustedFromStart: { on: true } })).toBeNull();
    expect(standingOf({ status: 'weird', count: 1, target: 2 })).toBeNull();
  });
});

describe('OfferReviewCard', () => {
  it('shows the standing as text and a bar, and each switch with its effect', () => {
    mountCard();
    expect(screen.getByText('Probation')).toBeTruthy();
    expect(screen.getByText('4 of 10 first publications approved')).toBeTruthy();
    const full = screen.getByRole('switch', { name: 'Full review' });
    expect(full.getAttribute('aria-checked')).toBe('true');
    expect(full.getAttribute('aria-describedby')).toBeTruthy();
    expect(
      screen.getByRole('switch', { name: 'Trusted from start' }).getAttribute('aria-checked'),
    ).toBe('false');
    expect(screen.getByRole('switch', { name: 'Stop' })).toBeTruthy();
  });

  it('is read-only for a switch the admin may not change', () => {
    mountCard({ trusted: false, 'full-review': true, stop: false });
    expect(screen.getByRole<HTMLButtonElement>('switch', { name: 'Stop' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('switch', { name: 'Full review' }).disabled).toBe(
      false,
    );
    expect(screen.getAllByText(/Read only/).length).toBe(2);
  });

  it('always needs a reason, then sends the body with the version and applies the answer', async () => {
    plain.mockResolvedValue(ok({ on: false, changed: true, version: 5 }));
    mountCard();
    fireEvent.click(screen.getByRole('switch', { name: 'Full review' }));
    const dialog = screen.getByRole('dialog', { hidden: true });
    expect(within(dialog).getByText('Turn off Full review?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off', hidden: true }));
    expect(await within(dialog).findByText('Write a reason.')).toBeTruthy();
    expect(plain).not.toHaveBeenCalled();
    fireEvent.change(reason(), { target: { value: '  Seller cleared.  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn off', hidden: true }));
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Full review' }).getAttribute('aria-checked')).toBe(
        'false',
      ),
    );
    expect(plain).toHaveBeenCalledWith(
      'PUT',
      `sellers/admin/${SELLER}/offer-review/full-review`,
      { on: false, reason: 'Seller cleared.', expectedVersion: 4 },
      'csrf',
    );
    // Full review needs no step-up: the guarded call is not used.
    expect(guarded.call).not.toHaveBeenCalled();
    expect(screen.getByText('Full review is off.')).toBeTruthy();
  });

  it('refuses a reason longer than 500 characters', () => {
    mountCard();
    fireEvent.click(screen.getByRole('switch', { name: 'Full review' }));
    fireEvent.change(reason(), { target: { value: 'x'.repeat(501) } });
    expect(screen.getByText('The reason can have at most 500 characters.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Turn off', hidden: true }));
    expect(plain).not.toHaveBeenCalled();
  });

  it('sends Trusted and Stop through the step-up call, and leaves the switch alone when it is cancelled', async () => {
    guarded.call.mockResolvedValueOnce(fail(0, 'step-up.cancelled'));
    mountCard();
    fireEvent.click(screen.getByRole('switch', { name: 'Trusted from start' }));
    fireEvent.change(reason(), { target: { value: 'Long record.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on', hidden: true }));
    await waitFor(() => expect(guarded.call).toHaveBeenCalledTimes(1));
    expect(guarded.call).toHaveBeenCalledWith(
      'PUT',
      `sellers/admin/${SELLER}/offer-review/trusted`,
      { on: true, reason: 'Long record.', expectedVersion: 4 },
      'csrf',
    );
    expect(
      screen
        .getByRole('switch', { name: 'Trusted from start', hidden: true })
        .getAttribute('aria-checked'),
    ).toBe('false');
    expect(screen.queryByRole('alert')).toBeNull();
    guarded.call.mockResolvedValueOnce(ok({ on: true, changed: true, version: 5 }));
    fireEvent.click(screen.getByRole('button', { name: 'Turn on', hidden: true }));
    await waitFor(() =>
      expect(
        screen.getByRole('switch', { name: 'Trusted from start' }).getAttribute('aria-checked'),
      ).toBe('true'),
    );
  });

  it('reloads the flags and says so on a stale version', async () => {
    guarded.call.mockResolvedValue(fail(409, 'conflict.stale'));
    plain.mockResolvedValue(
      ok({
        trustedFromStart: { on: true, changedAt: '2026-11-25T00:00:00Z' },
        fullReview: { on: true, changedAt: null },
        reviewStop: { on: false, changedAt: null },
        version: 9,
      }),
    );
    mountCard();
    fireEvent.click(screen.getByRole('switch', { name: 'Stop' }));
    fireEvent.change(reason(), { target: { value: 'Investigating.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on stop', hidden: true }));
    expect(await screen.findByText(/flags changed since you opened this page/)).toBeTruthy();
    expect(plain).toHaveBeenCalledWith('GET', `sellers/admin/${SELLER}/offer-review`);
    expect(
      screen.getByRole('switch', { name: 'Trusted from start' }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('keeps the dialog open and says what the API refused', async () => {
    guarded.call.mockResolvedValue(fail(403, 'access.acting-as-refused'));
    mountCard();
    fireEvent.click(screen.getByRole('switch', { name: 'Stop' }));
    fireEvent.change(reason(), { target: { value: 'Investigating.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn on stop', hidden: true }));
    expect(await screen.findByText(/while you are acting as a seller/)).toBeTruthy();
  });

  it('says the flags could not be read, with the standing still shown', () => {
    mountCard(ALL, null);
    expect(screen.getByText(/review flags could not be read/)).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText('Probation')).toBeTruthy();
  });
});

const CAT_A = '0190a000-0000-7000-8000-0000000000d1';
const CAT_B = '0190a000-0000-7000-8000-0000000000d2';
const CHOICES = [
  { id: CAT_A, label: 'Food > Dates' },
  { id: CAT_B, label: 'Food > Meat' },
];
const row = (over = {}) => ({
  categoryId: CAT_A,
  alwaysReview: true,
  reviewStop: false,
  alwaysReviewChangedAt: '2026-11-20T00:00:00Z',
  reviewStopChangedAt: null,
  version: 3,
  ...over,
});

describe('CategoryFlags', () => {
  const mount = (initial = [row()], canAlways = true, canStop = true) =>
    render(
      wrap(
        <CategoryFlags
          initial={initial}
          choices={CHOICES}
          canAlways={canAlways}
          canStop={canStop}
          csrfToken="csrf"
          zone="Australia/Brisbane"
        />,
      ),
    );

  it('lists the flagged categories by path, with both flags and the last change', () => {
    mount();
    const table = screen.getByRole('table', { name: 'Categories with an Offer review flag' });
    expect(within(table).getByRole('rowheader', { name: 'Food > Dates' })).toBeTruthy();
    expect(
      within(table)
        .getByRole('switch', { name: 'Always review Food > Dates' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      within(table)
        .getByRole('switch', { name: 'Review stop for Food > Dates' })
        .getAttribute('aria-checked'),
    ).toBe('false');
  });

  it('says there are no flagged categories', () => {
    mount([]);
    expect(screen.getByText('No flagged categories.')).toBeTruthy();
  });

  it('adds a category from the picker and switches it with version 0, a reason and the step-up call', async () => {
    guarded.call.mockResolvedValue(ok({ on: true, changed: true, version: 1 }));
    mount();
    fireEvent.change(screen.getByRole('combobox', { name: 'Add a category' }), {
      target: { value: CAT_B },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Review stop for Food > Meat' }));
    const dialog = screen.getByRole('dialog', { hidden: true });
    expect(within(dialog).getByText('Applies to sub-categories too.')).toBeTruthy();
    fireEvent.change(reason(), { target: { value: 'Supplier recall.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Turn on stop', hidden: true }));
    await waitFor(() => expect(guarded.call).toHaveBeenCalledTimes(1));
    expect(guarded.call).toHaveBeenCalledWith(
      'PUT',
      `catalog/admin/categories/${CAT_B}/offer-review-stop`,
      { on: true, reason: 'Supplier recall.', expectedVersion: 0 },
      'csrf',
    );
    expect(
      (await screen.findByRole('switch', { name: 'Review stop for Food > Meat' })).getAttribute(
        'aria-checked',
      ),
    ).toBe('true');
  });

  it('turns Always review off through its own route with the listed version', async () => {
    guarded.call.mockResolvedValue(ok({ on: false, changed: true, version: 4 }));
    mount();
    fireEvent.click(screen.getByRole('switch', { name: 'Always review Food > Dates' }));
    fireEvent.change(reason(), { target: { value: 'Policy changed.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Turn off', hidden: true }));
    await waitFor(() =>
      expect(guarded.call).toHaveBeenCalledWith(
        'PUT',
        `catalog/admin/categories/${CAT_A}/offer-review`,
        { on: false, reason: 'Policy changed.', expectedVersion: 3 },
        'csrf',
      ),
    );
  });

  it('is read-only without the manage keys', () => {
    mount([row()], false, false);
    expect(
      screen.getByRole<HTMLButtonElement>('switch', { name: 'Always review Food > Dates' })
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/view these flags but not change them/)).toBeTruthy();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
