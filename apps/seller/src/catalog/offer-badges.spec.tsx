// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import type { CertificateSummary } from '../certificates/types.ts';

vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { badgeChoicesOf, badgeErrorOf } from './offer-badges-logic.ts';
import { OfferBadges } from './offer-badges.tsx';
import type { OfferTag } from './types.ts';

const call = vi.mocked(callApi);
const NAMES = { halal: 'Halal', kosher: 'Kosher' };

function mount(
  props: Partial<{
    tags: readonly OfferTag[];
    choices: readonly { typeCode: string; name: string }[];
    canEdit: boolean;
  }> = {},
) {
  return render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <OfferBadges
        offerId="o1"
        csrfToken="csrf"
        tags={props.tags ?? []}
        choices={props.choices ?? [{ typeCode: 'halal', name: 'Halal' }]}
        names={NAMES}
        canEdit={props.canEdit ?? true}
      />
    </NextIntlClientProvider>,
  );
}

const tag = (status: string, typeCode = 'halal'): OfferTag => ({
  typeCode,
  status,
  basis: null,
  reasonCode: null,
});

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('OfferBadges', () => {
  it('adds the Halal badge a seller with an approved certificate asks for', async () => {
    call.mockResolvedValue({ ok: true, status: 201, body: { applied: true, status: 'active' } });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add the Halal badge' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        'catalog/seller/offers/o1/tags',
        { typeCode: 'halal' },
        'csrf',
      ),
    );
    expect(await screen.findByText('The badge is on the offer.')).toBeTruthy();
  });

  it('says a held badge waits for our check', async () => {
    call.mockResolvedValue({ ok: true, status: 201, body: { applied: false, status: 'held' } });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add the Halal badge' }));
    expect(await screen.findByText(/waiting for our check/)).toBeTruthy();
  });

  it('shows a refusal in words', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: { status: 422, code: 'claim.tag-not-allowed' },
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add the Halal badge' }));
    expect(await screen.findByText(/no approved certificate of this type/)).toBeTruthy();
  });

  it('removes an active badge and sells a suspended one without it', async () => {
    call.mockResolvedValue({ ok: true, status: 204, body: null });
    mount({ tags: [tag('active'), tag('suspended', 'kosher')], choices: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Remove badge' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'DELETE',
        'catalog/seller/offers/o1/tags/halal',
        undefined,
        'csrf',
      ),
    );
    await screen.findByText('The badge is off the offer.');
    fireEvent.click(screen.getByRole('button', { name: 'Sell without this badge' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        'catalog/seller/offers/o1/tags/kosher/sell-without-badge',
        { confirmSellWithoutBadge: true },
        'csrf',
      ),
    );
  });

  it('offers no buttons without the edit permission, and nothing when there is nothing to say', () => {
    mount({ tags: [tag('active')], canEdit: false });
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    const { container } = mount({ canEdit: false, choices: [] });
    expect(container.textContent).toBe('');
  });

  it('points to the certificates when none is approved', () => {
    mount({ choices: [] });
    expect(screen.getByRole('link', { name: 'Go to your certificates' })).toBeTruthy();
  });
});

describe('badgeChoicesOf', () => {
  const cert = (typeCode: string, status: string): CertificateSummary => ({
    certificateId: typeCode + status,
    typeCode,
    status,
    recordStatus: 'x',
    submitBy: null,
    editable: false,
    deletable: false,
    withdrawable: false,
    createdAt: '',
    lastChangedAt: '',
  });
  it('lists approved types the offer does not carry, once each', () => {
    const names = new Map([['halal', 'Halal']]);
    const list = [
      cert('halal', 'approved'),
      cert('halal', 'approved-expiring'),
      cert('kosher', 'awaiting-review'),
      cert('organic', 'approved'),
      cert('vegan', 'expired'),
    ];
    expect(badgeChoicesOf(list, ['organic'], names)).toEqual([
      { typeCode: 'halal', name: 'Halal' },
    ]);
  });
  it('maps refusals to message keys', () => {
    expect(badgeErrorOf({ status: 422, code: 'claim.tag-not-allowed' })).toBe(
      'catalog.badges.error.not-allowed',
    );
    expect(badgeErrorOf({ status: 503, code: 'x' })).toBe('catalog.badges.error.unavailable');
    expect(badgeErrorOf({ status: 418, code: 'x' })).toBe('catalog.badges.error.unknown');
  });
});
