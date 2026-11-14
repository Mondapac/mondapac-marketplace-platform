// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import { relay } from '../../server/bff.ts';
import type { PanelConfig } from '../../server/config.ts';

vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { issuerProblemOf } from './errors.ts';
import { ExpertApproval, IssuerActions } from './issuer-actions.tsx';
import { IssuerDetailView } from './issuer-detail.tsx';
import { IssuersTable } from './issuers-table.tsx';
import { NewIssuer } from './new-issuer.tsx';
import type { IssuerDetail, IssuerRow, TypeChoice } from './types.ts';

const call = vi.mocked(callApi);
const ID = '0190a000-0000-7000-8000-0000000000c1';
const row = (over: Partial<IssuerRow> = {}): IssuerRow => ({
  issuerId: ID,
  typeId: '0190a000-0000-7000-8000-0000000000a1',
  typeCode: 'halal',
  displayName: 'Halal Certification Authority',
  accreditationNumber: 'HCA-0042',
  state: 'proposed',
  version: 3,
  stateChangedAt: '2026-11-09T01:00:00.000Z',
  ...over,
});
const detail = (over: Partial<IssuerDetail> = {}): IssuerDetail => ({
  ...row(),
  stateChangedByKind: 'seed',
  expertReferenceRecorded: false,
  affectedCertificates: 0,
  pendingReactivation: null,
  createdAt: '2026-11-01T01:00:00.000Z',
  ...over,
});
const types: TypeChoice[] = [
  { typeId: row().typeId, code: 'halal', names: { en: 'Halal' } },
  { typeId: '0190a000-0000-7000-8000-0000000000a2', code: 'kosher', names: { en: 'Kosher' } },
];
const names = new Map([
  ['halal', 'Halal'],
  ['kosher', 'Kosher'],
]);
const wrap = (node: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      {node}
    </NextIntlClientProvider>,
  );
const fail = (status: number, code: string) =>
  call.mockResolvedValueOnce({ ok: false, failure: { status, code } });
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

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

describe('issuers list', () => {
  it('shows name, type name, state in words, accreditation number and a link to the issuer', () => {
    wrap(
      <IssuersTable
        rows={[row(), row({ issuerId: 'b', state: 'derecognised', accreditationNumber: null })]}
        typeNames={names}
        morePages={false}
      />,
    );
    expect(
      screen
        .getAllByRole('link', { name: 'Halal Certification Authority' })[0]!
        .getAttribute('href'),
    ).toBe(`/certificates/issuers/${ID}`);
    expect(screen.getByText('Proposed')).toBeTruthy();
    expect(screen.getByText('Not recognised')).toBeTruthy();
    expect(screen.getByText('HCA-0042')).toBeTruthy();
    expect(screen.getAllByText('Halal').length).toBe(2);
  });

  it('tells an empty registry from an empty page, and renders names as plain text', () => {
    wrap(<IssuersTable rows={[]} typeNames={names} morePages={false} />);
    expect(screen.getByText(/No issuers yet/)).toBeTruthy();
    cleanup();
    wrap(<IssuersTable rows={[]} typeNames={names} morePages />);
    expect(screen.getByText('Nothing on this page. Go back to the first page.')).toBeTruthy();
    cleanup();
    wrap(
      <IssuersTable
        rows={[row({ displayName: '<img src=x onerror=alert(1)>' })]}
        typeNames={names}
        morePages={false}
      />,
    );
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('new issuer', () => {
  function open() {
    wrap(<NewIssuer types={types} typeNames={names} csrfToken="csrf-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'New issuer' }));
  }

  it('checks the fields before it calls the API', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Create issuer' }));
    expect(screen.getByText('Choose a certificate type.')).toBeTruthy();
    expect(screen.getByText('Enter a name.')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it('creates a Proposed issuer with the trimmed values and no empty accreditation', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 201, body: { issuerId: ID } });
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    open();
    fireEvent.change(screen.getByLabelText('Certificate type'), {
      target: { value: types[0]!.typeId },
    });
    type('Name', '  Halal Certification Authority ');
    fireEvent.click(screen.getByRole('button', { name: 'Create issuer' }));
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    expect(call).toHaveBeenCalledWith(
      'POST',
      'certification/admin/issuers',
      { typeId: types[0]!.typeId, displayName: 'Halal Certification Authority' },
      'csrf-1',
    );
    await waitFor(() => expect(assign).toHaveBeenCalledWith(`/certificates/issuers/${ID}`));
    vi.unstubAllGlobals();
  });

  it('shows the API refusal for a taken name in the dialog', async () => {
    fail(409, 'issuer.name-taken');
    open();
    fireEvent.change(screen.getByLabelText('Certificate type'), {
      target: { value: types[0]!.typeId },
    });
    type('Name', 'Taken');
    fireEvent.click(screen.getByRole('button', { name: 'Create issuer' }));
    expect(
      await screen.findByText('An issuer with this name already exists for this type.'),
    ).toBeTruthy();
  });
});

describe('new issuer navigation', () => {
  it('never navigates to an id that is not a UUID', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 201, body: { issuerId: '../../evil' } });
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    wrap(<NewIssuer types={types} typeNames={names} csrfToken="c" />);
    fireEvent.click(screen.getByRole('button', { name: 'New issuer' }));
    fireEvent.change(screen.getByLabelText(/Certificate type/), {
      target: { value: types[0]!.typeId },
    });
    type(/^Name/, 'X');
    fireEvent.click(screen.getByRole('button', { name: 'Create issuer' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/certificates/issuers'));
    vi.unstubAllGlobals();
  });
});

describe('activate and expert approval', () => {
  it('offers Activate for a Proposed issuer only', () => {
    wrap(<IssuerActions issuer={detail({ state: 'active' })} csrfToken="c" />);
    expect(screen.queryByRole('button', { name: 'Activate' })).toBeNull();
  });

  it('needs both expert fields, then sends them with the version read', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    wrap(<IssuerActions issuer={detail()} csrfToken="csrf-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Activate' }));
    expect(
      screen.getByText("This can't be changed after activation. Check the spelling."),
    ).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Activate' }).at(-1)!);
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByText('Enter who confirmed the issuer.')).toBeTruthy();
    expect(screen.getByText('Enter a reference.')).toBeTruthy();
    type('Confirmed by', 'Dr A. Rahman');
    type('Reference', 'Email of 6 Nov');
    fireEvent.click(screen.getAllByRole('button', { name: 'Activate' }).at(-1)!);
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    expect(call).toHaveBeenCalledWith(
      'POST',
      `certification/admin/issuers/${ID}/activate`,
      { version: 3, expertApproval: { confirmedBy: 'Dr A. Rahman', reference: 'Email of 6 Nov' } },
      'csrf-1',
    );
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(`/certificates/issuers/${ID}?activated=1`),
    );
    vi.unstubAllGlobals();
  });

  it('offers a reload when the issuer changed meanwhile', async () => {
    fail(409, 'conflict.stale');
    wrap(<IssuerActions issuer={detail()} csrfToken="c" />);
    fireEvent.click(screen.getByRole('button', { name: 'Activate' }));
    type('Confirmed by', 'A');
    type('Reference', 'B');
    fireEvent.click(screen.getAllByRole('button', { name: 'Activate' }).at(-1)!);
    expect(
      await screen.findByText('This issuer changed while you were looking. Reload the page.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('shows the expert approval only after View, and only to an editor', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: { issuerId: ID, current: { confirmedBy: 'Dr A. Rahman', reference: 'HC-12' } },
    });
    wrap(<ExpertApproval issuerId={ID} recorded canView csrfToken="c" />);
    expect(screen.queryByText('Dr A. Rahman')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View' }));
    expect(await screen.findByText('Dr A. Rahman')).toBeTruthy();
    expect(screen.getByText('HC-12')).toBeTruthy();
    expect(screen.getByText('Viewing is recorded.')).toBeTruthy();
    expect(call).toHaveBeenCalledWith(
      'GET',
      `certification/admin/issuers/${ID}/expert-reference`,
      undefined,
      'c',
    );
    cleanup();
    wrap(<ExpertApproval issuerId={ID} recorded canView={false} csrfToken="c" />);
    expect(screen.getByText('Recorded')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'View' })).toBeNull();
    cleanup();
    wrap(<ExpertApproval issuerId={ID} recorded={false} canView csrfToken="c" />);
    expect(screen.getByText('Not recorded')).toBeTruthy();
  });
});

const proposal = (over: Record<string, unknown> = {}) => ({
  id: '0190a000-0000-7000-8000-0000000000d1',
  proposedAt: '2026-11-10T01:00:00.000Z',
  state: 'pending',
  version: 2,
  reason: { state: 'given', text: 'Re-audited in October' },
  actions: {
    approve: { allowed: true },
    reject: { allowed: true },
    withdraw: { allowed: false, code: 'review.second-admin-required' },
  },
  ...over,
});
const open = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const last = (name: string) => fireEvent.click(screen.getAllByRole('button', { name }).at(-1)!);

describe('issuer lifecycle', () => {
  it('offers the actions that fit the state', () => {
    wrap(<IssuerActions issuer={detail({ state: 'active' })} csrfToken="c" />);
    expect(screen.getByRole('button', { name: 'Close to new certificates' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Derecognise' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ask for reactivation' })).toBeNull();
    cleanup();
    wrap(<IssuerActions issuer={detail({ state: 'closed-to-new' })} csrfToken="c" />);
    expect(screen.getByRole('button', { name: 'Ask for reactivation' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Derecognise' })).toBeTruthy();
    cleanup();
    wrap(
      <IssuerActions
        issuer={detail({ state: 'closed-to-new', pendingReactivation: proposal() })}
        csrfToken="c"
      />,
    );
    expect(screen.queryByRole('button', { name: 'Ask for reactivation' })).toBeNull();
    cleanup();
    wrap(<IssuerActions issuer={detail({ state: 'derecognised' })} csrfToken="c" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('closes to new with the version read', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    wrap(
      <IssuerActions
        issuer={detail({ state: 'active', affectedCertificates: 2 })}
        csrfToken="c1"
      />,
    );
    open('Close to new certificates');
    expect(
      screen.getByText(/2 approved certificates name this issuer and stay valid/),
    ).toBeTruthy();
    last('Close to new certificates');
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `certification/admin/issuers/${ID}/close-to-new`,
        { version: 3 },
        'c1',
      ),
    );
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(`/certificates/issuers/${ID}?done=closed`),
    );
    vi.unstubAllGlobals();
  });

  it('derecognises only after the count is typed, and sends it', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    vi.stubGlobal('location', { assign: vi.fn() });
    wrap(
      <IssuerActions issuer={detail({ state: 'active', affectedCertificates: 4 })} csrfToken="c" />,
    );
    open('Derecognise');
    last('Derecognise');
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByText('That is not the number of affected certificates.')).toBeTruthy();
    type('Type 4 to confirm', '3');
    last('Derecognise');
    expect(call).not.toHaveBeenCalled();
    type('Type 4 to confirm', '4');
    last('Derecognise');
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    expect(call).toHaveBeenCalledWith(
      'POST',
      `certification/admin/issuers/${ID}/derecognise`,
      { version: 3, affectedCertificates: 4 },
      'c',
    );
    vi.unstubAllGlobals();
  });

  it('asks to reload when the count changed meanwhile', async () => {
    fail(409, 'issuer.confirmation-count-mismatch');
    wrap(
      <IssuerActions issuer={detail({ state: 'active', affectedCertificates: 0 })} csrfToken="c" />,
    );
    open('Derecognise');
    type('Type 0 to confirm', '0');
    last('Derecognise');
    expect(await screen.findByText(/number of affected certificates changed/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  });

  it('asks for reactivation with a new expert approval and an optional reason', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    vi.stubGlobal('location', { assign: vi.fn() });
    wrap(<IssuerActions issuer={detail({ state: 'closed-to-new' })} csrfToken="c" />);
    open('Ask for reactivation');
    last('Send for approval');
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByText('Enter a reference.')).toBeTruthy();
    type('Confirmed by', 'Dr B');
    type('New reference', 'Letter 9');
    type('Reason (optional)', 'Re-audited');
    last('Send for approval');
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    expect(call).toHaveBeenCalledWith(
      'POST',
      `certification/admin/issuers/${ID}/reactivation`,
      {
        version: 3,
        expertApproval: { confirmedBy: 'Dr B', reference: 'Letter 9' },
        reason: 'Re-audited',
      },
      'c',
    );
    vi.unstubAllGlobals();
  });

  it('shows the proposal and sends only the answers the API allows', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    vi.stubGlobal('location', { assign: vi.fn() });
    wrap(
      <IssuerDetailView
        issuer={detail({ state: 'closed-to-new', pendingReactivation: proposal() })}
        typeName="Halal"
        canEdit
        csrfToken="c"
      />,
    );
    expect(screen.getByText('Re-audited in October')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Withdraw request' })).toBeNull();
    open('Approve reactivation');
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    expect(call).toHaveBeenCalledWith(
      'POST',
      `certification/admin/issuers/${ID}/reactivations/${proposal().id}/approve`,
      { version: 2 },
      'c',
    );
    vi.unstubAllGlobals();
  });

  it('tells the requester that a different admin must answer', () => {
    wrap(
      <IssuerDetailView
        issuer={detail({
          state: 'closed-to-new',
          pendingReactivation: proposal({
            actions: {
              approve: { allowed: false, code: 'review.second-admin-required' },
              reject: { allowed: false },
              withdraw: { allowed: true },
            },
          }),
        })}
        typeName="Halal"
        canEdit
        csrfToken="c"
      />,
    );
    expect(screen.getByText(/a different admin has to answer it/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Withdraw request' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve reactivation' })).toBeNull();
  });

  it('shows the notice after a change, and only for known ones', () => {
    wrap(
      <IssuerDetailView
        issuer={detail({ state: 'derecognised' })}
        typeName="Halal"
        canEdit
        csrfToken="c"
        done="derecognised"
      />,
    );
    expect(screen.getByText('Issuer derecognised.')).toBeTruthy();
    cleanup();
    wrap(
      <IssuerDetailView
        issuer={detail({ state: 'derecognised' })}
        typeName="Halal"
        canEdit
        csrfToken="c"
        done="<b>x</b>"
      />,
    );
    expect(screen.queryByText('Issuer derecognised.')).toBeNull();
    expect(document.body.innerHTML).not.toContain('<b>x</b>');
  });

  it('a view-only reader sees the waiting reactivation as a note, with no buttons', () => {
    wrap(
      <IssuerDetailView
        issuer={detail({ state: 'closed-to-new', pendingReactivation: proposal() })}
        typeName="Halal"
        canEdit={false}
        csrfToken="c"
      />,
    );
    expect(screen.getByText('A reactivation is waiting for a second admin.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('issuer page', () => {
  it('says the issuer was activated after the redirect', () => {
    wrap(
      <IssuerDetailView
        issuer={detail({ state: 'active' })}
        typeName="Halal"
        canEdit
        csrfToken="c"
        activated
      />,
    );
    expect(screen.getByText(/Issuer activated/)).toBeTruthy();
  });

  it('names the actor kind, never a person, and says when the role is view only', () => {
    wrap(
      <IssuerDetailView
        issuer={detail({ stateChangedByKind: 'admin' })}
        typeName="Halal"
        canEdit={false}
        csrfToken="c"
      />,
    );
    expect(screen.getByText(/by an admin/)).toBeTruthy();
    expect(screen.getByText("Your role can't change issuers.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Activate' })).toBeNull();
  });

  it('warns that the name of an issuer about to be activated cannot be changed', () => {
    wrap(<IssuerDetailView issuer={detail()} typeName="Halal" canEdit csrfToken="c" />);
    expect(screen.getByText(/an active issuer can't be renamed/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Activate' })).toBeTruthy();
  });
});

describe('issuer refusals and relay', () => {
  it('maps API codes to messages and marks the ones that need a reload', () => {
    expect(issuerProblemOf({ status: 409, code: 'conflict.stale' })).toEqual({
      key: 'certificates.issuers.error.stale',
      reload: true,
    });
    expect(issuerProblemOf({ status: 409, code: 'issuer.accreditation-taken' }).reload).toBe(false);
    expect(issuerProblemOf({ status: 500, code: 'x' }).key).toBe(
      'certificates.issuers.error.unavailable',
    );
    expect(issuerProblemOf({ status: 400, code: 'weird' }).key).toBe(
      'certificates.issuers.error.unknown',
    );
  });

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

  it('relays exactly the issuer routes the screens use, and no other issuer action', async () => {
    expect(await send('POST', 'certification/admin/issuers')).toEqual({ status: 200, called: 1 });
    expect(await send('POST', `certification/admin/issuers/${ID}/activate`)).toEqual({
      status: 200,
      called: 1,
    });
    expect(await send('GET', `certification/admin/issuers/${ID}/expert-reference`)).toEqual({
      status: 200,
      called: 1,
    });
    for (const action of ['derecognise', 'close-to-new', 'reactivation']) {
      expect((await send('POST', `certification/admin/issuers/${ID}/${action}`)).called).toBe(1);
    }
    const P = '0190a000-0000-7000-8000-0000000000d1';
    for (const path of [
      `reactivations/${P}/approve`,
      `proposals/${P}/reject`,
      `proposals/${P}/withdraw`,
    ]) {
      expect((await send('POST', `certification/admin/issuers/${ID}/${path}`)).called).toBe(1);
      expect(
        (await send('POST', `certification/admin/issuers/${ID}/${path.replace(P, 'x')}`)).called,
      ).toBe(0);
    }
    expect((await send('GET', `certification/admin/issuers/${ID}/proposals/${P}`)).called).toBe(0);
    expect((await send('POST', `certification/admin/issuers/${ID}/delete`)).called).toBe(0);
    expect((await send('POST', 'certification/admin/issuers/not-an-id/activate')).called).toBe(0);
  });
});
