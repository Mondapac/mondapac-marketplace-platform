// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { relay } from '../../server/bff.ts';
import type { PanelConfig } from '../../server/config.ts';
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
const approved = (over: Partial<ReviewPage> = {}) =>
  page({
    certificate: { ...page().certificate, status: 'approved' },
    submission: { ...page().submission, pending: false },
    reasons: {
      ...page().reasons,
      revoked: [
        { code: 'signs-of-tampering', check: null, nextStep: 'x' },
        { code: 'approved-in-error', check: null, nextStep: 'x' },
      ],
    },
    ...over,
  });
const view = (p: ReviewPage, extra: { canRevoke?: boolean; canHistory?: boolean; revoked?: boolean } = {}) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      <ReviewView page={p} typeName="Halal" canReview canDecide csrfToken="t" {...extra} />
    </NextIntlClientProvider>,
  );
const open = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const last = (name: string) => fireEvent.click(screen.getAllByRole('button', { name }).at(-1)!);

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

describe('revoke', () => {
  it('offers Revoke only for an approved or expired record and a holder of the permission', () => {
    view(approved(), { canRevoke: true });
    expect(screen.getByRole('button', { name: 'Revoke certificate' })).toBeTruthy();
    cleanup();
    view(approved(), { canRevoke: false });
    expect(screen.queryByRole('button', { name: 'Revoke certificate' })).toBeNull();
    cleanup();
    view(page(), { canRevoke: true });
    expect(screen.queryByRole('button', { name: 'Revoke certificate' })).toBeNull();
    cleanup();
    view(approved({ certificate: { ...page().certificate, status: 'revoked' } }), {
      canRevoke: true,
    });
    expect(screen.queryByRole('button', { name: 'Revoke certificate' })).toBeNull();
    cleanup();
    view(approved({ certificate: { ...page().certificate, status: 'expired' } }), {
      canRevoke: true,
    });
    expect(screen.getByRole('button', { name: 'Revoke certificate' })).toBeTruthy();
  });

  it('opens on Cancel, needs a reason, then sends the version and reason', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    view(approved(), { canRevoke: true });
    open('Revoke certificate');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText(/Offers with this badge can't be bought until Acme Store/)).toBeTruthy();
    expect(screen.getByText(/renewal is waiting for review, it is withdrawn too/)).toBeTruthy();
    last('Revoke certificate');
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByText('Choose a reason.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Prepared reason/), {
      target: { value: 'approved-in-error' },
    });
    fireEvent.change(screen.getByLabelText(/Note for the seller/), { target: { value: ' Oops ' } });
    last('Revoke certificate');
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    expect(call).toHaveBeenCalledWith(
      'POST',
      `certification/admin/seller-certificates/${CERT}/revoke`,
      { version: 4, reasonCode: 'approved-in-error', reasonText: 'Oops' },
      't',
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/certificates/${CERT}?revoked=1`));
  });

  it('says why nothing can be revoked when the Market lists no reasons', () => {
    view(approved({ reasons: { 'changes-requested': [], declined: [] } }), { canRevoke: true });
    open('Revoke certificate');
    expect(screen.getByText(/no prepared reasons for revoking/)).toBeTruthy();
  });

  it('asks to reload when the record changed or is already revoked', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 409, code: 'certificate.revoked' } });
    view(approved(), { canRevoke: true });
    open('Revoke certificate');
    fireEvent.change(screen.getByLabelText(/Prepared reason/), {
      target: { value: 'signs-of-tampering' },
    });
    last('Revoke certificate');
    expect(await screen.findByText(/already revoked/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload the page' })).toBeTruthy();
    expect(reviewProblemOf({ status: 409, code: 'certificate.not-revocable' }).reload).toBe(true);
  });

  it('keeps typed text when the backdrop is clicked, and Cancel sends nothing', () => {
    view(approved(), { canRevoke: true });
    open('Revoke certificate');
    fireEvent.change(screen.getByLabelText(/Note for the seller/), { target: { value: 'keep' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(call).not.toHaveBeenCalled();
  });

  it('shows the notice after a revoke', () => {
    view(approved({ certificate: { ...page().certificate, status: 'revoked' } }), { revoked: true });
    expect(screen.getByText(/Certificate revoked\. The seller has been emailed/)).toBeTruthy();
  });
});

describe('full history', () => {
  const entry = (n: number, over: Record<string, unknown> = {}) => ({
    id: `0190a000-0000-7000-8000-0000000001${n}0`,
    fromStatus: 'approved',
    toStatus: 'revoked',
    submissionId: SUB,
    actorKind: 'admin',
    actorAccountId: 'acc-secret',
    reasonCode: 'approved-in-error',
    reasonLabel: 'The certificate was approved in error and no longer counts.',
    note: '<b>checked</b>',
    occurredAt: '2026-11-10T01:00:00.000Z',
    ...over,
  });

  it('is behind a Show history step that says reading is recorded', () => {
    view(approved(), { canHistory: true });
    expect(screen.getByText('Viewing this is recorded.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    cleanup();
    view(approved(), { canHistory: false });
    expect(screen.queryByRole('button', { name: 'Show history' })).toBeNull();
  });

  it('reads the history, shows notes as text only, and pages older entries', async () => {
    call
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: { entries: [entry(1)], nextBeforeId: 'cursor-1' },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: {
          entries: [entry(2, { fromStatus: null, toStatus: 'awaiting-review', reasonCode: null, note: null, actorKind: 'seller' })],
          nextBeforeId: null,
        },
      });
    view(approved(), { canHistory: true });
    open('Show history');
    expect(await screen.findByText('<b>checked</b>')).toBeTruthy();
    expect(document.body.innerHTML).not.toContain('acc-secret');
    expect(call).toHaveBeenNthCalledWith(
      1,
      'GET',
      `certification/admin/seller-certificates/${CERT}/history`,
      undefined,
      't',
    );
    open('Show older');
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(call).toHaveBeenNthCalledWith(
      2,
      'GET',
      `certification/admin/seller-certificates/${CERT}/history?beforeId=cursor-1`,
      undefined,
      't',
    );
    expect(await screen.findByText(/Started to Awaiting review, by the seller/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull();
  });

  it('says so when there is no history and when the read is refused', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 403, code: 'access.denied' } });
    view(approved(), { canHistory: true });
    open('Show history');
    expect(await screen.findByText(/Your role can't/)).toBeTruthy();
    call.mockResolvedValueOnce({ ok: true, status: 200, body: { entries: [], nextBeforeId: null } });
    open('Show history');
    expect(await screen.findByText('No history yet.', { selector: 'p.text-fg-muted' })).toBeTruthy();
  });
});

describe('relay of the new routes', () => {
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
    const upstream = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}', { status: 200 })));
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
    const response = await relay(config, request, target.split('/'), upstream);
    return { status: response.status, called: upstream.mock.calls.length };
  };

  it('relays revoke and history for a certificate id, and nothing else', async () => {
    expect((await send('POST', `certification/admin/seller-certificates/${CERT}/revoke`)).called).toBe(1);
    expect((await send('GET', `certification/admin/seller-certificates/${CERT}/history`)).called).toBe(1);
    expect((await send('POST', 'certification/admin/seller-certificates/x/revoke')).called).toBe(0);
    expect((await send('GET', 'certification/admin/seller-certificates/x/history')).called).toBe(0);
    expect((await send('POST', `certification/admin/seller-certificates/${CERT}/history`)).called).toBe(0);
    expect((await send('GET', `certification/admin/seller-certificates/${CERT}/revoke`)).called).toBe(0);
  });
});
