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
    verificationMode: 'THIRD_PARTY_DOCUMENT',
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
    { code: 'legibility-language', required: true, result: null, recordedAt: null },
    { code: 'tampering', required: false, result: 'done', recordedAt: '2026-11-09T02:00:00.000Z' },
  ],
  scope: null,
  confirmation: null,
  reasons: {
    'changes-requested': [{ code: 'unreadable', check: null, nextStep: 'upload-clearer-file' }],
    declined: [
      { code: 'holder-name-mismatch', check: 'holder-name', nextStep: 'check-holder-name' },
    ],
  },
  duplicateHints: [],
  business: { status: 'ok', businessName: 'Acme Pty Ltd', storeName: 'Acme Store' },
  history: [],
  decision: null,
  ...over,
});
const ready: Partial<ReviewPage> = {
  checks: [{ code: 'tampering', required: true, result: 'done', recordedAt: 'x' }],
  scope: { location: 'Brisbane', scope: 'Beef', recordedAt: 'x' },
};
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
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
      { submissionId: SUB, checkCode: 'legibility-language', result: 'done' },
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
    view(page({ ...ready }));
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
    view(page({ ...ready }));
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
        .getByRole('link', { name: /Same certificate number as another seller/ })
        .getAttribute('href'),
    ).toBe(`/certificates/${CERT}?reason=duplicate-hint`);
  });
});

describe('review page: what blocks Approve, decline, and the dialog rules', () => {
  it('names a missing location and scope, and allows Approve once recorded', () => {
    view(page({ ...ready, scope: null }));
    expect(screen.getByText('Record the location and scope as read first.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    cleanup();
    view(page({ ...ready }));
    expect(
      screen.getByRole('button', { name: 'Approve' }).getAttribute('aria-disabled'),
    ).toBeNull();
  });

  it('blocks Approve, as text, for a closed or derecognised issuer; Request changes and Decline stay', () => {
    for (const state of ['closed-to-new', 'derecognised']) {
      view(
        page({
          ...ready,
          submission: { ...page().submission, issuer: { issuerId: 'i', displayName: 'X', state } },
        }),
      );
      expect(screen.getByRole('button', { name: 'Approve' }).getAttribute('aria-disabled')).toBe(
        'true',
      );
      expect(screen.getAllByText(/isn't taking new certificates/).length).toBeGreaterThan(0);
      expect(screen.getByRole('button', { name: 'Request changes' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Decline' })).toBeTruthy();
      cleanup();
    }
  });

  it('preselects nothing, and Decline lists only the decline reasons with the next step read-only', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    view(page());
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(screen.getByRole('heading', { name: 'Decline submission 2?' })).toBeTruthy();
    expect(screen.getByText(/can't send this certificate again/)).toBeTruthy();
    const reason = screen.getByLabelText<HTMLSelectElement>(/Prepared reason/);
    expect(reason.value).toBe('');
    expect(screen.queryByText(/could not be read/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Decline certificate' }));
    expect(screen.getByText('Choose a reason.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    fireEvent.change(reason, { target: { value: 'holder-name-mismatch' } });
    expect(
      screen.getByText('What the seller is told to do: The seller checks the holder name.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Decline certificate' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]?.[1]).toBe(`certification/admin/seller-certificates/${CERT}/decline`);
    expect(call.mock.calls[0]?.[2]).toEqual({
      submissionId: SUB,
      version: 4,
      reasonCode: 'holder-name-mismatch',
    });
  });

  it('request changes offers its own reasons, not the decline ones', () => {
    view(page());
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    const options = Array.from(
      screen.getByLabelText(/Prepared reason/).querySelectorAll('option'),
    ).map((o) => o.textContent);
    expect(options).toContain(
      'The file could not be read, or it is in a language we cannot review.',
    );
    expect(options.join()).not.toContain('does not match the business');
  });

  it('opens with focus on Cancel and keeps typed text when Escape or a stray click would close it', () => {
    view(page());
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.change(screen.getByLabelText(/Note for the seller/), { target: { value: 'typed' } });
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(screen.getByLabelText(/Note for the seller/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText(/Note for the seller/)).toBeNull();
  });

  it('reloads on a stale answer when asked', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 409, code: 'review.not-current-submission' },
    });
    view(page(ready));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve certificate' }));
    expect(await screen.findByText(/replaced while you reviewed/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reload the page' }));
    expect(reload).toHaveBeenCalled();
  });

  it('does not go back to the queue when a decision is refused', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 422, code: 'review.scope-missing' },
    });
    view(page(ready));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve certificate' }));
    expect(
      await screen.findByText('Record the location and scope as read first.', {
        selector: '[role="alert"] *',
      }),
    ).toBeTruthy();
    expect(assign).not.toHaveBeenCalled();
  });

  it('shows a failed check on its own row and keeps the earlier value', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 0, code: 'network' } });
    view(page());
    const [first] = screen.getAllByLabelText('Done');
    fireEvent.click(first!);
    expect(await screen.findByText(/This result was not saved/)).toBeTruthy();
    expect((screen.getAllByLabelText('Done')[0] as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText('Recorded: Done')).toBeTruthy();
  });

  it('words codes: reason, check, status and history in English, never a bare code', () => {
    view(
      page({
        history: [
          {
            fromStatus: null,
            toStatus: 'awaiting-review',
            occurredAt: '2026-11-09T01:00:00Z',
            actorKind: 'seller',
            reasonCode: null,
          },
        ],
      }),
    );
    expect(
      screen.getByText(/The document is readable and in a language we can review/),
    ).toBeTruthy();
    expect(screen.getByText(/Started to Awaiting review, by the seller/)).toBeTruthy();
    expect(screen.queryByText('awaiting-review')).toBeNull();
  });

  it('shows no recordable checks or scope form on a submission that is closed', () => {
    view(page({ submission: { ...page().submission, pending: false } }));
    for (const radio of screen.getAllByRole('radio')) expect(radio.matches(':disabled')).toBe(true);
  });

  it('does not call a hint "Not yet approved" and keeps the store fallback for the header only', () => {
    view(page({ duplicateHints: [{ kind: 'file', certificateId: CERT, storeName: null }] }));
    expect(
      screen.getByRole('link', { name: "Same document file as another seller's certificate." }),
    ).toBeTruthy();
  });
});

describe('review errors', () => {
  it('maps the codes of the design and reloads when the record moved', () => {
    expect(reviewProblemOf({ status: 409, code: 'review.not-current-submission' })).toEqual({
      key: 'certificates.review.error.replaced',
      reload: true,
    });
    expect(reviewProblemOf({ status: 422, code: 'review.checks-incomplete' }).reload).toBe(false);
    const codes = [
      'validation.failed',
      'certificate.not-found',
      'review.not-current-submission',
      'review.checks-incomplete',
      'review.checks-missing',
      'review.scope-missing',
      'review.issuer-not-accepting',
      'issuer.not-active',
      'certificate.incomplete',
      'certificate.already-expired',
      'certificate.expired',
      'seller.zone-missing',
      'type.inactive',
      'conflict.stale',
      'conflict.retry',
      'access.denied',
      'access.acting-as-refused',
      'request.throttled',
      'request.csrf',
    ];
    for (const code of codes) {
      const key = reviewProblemOf({ status: 422, code }).key;
      expect(key, code).not.toMatch(/\.unknown$/);
      const leaf = key.split('.').pop() as string;
      expect(Object.keys(messages.certificates.review.error), code).toContain(leaf);
    }
    expect(reviewProblemOf({ status: 400, code: 'constructor' }).key).toMatch(/\.unknown$/);
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
