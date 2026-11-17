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
const view = (
  p: ReviewPage,
  extra: { canRevoke?: boolean; canHistory?: boolean; revoked?: boolean } = {},
) =>
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
    expect(
      screen.getByText(/Offers with this badge can't be bought until Acme Store/),
    ).toBeTruthy();
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
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 409, code: 'certificate.revoked' },
    });
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

  it('keeps typed text on Escape, and Cancel starts the next time clean', () => {
    view(approved(), { canRevoke: true });
    open('Revoke certificate');
    fireEvent.change(screen.getByLabelText(/Note for the seller/), { target: { value: 'keep' } });
    const dialog = document.querySelector('dialog')!;
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(screen.getByLabelText<HTMLTextAreaElement>(/Note for the seller/).value).toBe('keep');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(call).not.toHaveBeenCalled();
    open('Revoke certificate');
    expect(screen.getByLabelText<HTMLTextAreaElement>(/Note for the seller/).value).toBe('');
  });

  it('cannot be confirmed when the Market lists no reasons', () => {
    view(approved({ reasons: { 'changes-requested': [], declined: [] } }), { canRevoke: true });
    open('Revoke certificate');
    const confirm = screen.getAllByRole('button', { name: 'Revoke certificate' }).at(-1)!;
    expect(confirm).toHaveProperty('disabled', true);
  });

  it('blocks a note over the limit and omits a blank one', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    vi.stubGlobal('location', { assign: vi.fn() });
    view(approved({ certificate: { ...page().certificate, status: 'expired' } }), {
      canRevoke: true,
    });
    open('Revoke certificate');
    fireEvent.change(screen.getByLabelText(/Prepared reason/), {
      target: { value: 'signs-of-tampering' },
    });
    fireEvent.change(screen.getByLabelText(/Note for the seller/), {
      target: { value: 'x'.repeat(1001) },
    });
    last('Revoke certificate');
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByText('At most 1000 characters.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Note for the seller/), { target: { value: '   ' } });
    last('Revoke certificate');
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    expect(call.mock.calls[0]![2]).toEqual({ version: 4, reasonCode: 'signs-of-tampering' });
  });

  it.each([
    ['conflict.stale', 409, /changed while you reviewed/, true],
    ['access.denied', 403, /don't have permission/, false],
  ])('maps %s on revoke', async (code, status, text, reload) => {
    call.mockResolvedValueOnce({ ok: false, failure: { status, code } });
    view(approved(), { canRevoke: true });
    open('Revoke certificate');
    fireEvent.change(screen.getByLabelText(/Prepared reason/), {
      target: { value: 'signs-of-tampering' },
    });
    last('Revoke certificate');
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reload the page' }) !== null).toBe(reload);
  });

  it('shows the notice after a revoke', () => {
    view(approved({ certificate: { ...page().certificate, status: 'revoked' } }), {
      revoked: true,
    });
    expect(screen.getByText(/Certificate revoked\. The seller has been emailed/)).toBeTruthy();
    cleanup();
    view(approved(), { revoked: true });
    expect(screen.queryByText(/Certificate revoked\. The seller/)).toBeNull();
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
          entries: [
            entry(2, {
              fromStatus: null,
              toStatus: 'awaiting-review',
              reasonCode: null,
              note: null,
              actorKind: 'seller',
            }),
          ],
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
    expect(await screen.findByText(/Created → Awaiting review · by the seller/)).toBeTruthy();
    // Focus lands on the first row that was just loaded, not on the top of the list.
    await waitFor(() =>
      expect(document.activeElement?.textContent).toMatch(/Created → Awaiting review/),
    );
    expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull();
  });

  it('says so when there is no history and when the read is refused', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 403, code: 'access.denied' } });
    view(approved(), { canHistory: true });
    open('Show history');
    expect(await screen.findByText(/Your role can't/)).toBeTruthy();
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { entries: [], nextBeforeId: null },
    });
    open('Show history');
    const none = await screen.findByText('No history yet.', { selector: 'p.text-fg-muted' });
    expect(none).toBeTruthy();
    await waitFor(() => expect(document.activeElement?.textContent).toBe('No history yet.'));
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
    const response = await relay(config, request, target.split('/'), upstream);
    return { status: response.status, called: upstream.mock.calls.length };
  };

  it('passes only a UUID beforeId and a small limit of the history query', async () => {
    const calls: string[] = [];
    const upstream = vi.fn<typeof fetch>((input) => {
      calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return Promise.resolve(new Response('{}', { status: 200 }));
    });
    const go = (query: string) =>
      relay(
        config,
        new Request(
          `http://admin.localhost:3002/api/certification/admin/seller-certificates/${CERT}/history${query}`,
          {
            method: 'GET',
            headers: {
              host: 'admin.localhost:3002',
              origin: 'http://admin.localhost:3002',
              'sec-fetch-site': 'same-origin',
            },
          },
        ),
        `certification/admin/seller-certificates/${CERT}/history`.split('/'),
        upstream,
      );
    await go(`?beforeId=${SUB}&limit=20&x=1`);
    await go('?beforeId=not-a-uuid&limit=abc');
    expect(calls[0]).toContain(`beforeId=${SUB}`);
    expect(calls[0]).toContain('limit=20');
    expect(calls[0]).not.toContain('x=1');
    expect(calls[1]).not.toContain('beforeId');
    expect(calls[1]).not.toContain('limit');
  });

  it('relays revoke and history for a certificate id, and nothing else', async () => {
    expect(
      (await send('POST', `certification/admin/seller-certificates/${CERT}/revoke`)).called,
    ).toBe(1);
    expect(
      (await send('GET', `certification/admin/seller-certificates/${CERT}/history`)).called,
    ).toBe(1);
    expect((await send('POST', 'certification/admin/seller-certificates/x/revoke')).called).toBe(0);
    expect((await send('GET', 'certification/admin/seller-certificates/x/history')).called).toBe(0);
    expect(
      (await send('POST', `certification/admin/seller-certificates/${CERT}/history`)).called,
    ).toBe(0);
    expect(
      (await send('GET', `certification/admin/seller-certificates/${CERT}/revoke`)).called,
    ).toBe(0);
  });
});
