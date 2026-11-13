// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import { relay } from '../../server/bff.ts';
import type { PanelConfig } from '../../server/config.ts';

vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { reviewProblemOf } from './errors.ts';
import { ReviewView } from './review-view.tsx';
import type { ReviewPage } from './types.ts';

const call = vi.mocked(callApi);
const CERT = '0190a000-0000-7000-8000-0000000000c1';
const SUB = '0190a000-0000-7000-8000-0000000000d1';
const page = (over: Partial<ReviewPage> = {}): ReviewPage => ({
  certificate: {
    certificateId: CERT,
    sellerId: '0190a000-0000-7000-8000-00000000abcd',
    typeCode: 'halal',
    status: 'awaiting-review',
    version: 4,
    createdAt: '2026-11-01T00:00:00.000Z',
  },
  submission: {
    submissionId: SUB,
    submissionNo: 2,
    kind: 'resubmission',
    pending: true,
    verificationMode: 'third-party-document',
    requiresDocument: true,
    requiresExpiry: true,
    issuer: { issuerId: 'i1', displayName: 'Halal Authority', state: 'active' },
    certificateNumber: 'HC-123',
    issueDate: '2026-01-01',
    expiryDate: '2027-01-01',
    selfDeclared: null,
    selfDeclarationNote: null,
    submittedZone: 'Australia/Brisbane',
    submittedAt: '2026-11-09T01:00:00.000Z',
  },
  documents: [{ position: 0, mediaType: 'application/pdf', byteSize: 1258291, pageCount: 2 }],
  checks: [
    { code: 'number-readable', required: true, result: null, recordedAt: null },
    { code: 'seal', required: false, result: 'done', recordedAt: '2026-11-09T02:00:00.000Z' },
  ],
  scope: null,
  confirmation: null,
  reasons: {
    'changes-requested': [{ code: 'unreadable', check: null, nextStep: 'Send a clearer scan' }],
    declined: [{ code: 'not-accepted', check: null, nextStep: 'Use an accepted issuer' }],
  },
  duplicateHints: [],
  business: { status: 'ok', businessName: 'Acme Pty Ltd', storeName: 'Acme Store' },
  history: [],
  decision: null,
  ...over,
});
const view = (p: ReviewPage, canReview = true, canDecide = true) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <ReviewView
        page={p}
        typeName="Halal"
        canReview={canReview}
        canDecide={canDecide}
        csrfToken="t"
      />
    </NextIntlClientProvider>,
  );

beforeEach(() => {
  call.mockReset();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

describe('review page', () => {
  it('shows the submission, the documents without a file name, and the seller fallback', () => {
    view(page({ business: { status: 'not-found' } }));
    expect(screen.getByText('HC-123')).toBeTruthy();
    expect(screen.getByText('File 1 · PDF · 2 pages · 1.2 MB')).toBeTruthy();
    expect(screen.getByText(/Not yet approved/)).toBeTruthy();
    expect(screen.getByText("The seller's business details were not found.")).toBeTruthy();
  });

  it('names the missing required checks as text and keeps Approve from opening', () => {
    view(page());
    expect(screen.getByText('Record 1 required check first.')).toBeTruthy();
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(approve.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(approve);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('records a check with the submission it saw', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    view(page());
    fireEvent.click(screen.getAllByLabelText('Done')[0]!);
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'POST',
      `certification/admin/seller-certificates/${CERT}/checks`,
      { submissionId: SUB, checkCode: 'number-readable', result: 'done' },
      't',
    );
  });

  it('records the location and scope, both required', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    view(page());
    fireEvent.click(screen.getByRole('button', { name: 'Save location and scope' }));
    expect(screen.getAllByText('This is required.')).toHaveLength(2);
    expect(call).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: ' Brisbane ' } });
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'Beef' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save location and scope' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]?.[2]).toEqual({
      submissionId: SUB,
      location: 'Brisbane',
      scope: 'Beef',
    });
  });

  it('approves with the record version read and goes back to the queue', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    call.mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    view(page({ checks: [{ code: 'seal', required: true, result: 'done', recordedAt: 'x' }] }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve certificate' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'POST',
      `certification/admin/seller-certificates/${CERT}/approve`,
      { submissionId: SUB, version: 4 },
      't',
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/certificates?decided=approve'));
    vi.unstubAllGlobals();
  });

  it('needs a prepared reason to request changes and sends it with the note', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    view(page());
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Request changes' }).at(-1)!);
    expect(screen.getByText('Choose a reason.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Prepared reason/), { target: { value: 'unreadable' } });
    fireEvent.change(screen.getByLabelText(/Note for the seller/), {
      target: { value: ' Retake ' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Request changes' }).at(-1)!);
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]?.[1]).toBe(
      `certification/admin/seller-certificates/${CERT}/request-changes`,
    );
    expect(call.mock.calls[0]?.[2]).toEqual({
      submissionId: SUB,
      version: 4,
      reasonCode: 'unreadable',
      reasonText: 'Retake',
    });
  });

  it('shows a refused decision as text and offers Reload when the record changed', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 409, code: 'conflict.stale' } });
    view(page({ checks: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve certificate' }));
    expect(await screen.findByText(/changed while you reviewed/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload the page' })).toBeTruthy();
  });

  it('gives a review-only role no decision buttons and no checks to record', () => {
    view(page(), true, false);
    expect(screen.getByText("Your role can't decide certificates.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('shows a decided or withdrawn submission read-only', () => {
    view(page({ submission: { ...page().submission, pending: false } }));
    expect(screen.getByText(/can no longer be decided/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save location and scope' })).toBeNull();
  });

  it('warns for a closed or derecognised issuer', () => {
    view(
      page({
        submission: {
          ...page().submission,
          issuer: { issuerId: 'i', displayName: 'X', state: 'closed-to-new' },
        },
      }),
    );
    expect(screen.getAllByText(/isn't taking new certificates/).length).toBeGreaterThan(0);
  });

  it('lists a duplicate hint with the opening recorded', () => {
    view(page({ duplicateHints: [{ kind: 'number', certificateId: CERT, storeName: null }] }));
    expect(
      screen
        .getByRole('link', { name: /Same certificate number as Not yet approved/ })
        .getAttribute('href'),
    ).toBe(`/certificates/${CERT}?reason=duplicate-hint`);
  });
});

describe('review errors', () => {
  it('maps the codes of the design and reloads when the record moved', () => {
    expect(reviewProblemOf({ status: 409, code: 'review.not-current-submission' })).toEqual({
      key: 'certificates.review.error.replaced',
      reload: true,
    });
    expect(reviewProblemOf({ status: 422, code: 'review.checks-incomplete' }).reload).toBe(false);
    expect(reviewProblemOf({ status: 0, code: 'x' }).key).toBe(
      'certificates.review.error.unavailable',
    );
    expect(reviewProblemOf({ status: 400, code: 'x' }).key).toBe(
      'certificates.review.error.unknown',
    );
  });
});

describe('review relay', () => {
  const config: PanelConfig = {
    apiBaseUrl: 'http://api.test',
    hosts: [
      { origin: 'http://admin.localhost:3002', host: 'admin.localhost:3002', marketId: 'AU' },
    ],
    passwordMinLength: 15,
    passwordMaxLength: 128,
    marketName: 'Australia',
    locale: 'en-AU',
    supportEmail: 'support@example.com',
    clientAddressKey: null,
  };
  const send = async (method: string, target: string) => {
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('{}', { status: 200 })),
    );
    const request = new Request(`http://admin.localhost:3002/api/${target}`, {
      method,
      headers: {
        host: 'admin.localhost:3002',
        origin: 'http://admin.localhost:3002',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      ...(method === 'GET' ? {} : { body: '{}' }),
    });
    await relay(config, request, target.split('/'), upstream);
    return upstream.mock.calls.length;
  };

  it('relays the checks, scope and three decisions, and not revoke, confirmation or documents', async () => {
    const base = `certification/admin/seller-certificates/${CERT}`;
    for (const action of ['checks', 'scope', 'approve', 'request-changes', 'decline']) {
      expect(await send('POST', `${base}/${action}`)).toBe(1);
    }
    for (const action of ['revoke', 'issuer-confirmation']) {
      expect(await send('POST', `${base}/${action}`)).toBe(0);
    }
    expect(await send('GET', `${base}/documents/${SUB}`)).toBe(0);
    expect(await send('POST', 'certification/admin/seller-certificates/not-an-id/approve')).toBe(0);
  });
});
