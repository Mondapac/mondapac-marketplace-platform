// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import { relay } from '../../server/bff.ts';
import type { PanelConfig } from '../../server/config.ts';

vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { typeProblemOf } from './errors.ts';
import { TypeDetailView } from './type-detail.tsx';
import { TypesTable } from './types-table.tsx';
import type { TypeDetail, TypeProposal, TypeRow } from './types.ts';

const call = vi.mocked(callApi);
const TYPE = '0190a000-0000-7000-8000-0000000000a1';
const PROP = '0190a000-0000-7000-8000-0000000000b1';
const wrap = (node: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      {node}
    </NextIntlClientProvider>,
  );
const row = (over: Partial<TypeRow> = {}): TypeRow => ({
  typeId: TYPE,
  code: 'halal',
  status: 'active',
  verificationMode: 'THIRD_PARTY_DOCUMENT',
  version: 3,
  publishedRevisionNo: 2,
  names: { 'en-AU': 'Halal' },
  pending: [],
  ...over,
});
const proposal = (over: Partial<TypeProposal> = {}): TypeProposal => ({
  id: PROP,
  proposedAt: '2026-11-10T01:00:00.000Z',
  state: 'pending',
  version: 5,
  reason: { state: 'given', text: '<i>why</i>' },
  diff: [{ path: 'requiresDocument', before: true, after: false, relaxes: true }],
  actions: {
    approve: { allowed: true },
    reject: { allowed: true },
    withdraw: { allowed: false },
  },
  ...over,
});
const detail = (over: Partial<TypeDetail> = {}): TypeDetail => ({
  typeId: TYPE,
  code: 'halal',
  status: 'active',
  version: 3,
  published: {
    revisionNo: 2,
    createdAt: '2026-11-01T01:00:00.000Z',
    content: {
      verificationMode: 'THIRD_PARTY_DOCUMENT',
      requiresIssuerRegistry: true,
      requiresDocument: true,
      requiresExpiry: false,
      defaultBasis: 'SELLER_CERT_REQUIRED',
      badgeIconKey: 'shield-check',
      locales: {
        'en-AU': { name: 'Halal', customerDescription: 'Halal certified', claimTerms: ['halal'] },
      },
    },
  },
  pendingRevision: null,
  pendingReactivation: null,
  ...over,
});
const view = (type: TypeDetail, canEdit = true, done: string | null = null) =>
  wrap(<TypeDetailView type={type} name="Halal" canEdit={canEdit} csrfToken="c" done={done} />);
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

describe('types list', () => {
  it('shows each type with its status, mode and revision, and marks a waiting change', () => {
    wrap(
      <TypesTable
        rows={[
          row({ pending: ['revision'] }),
          row({ typeId: 'x', code: 'kosher', names: {}, status: 'inactive' }),
        ]}
      />,
    );
    expect(screen.getByRole('link', { name: 'Halal' }).getAttribute('href')).toBe(
      `/certificates/types/${TYPE}`,
    );
    expect(screen.getByText('Change waiting')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'kosher' })).toBeTruthy();
    expect(screen.getByText('Inactive')).toBeTruthy();
  });

  it('falls back to the language name, then to the code, and works in another Market locale', () => {
    wrap(
      <TypesTable
        rows={[
          row({ names: { en: 'Halal (language)' } }),
          row({ typeId: 'y', code: 'vegan', names: {} }),
        ]}
      />,
    );
    expect(screen.getByRole('link', { name: 'Halal (language)' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'vegan' })).toBeTruthy();
    cleanup();
    render(
      <NextIntlClientProvider locale="en-NZ" messages={messages}>
        <TypesTable rows={[row({ names: { 'en-NZ': 'Halal NZ', 'en-AU': 'Halal AU' } })]} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('link', { name: 'Halal NZ' })).toBeTruthy();
  });

  it('says so when there are no types', () => {
    wrap(<TypesTable rows={[]} />);
    expect(screen.getByText('This Market has no certificate types yet.')).toBeTruthy();
  });

  it('keeps an unknown check mode as its code', () => {
    wrap(<TypesTable rows={[row({ verificationMode: 'FUTURE_MODE' })]} />);
    expect(screen.getByText('FUTURE_MODE')).toBeTruthy();
  });
});

describe('type page', () => {
  it('shows the published revision as text', () => {
    view(detail());
    expect(screen.getByText('Revision 2')).toBeTruthy();
    expect(screen.getByText('Seller certificate required')).toBeTruthy();
    expect(screen.getByText('Halal certified')).toBeTruthy();
    expect(screen.getByText('Certificate from an issuer')).toBeTruthy();
  });

  it('offers Deactivate for an active type and sends the version', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    view(detail());
    open('Deactivate');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText(/No new Halal certificates can be added/)).toBeTruthy();
    last('Deactivate');
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    expect(call).toHaveBeenCalledWith(
      'POST',
      `certification/admin/types/${TYPE}/deactivate`,
      { version: 3 },
      'c',
    );
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith(`/certificates/types/${TYPE}?done=deactivated`),
    );
  });

  it('asks for reactivation of an inactive type, with an optional reason', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    vi.stubGlobal('location', { assign: vi.fn() });
    view(detail({ status: 'inactive' }));
    expect(screen.queryByRole('button', { name: 'Deactivate' })).toBeNull();
    open('Ask for reactivation');
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: ' Re-audited ' } });
    last('Send for approval');
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    expect(call).toHaveBeenCalledWith(
      'POST',
      `certification/admin/types/${TYPE}/reactivation`,
      { version: 3, reason: 'Re-audited' },
      'c',
    );
  });

  it('does not offer reactivation while one is waiting, and blocks a long reason', () => {
    view(detail({ status: 'inactive', pendingReactivation: proposal() }));
    expect(screen.queryByRole('button', { name: 'Ask for reactivation' })).toBeNull();
    cleanup();
    view(detail({ status: 'inactive' }));
    open('Ask for reactivation');
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'x'.repeat(501) } });
    last('Send for approval');
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByText('Use 500 characters or fewer.')).toBeTruthy();
  });

  it('shows a waiting revision with its diff and sends approve on the relaxations path', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    vi.stubGlobal('location', { assign: vi.fn() });
    view(detail({ pendingRevision: proposal() }));
    expect(screen.getByText('<i>why</i>')).toBeTruthy();
    expect(screen.getByText('Needs a document', { selector: 'p' })).toBeTruthy();
    expect(screen.getByText('This part needs a second admin.')).toBeTruthy();
    open('Approve change');
    expect(call).not.toHaveBeenCalled();
    last('Approve change');
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    expect(call).toHaveBeenCalledWith(
      'POST',
      `certification/admin/types/${TYPE}/relaxations/${PROP}/approve`,
      { version: 5 },
      'c',
    );
  });

  it('approves a reactivation on its own path and rejects on the proposals path', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: {} });
    vi.stubGlobal('location', { assign: vi.fn() });
    view(detail({ status: 'inactive', pendingReactivation: proposal({ diff: [] }) }));
    open('Approve change');
    last('Approve change');
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]![1]).toBe(
      `certification/admin/types/${TYPE}/reactivations/${PROP}/approve`,
    );
    cleanup();
    call.mockClear();
    view(detail({ pendingRevision: proposal() }));
    open('Reject change');
    last('Reject change');
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]![1]).toBe(
      `certification/admin/types/${TYPE}/proposals/${PROP}/reject`,
    );
  });

  it('tells the proposer a different admin must answer, and offers Withdraw', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 200, body: {} });
    vi.stubGlobal('location', { assign: vi.fn() });
    view(
      detail({
        pendingRevision: proposal({
          actions: {
            approve: { allowed: false, code: 'review.second-admin-required' },
            reject: { allowed: false },
            withdraw: { allowed: true },
          },
        }),
      }),
    );
    expect(screen.getByText(/different admin has to answer it/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve change' })).toBeNull();
    open('Withdraw proposal');
    last('Withdraw proposal');
    await waitFor(() => expect(call).toHaveBeenCalledOnce());
    expect(call.mock.calls[0]![1]).toBe(
      `certification/admin/types/${TYPE}/proposals/${PROP}/withdraw`,
    );
  });

  it('says so when no answer is open, and a closed proposal offers a reload', async () => {
    view(
      detail({
        pendingRevision: proposal({
          actions: {
            approve: { allowed: false },
            reject: { allowed: false },
            withdraw: { allowed: false },
          },
        }),
      }),
    );
    expect(screen.getByText(/Nothing can be done with this proposal/)).toBeTruthy();
    cleanup();
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 409, code: 'review.proposal-closed' },
    });
    view(detail({ pendingRevision: proposal() }));
    open('Reject change');
    last('Reject change');
    expect(await screen.findByText(/already answered/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload the page' })).toBeTruthy();
  });

  it('shows readable labels and words in the diff, and a removed reason', () => {
    view(
      detail({
        pendingRevision: proposal({
          reason: { state: 'erased' },
          diff: [
            {
              path: 'defaultBasis',
              before: 'SELLER_CERT_REQUIRED',
              after: 'NO_BADGE_ALLOWED',
              relaxes: false,
            },
            { path: 'row:abc', before: null, after: 'x', relaxes: true },
          ],
        }),
      }),
    );
    expect(screen.getByText('Default basis', { selector: 'p' })).toBeTruthy();
    expect(screen.getByText('Seller certificate required', { selector: 'span' })).toBeTruthy();
    expect(screen.getByText('No badge allowed')).toBeTruthy();
    expect(screen.getByText('Policy row')).toBeTruthy();
    expect(screen.getByText('Reason removed')).toBeTruthy();
    expect(document.body.textContent).not.toContain('SELLER_CERT_REQUIRED');
  });

  it.each([
    ['conflict.stale', 409, /changed while you were looking/, true],
    ['type.already-inactive', 409, /already inactive/, true],
    ['access.denied', 403, /role can't/, false],
    ['network', 0, /not available right now/, false],
  ])('maps %s on Deactivate', async (code, status, text, reload) => {
    call.mockResolvedValueOnce({ ok: false, failure: { status, code } });
    view(detail());
    open('Deactivate');
    last('Deactivate');
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reload the page' }) !== null).toBe(reload);
    if (!reload) expect(screen.getAllByRole('button', { name: 'Deactivate' }).length).toBe(2);
  });

  it('reloads the page from the Reload button', async () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { reload, assign: vi.fn() });
    call.mockResolvedValueOnce({ ok: false, failure: { status: 409, code: 'conflict.stale' } });
    view(detail());
    open('Deactivate');
    last('Deactivate');
    fireEvent.click(await screen.findByRole('button', { name: 'Reload the page' }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('sends a signed-out session to sign-in', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { assign });
    call.mockResolvedValueOnce({ ok: false, failure: { status: 401, code: 'auth.required' } });
    view(detail());
    open('Deactivate');
    last('Deactivate');
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/session-ended'));
  });

  it('ignores a second click while the first call runs', () => {
    let finish: (value: never) => void = () => undefined;
    call.mockReturnValueOnce(new Promise((resolve) => (finish = resolve as never)));
    view(detail());
    open('Deactivate');
    last('Deactivate');
    last('Deactivate');
    expect(call).toHaveBeenCalledOnce();
    finish({ ok: false, failure: { status: 500, code: 'x' } } as never);
  });

  it('opens the reactivation and answer dialogs with Cancel focused', () => {
    view(detail({ status: 'inactive' }));
    open('Ask for reactivation');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    cleanup();
    view(detail({ pendingRevision: proposal() }));
    open('Approve change');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('shows an inactive type to a view-only reader with no buttons', () => {
    view(detail({ status: 'inactive' }), false);
    expect(screen.getByText(/No new certificates of this type can be added/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows both waiting cards, a self-declaration setting, and an unknown basis as its code', () => {
    view(
      detail({
        status: 'inactive',
        pendingRevision: proposal(),
        pendingReactivation: proposal({ id: 'p2' }),
        published: {
          ...detail().published,
          content: {
            verificationMode: 'SELF_DECLARATION',
            defaultBasis: 'FUTURE_BASIS',
            autoApproveSelfDeclaration: true,
          },
        },
      }),
    );
    expect(screen.getAllByRole('heading', { level: 3 }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Approve without a person')).toBeTruthy();
    expect(screen.getByText('FUTURE_BASIS')).toBeTruthy();
  });

  it('shows a view-only reader a note and no buttons', () => {
    view(detail({ pendingRevision: proposal() }), false);
    expect(screen.getByText("Your role can't change certificate types.")).toBeTruthy();
    expect(screen.getByText('A change to this type is waiting for a second admin.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows a known notice only', () => {
    view(detail(), true, 'deactivated');
    expect(screen.getByText('Type deactivated.')).toBeTruthy();
    cleanup();
    view(detail(), true, '<b>x</b>');
    expect(document.body.innerHTML).not.toContain('<b>x</b>');
  });

  it('maps codes to messages and marks the ones that need a reload', () => {
    expect(typeProblemOf({ status: 409, code: 'conflict.stale' })).toEqual({
      key: 'certificates.types.error.stale',
      reload: true,
      issues: [],
    });
    expect(typeProblemOf({ status: 403, code: 'review.second-admin-required' }).reload).toBe(false);
    expect(typeProblemOf({ status: 500, code: 'x' }).key).toBe(
      'certificates.types.error.unavailable',
    );
    expect(typeProblemOf({ status: 400, code: 'weird' }).key).toBe(
      'certificates.types.error.unknown',
    );
  });
});

describe('relay', () => {
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

  it('relays the type actions and the revision write for UUID ids, and no other route', async () => {
    const base = `certification/admin/types/${TYPE}`;
    for (const path of [
      'deactivate',
      'revisions',
      'reactivation',
      `relaxations/${PROP}/approve`,
      `reactivations/${PROP}/approve`,
      `proposals/${PROP}/reject`,
      `proposals/${PROP}/withdraw`,
    ]) {
      expect(await send('POST', `${base}/${path}`)).toBe(1);
    }
    expect(await send('GET', `${base}/revisions`)).toBe(0);
    expect(await send('POST', 'certification/admin/types/x/revisions')).toBe(0);
    expect(await send('POST', `${base}/proposals/x/reject`)).toBe(0);
    expect(await send('POST', 'certification/admin/types/x/deactivate')).toBe(0);
    expect(await send('GET', `${base}/deactivate`)).toBe(0);
    expect(await send('DELETE', base)).toBe(0);
  });
});
