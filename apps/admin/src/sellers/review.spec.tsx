// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve(createTranslator({ locale: 'en-AU', messages })),
}));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { SellersList } from './sellers-list.tsx';
import { ReviewView } from './review-view.tsx';
import type { ReviewContent, ReviewRead, ReviewRevision } from './review-types.ts';

const content = (over: Partial<ReviewContent> = {}): ReviewContent => ({
  storeName: 'Cedar Lane Halal Meats',
  businessName: 'Cedar Lane Pty Ltd',
  phone: '+61 7 3000 0000',
  contactEmail: 'owner@example.test',
  address: { line1: '1 Cedar Lane', postalCode: '4000' },
  registeredAddress: null,
  identifier: { scheme: 'ABN', value: '51824753556', display: '51 824 753 556' },
  registeredForIndirectTax: true,
  ...over,
});
const revision = (over: Partial<ReviewRevision> = {}): ReviewRevision => ({
  id: '0190a000-0000-7000-8000-0000000000b1',
  kind: 'onboarding',
  revisionNo: 1,
  status: 'pending',
  createdAt: '2026-10-08T01:00:00.000Z',
  serviceAreaCode: 'AU-QLD-BNE',
  operatingTimezone: 'Australia/Brisbane',
  registerAtSubmission: {
    outcome: 'active',
    mismatches: [],
    checkedAt: '2026-10-08T00:59:00.000Z',
  },
  content: content(),
  ...over,
});
const review = (over: Partial<ReviewRead> = {}): ReviewRead => ({
  sellerId: '0190a000-0000-7000-8000-000000000001',
  access: 'pending',
  current: revision(),
  previous: null,
  register: {
    lookup: 'configured',
    state: 'active',
    mismatches: [],
    staleReason: null,
    checkedAt: '2026-10-08T00:59:00.000Z',
    blocksApproval: false,
  },
  ...over,
});

describe('admin seller review page', () => {
  afterEach(cleanup);

  it('shows the application read only, with business details and no decision buttons', async () => {
    render(await ReviewView({ review: review() }));
    expect(screen.getByRole('heading', { name: 'Cedar Lane Halal Meats' })).toBeTruthy();
    expect(screen.getByText('Awaiting approval')).toBeTruthy();
    expect(screen.getByText('Cedar Lane Pty Ltd')).toBeTruthy();
    expect(screen.getByText('ABN 51 824 753 556')).toBeTruthy();
    expect(screen.getByText(/Line1: 1 Cedar Lane/)).toBeTruthy();
    expect(screen.getByText(/Postal code: 4000/)).toBeTruthy();
    expect(screen.getByText(/Approving or rejecting it is not available yet/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('marks the fields a change request alters against the approved revision', async () => {
    render(
      await ReviewView({
        review: review({
          access: 'approved',
          current: revision({
            kind: 'identity-change',
            revisionNo: 2,
            content: content({ businessName: 'Cedar Lane Trading Pty Ltd' }),
          }),
          previous: revision({ status: 'approved' }),
        }),
      }),
    );
    expect(screen.getByText('Proposed changes')).toBeTruthy();
    expect(screen.getByText('Approved details')).toBeTruthy();
    expect(screen.getAllByText('Changed')).toHaveLength(1);
  });

  it('says approval is blocked, and names the register differences', async () => {
    render(
      await ReviewView({
        review: review({
          register: {
            lookup: 'configured',
            state: 'negative',
            mismatches: ['postcode', 'brand-new'],
            staleReason: null,
            checkedAt: null,
            blocksApproval: true,
          },
        }),
      }),
    );
    expect(screen.getByText('Not found or cancelled')).toBeTruthy();
    expect(screen.getByText('Postcode, Other')).toBeTruthy();
    expect(screen.getByText(/Blocked until the register check passes/)).toBeTruthy();
  });

  it('explains a market with no register lookup', async () => {
    render(
      await ReviewView({
        review: review({
          register: {
            lookup: 'none',
            state: 'not-performed',
            mismatches: [],
            staleReason: null,
            checkedAt: null,
            blocksApproval: true,
          },
        }),
      }),
    );
    expect(screen.getByText(/no register lookup/)).toBeTruthy();
  });

  it('renders seller-written text as text, and unknown states as Unknown', async () => {
    render(
      await ReviewView({
        review: review({
          access: 'weird',
          current: revision({ content: content({ businessName: '<img src=x onerror=alert(1)>' }) }),
        }),
      }),
    );
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(within(document.body).getAllByText('Unknown').length).toBeGreaterThan(0);
  });

  it('links list rows to the review page only for an actor who may open it', async () => {
    const call = vi.mocked(callApi);
    const row = {
      sellerId: '0190a000-0000-7000-8000-000000000001',
      storeName: 'Cedar Lane Halal Meats',
      slug: 'cedar-lane',
      status: 'awaiting-review',
      origin: 'self' as const,
      kind: 'onboarding',
      submittedAt: null,
      serviceAreaCode: null,
      timezone: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      lastChangedAt: '2026-10-08T01:00:00.000Z',
    };
    const body = {
      tab: 'awaiting-review' as const,
      items: [row],
      next: null,
      counts: { awaitingReview: { onboarding: 1, identityChange: 0 }, incomplete: 0, all: 1 },
    };
    for (const canReview of [true, false]) {
      call.mockResolvedValueOnce({ ok: true, status: 200, body });
      render(
        <NextIntlClientProvider locale="en-AU" messages={messages}>
          <SellersList csrfToken="c" canReview={canReview} />
        </NextIntlClientProvider>,
      );
      await screen.findByText('Cedar Lane Halal Meats');
      const link = screen.queryByRole('link', { name: 'Cedar Lane Halal Meats' });
      expect(link?.getAttribute('href') ?? null).toBe(
        canReview ? `/sellers/${row.sellerId}` : null,
      );
      cleanup();
    }
  });
});
