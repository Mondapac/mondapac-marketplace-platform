// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import { relay } from '../../server/bff.ts';
import type { PanelConfig } from '../../server/config.ts';

vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { requestProblemOf } from './errors.ts';
import { RequestView } from './request-view.tsx';
import { RequestsTable } from './requests-table.tsx';
import type { RequestDetail, RequestRow } from './types.ts';

const call = vi.mocked(callApi);
const ID = '0190a000-0000-7000-8000-0000000000e1';
const ISSUER = '0190a000-0000-7000-8000-0000000000c1';
const row = (over: Partial<RequestRow> = {}): RequestRow => ({
  issuerRequestId: ID,
  version: 2,
  typeCode: 'halal',
  sellerId: '0190a000-0000-7000-8000-00000000abcd',
  storeName: 'Logan Road Grocer',
  documentCount: 2,
  createdAt: '2026-11-09T01:00:00.000Z',
  ...over,
});
const detail = (over: Partial<RequestDetail> = {}): RequestDetail => ({
  issuerRequestId: ID,
  version: 2,
  state: 'open',
  typeCode: 'halal',
  sellerId: '0190a000-0000-7000-8000-00000000abcd',
  storeName: 'Logan Road Grocer',
  typedIssuerName: '<b>Brisbane Halal Board</b>',
  documents: [{ position: 0, mediaType: 'application/pdf', byteSize: 1258291, pageCount: 2 }],
  createdAt: '2026-11-09T01:00:00.000Z',
  answer: null,
  activeIssuers: [{ issuerId: ISSUER, displayName: 'Halal Authority' }],
  reasons: [{ code: 'not-an-issuer', label: 'This is not a certificate issuer.' }],
  ...over,
});
const names = new Map([['halal', 'Halal']]);
const wrap = (node: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      {node}
    </NextIntlClientProvider>,
  );
const view = (request: RequestDetail, canAnswer = true) =>
  wrap(<RequestView request={request} typeName="Halal" canAnswer={canAnswer} csrfToken="t" />);

beforeEach(() => {
  call.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('issuer requests queue', () => {
  it('has one link per row, a plain fallback for a seller not approved, and no typed text', () => {
    wrap(
      <RequestsTable
        rows={[row(), row({ issuerRequestId: ISSUER, storeName: null })]}
        typeNames={names}
        morePages={false}
      />,
    );
    expect(screen.getAllByRole('link')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Logan Road Grocer' }).getAttribute('href')).toBe(
      `/certificates/issuer-requests/${ID}`,
    );
    expect(screen.getByText('Not yet approved').closest('a')).toBeNull();
    expect(screen.getByRole('link', { name: /Open request/ })).toBeTruthy();
    expect(screen.getAllByText('Halal')).toHaveLength(2);
    expect(screen.getByText('Waiting since (UTC)')).toBeTruthy();
  });

  it('says when there is nothing, and when only this page is empty', () => {
    wrap(<RequestsTable rows={[]} typeNames={names} morePages={false} />);
    expect(screen.getByText('No issuer requests are open.')).toBeTruthy();
    cleanup();
    wrap(<RequestsTable rows={[]} typeNames={names} morePages />);
    expect(screen.getByText(/Nothing on this page/)).toBeTruthy();
  });
});

describe('issuer request page', () => {
  it('shows the seller text as plain text marked as theirs, and the file as metadata', () => {
    view(detail());
    expect(screen.getByText('<b>Brisbane Halal Board</b>')).toBeTruthy();
    expect(screen.getByText("The seller's own text. It is not a registry entry.")).toBeTruthy();
    expect(screen.getByText('File 1 · PDF · 2 pages · 1.2 MB')).toBeTruthy();
  });

  it('says so when the seller text is gone', () => {
    view(detail({ typedIssuerName: null }));
    expect(screen.getByText("The seller's text is no longer available.")).toBeTruthy();
  });

  it('adds the issuer with the version read, nothing preselected', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    call.mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    view(detail());
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(screen.getByText('Choose an answer.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/Issuer added/));
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(screen.getByText('Choose an issuer.')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: /Issuer/ }), {
      target: { value: ISSUER },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'POST',
      `certification/admin/issuer-requests/${ID}/answer`,
      { version: 2, outcome: 'issuer-added', issuerId: ISSUER },
      't',
    );
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('/certificates/issuer-requests?answered=1'),
    );
  });

  it('declines with a prepared reason, and needs one', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    view(detail());
    fireEvent.click(screen.getByLabelText(/Not accepted/));
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(screen.getByText('Choose a reason.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Prepared reason/), {
      target: { value: 'not-an-issuer' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]?.[2]).toEqual({
      version: 2,
      outcome: 'not-accepted',
      reasonCode: 'not-an-issuer',
    });
  });

  it('disables "Issuer added" with a way to the registry when no issuer of the type is active', () => {
    view(detail({ activeIssuers: [] }));
    expect(
      screen.getByText('No active issuer of this type. Add and activate one first.'),
    ).toBeTruthy();
    expect(screen.getByLabelText(/Issuer added/).matches(':disabled')).toBe(true);
    expect(screen.getByRole('link', { name: 'Open the registry' }).getAttribute('href')).toBe(
      '/certificates/issuers',
    );
  });

  it('disables "Not accepted" when the Market lists no reason', () => {
    view(detail({ reasons: [] }));
    expect(screen.getByLabelText(/Not accepted/).matches(':disabled')).toBe(true);
  });

  it('shows an answered request read-only, with the issuer name or its absence', () => {
    view(
      detail({
        state: 'issuer-added',
        answer: { issuerId: ISSUER, reasonCode: null, answeredAt: '2026-11-10T01:00:00.000Z' },
      }),
    );
    expect(screen.getByText('Halal Authority')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull();
    cleanup();
    view(
      detail({
        state: 'issuer-added',
        activeIssuers: [],
        answer: { issuerId: ISSUER, reasonCode: null, answeredAt: '2026-11-10T01:00:00.000Z' },
      }),
    );
    expect(screen.getByText('Issuer no longer active')).toBeTruthy();
    cleanup();
    view(
      detail({
        state: 'not-accepted',
        answer: {
          issuerId: null,
          reasonCode: 'not-an-issuer',
          answeredAt: '2026-11-10T01:00:00.000Z',
        },
      }),
    );
    expect(screen.getByText('This is not a certificate issuer.')).toBeTruthy();
  });

  it('gives a reader who may not edit issuers no form', () => {
    view(detail(), false);
    expect(screen.getByText("Your role can't change issuers.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull();
  });

  it('shows a refusal as text and offers Reload when it was answered meanwhile', async () => {
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 409, code: 'issuer-request.already-answered' },
    });
    view(detail());
    fireEvent.click(screen.getByLabelText(/Not accepted/));
    fireEvent.change(screen.getByLabelText(/Prepared reason/), {
      target: { value: 'not-an-issuer' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
    expect(await screen.findByText(/answered by someone else/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload the page' })).toBeTruthy();
  });
});

describe('issuer request errors', () => {
  it('maps every code of the answer route to a message that exists', () => {
    const codes = [
      'validation.failed',
      'issuer-request.not-found',
      'issuer-request.already-answered',
      'issuer-request.reason-unknown',
      'issuer.not-active',
      'issuer.not-found',
      'conflict.stale',
      'conflict.retry',
      'access.denied',
      'access.acting-as-refused',
      'request.throttled',
      'request.csrf',
    ];
    for (const code of codes) {
      const key = requestProblemOf({ status: 422, code }).key;
      expect(key, code).not.toMatch(/\.unknown$/);
      expect(Object.keys(messages.certificates.requests.error), code).toContain(
        key.split('.').pop(),
      );
    }
    expect(requestProblemOf({ status: 400, code: 'constructor' }).key).toMatch(/\.unknown$/);
    expect(requestProblemOf({ status: 0, code: 'x' }).key).toMatch(/\.unavailable$/);
  });
});

describe('issuer request relay', () => {
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

  it('relays the answer only, not the page read, the documents, or a bad id', async () => {
    const base = 'certification/admin/issuer-requests';
    expect(await send('POST', `${base}/${ID}/answer`)).toBe(1);
    expect(await send('GET', `${base}/${ID}`)).toBe(0);
    expect(await send('GET', `${base}/${ID}/documents/${ISSUER}`)).toBe(0);
    expect(await send('POST', `${base}/not-an-id/answer`)).toBe(0);
  });
});
