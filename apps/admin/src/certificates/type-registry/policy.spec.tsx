// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';
import { relay } from '../../server/bff.ts';
import type { PanelConfig } from '../../server/config.ts';

vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../../api/client.ts';
import { typeProblemOf } from './errors.ts';
import { PolicyView } from './policy-view.tsx';
import { TypeDetailView } from './type-detail.tsx';
import type { PolicyDetail, TypeDetail } from './types.ts';

const call = vi.mocked(callApi);
const TYPE = '0190a000-0000-7000-8000-0000000000a1';
const PROP = '0190a000-0000-7000-8000-0000000000b1';
const MEAT = '0190a000-0000-7000-8000-0000000000c1';
const DAIRY = '0190a000-0000-7000-8000-0000000000c2';
const CATEGORIES = [
  { id: MEAT, name: 'Meat', depth: 0 },
  { id: DAIRY, name: 'Dairy', depth: 0 },
];
const wrap = (node: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      {node}
    </NextIntlClientProvider>,
  );
const policy = (over: Partial<PolicyDetail> = {}): PolicyDetail => ({
  typeId: TYPE,
  typeCode: 'halal',
  defaultBasis: 'SELLER_REQUIRED',
  version: 4,
  published: {
    revisionNo: 2,
    createdAt: '2026-11-01T01:00:00.000Z',
    rows: [{ selector: 'platform-category', categoryId: MEAT, basis: 'SELLER_REQUIRED' }],
    reason: { state: 'given', text: 'first rules' },
  },
  pendingRevision: null,
  history: [
    {
      revisionId: 'r2',
      revisionNo: 2,
      createdAt: '2026-11-01T01:00:00.000Z',
      reasonGiven: true,
      published: true,
    },
  ],
  review: { reviewed: false, risk: 'high' },
  ...over,
});
const view = (
  over: Partial<PolicyDetail> = {},
  props: Partial<Parameters<typeof PolicyView>[0]> = {},
) =>
  wrap(
    <PolicyView
      policy={policy(over)}
      categories={CATEGORIES}
      categoriesLoaded
      canEdit
      csrfToken="c"
      {...props}
    />,
  );
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

let assigned = '';
beforeEach(() => {
  call.mockReset();
  assigned = '';
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
  vi.stubGlobal('location', {
    ...window.location,
    assign: (url: string) => {
      assigned = url;
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('claim policy page', () => {
  it('shows the published rows by name, the default basis and the history', () => {
    view();
    expect(screen.getByText('Meat', { selector: 'span.font-medium' })).toBeTruthy();
    expect(screen.getByText(/Default basis/)).toBeTruthy();
    expect(screen.getByText('first rules')).toBeTruthy();
    expect(screen.getByText('Revision 2', { selector: 'span.font-medium' })).toBeTruthy();
  });

  it('shows the rows but no form to a viewer', () => {
    view({}, { canEdit: false });
    expect(screen.getByText('Meat')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review changes' })).toBeNull();
    expect(screen.getByText(/view this policy but not change it/)).toBeTruthy();
  });

  it('says so when the categories could not be read, and offers no form', () => {
    view({}, { categoriesLoaded: false, categories: [] });
    expect(screen.getByText(/categories could not be loaded/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review changes' })).toBeNull();
  });

  it('asks for a change before it shows the confirmation', () => {
    view();
    click('Review changes');
    expect(screen.getByText('Nothing has changed yet.')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('adds a row, shows what changes, then saves the whole row set under the version read', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: { outcome: 'published', typeId: TYPE, request: null },
    });
    view();
    click('Add a handling row');
    fireEvent.change(screen.getByLabelText('Handling type'), { target: { value: 'FRESH' } });
    fireEvent.change(screen.getAllByLabelText('Basis')[1]!, {
      target: { value: 'NOT_APPLICABLE' },
    });
    fireEvent.change(screen.getByLabelText(/Reason for the change/), {
      target: { value: ' fresh needs none ' },
    });
    click('Review changes');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Fresh')).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save the change' }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'POST',
      `certification/admin/claim-policies/${TYPE}/revisions`,
      {
        version: 4,
        rows: [
          { selector: 'platform-category', categoryId: MEAT, basis: 'SELLER_REQUIRED' },
          { selector: 'handling', handling: 'FRESH', basis: 'NOT_APPLICABLE' },
        ],
        reason: 'fresh needs none',
      },
      'c',
    );
    await waitFor(() => expect(assigned).toBe(`/certificates/types/${TYPE}/policy?done=published`));
  });

  it('asks for the note while the Market reviews saves, sends it, and shows the request number', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        outcome: 'pending-second-admin',
        typeId: TYPE,
        request: { id: 'sr1', number: 57 },
      },
    });
    view({ review: { reviewed: true, risk: 'high' } });
    click('Add a category row');
    fireEvent.change(screen.getAllByLabelText('Platform category')[1]!, {
      target: { value: DAIRY },
    });
    fireEvent.change(screen.getAllByLabelText('Basis')[1]!, {
      target: { value: 'SELLER_OR_MANUFACTURER' },
    });
    click('Review changes');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText(/Write a note for the reviewers/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Note for reviewers/), {
      target: { value: '  Dairy relaxed for sealed goods  ' },
    });
    click('Review changes');
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Save the change' }),
    );
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]?.[2]).toMatchObject({ note: 'Dairy relaxed for sealed goods' });
    await waitFor(() =>
      expect(assigned).toBe(`/certificates/types/${TYPE}/policy?done=pending&sr=57`),
    );
  });

  it('refuses a duplicate row and a category row with no category before it asks', () => {
    view();
    click('Add a category row');
    click('Review changes');
    expect(screen.getByText('Choose a category.')).toBeTruthy();
    fireEvent.change(screen.getAllByLabelText('Platform category')[1]!, {
      target: { value: MEAT },
    });
    click('Review changes');
    expect(screen.getByText(/already has a row/)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('offers no manufacturer basis for a handling row', () => {
    view();
    click('Add a handling row');
    const basis = screen.getAllByLabelText<HTMLSelectElement>('Basis')[1]!;
    const values = [...basis.options].map((option) => option.value);
    expect(values).not.toContain('SELLER_OR_MANUFACTURER');
    expect(
      [...screen.getAllByLabelText<HTMLSelectElement>('Basis')[0]!.options].map((o) => o.value),
    ).toContain('SELLER_OR_MANUFACTURER');
  });

  it('puts the first focus on the way back, and Escape closes the dialog', () => {
    view();
    fireEvent.change(screen.getAllByLabelText('Basis')[0]!, {
      target: { value: 'NOT_APPLICABLE' },
    });
    click('Review changes');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Back to the form' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Back to the form' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('stops adding rows at the most the API takes', () => {
    const rows = Array.from({ length: 304 }, (_, index) => ({
      selector: 'platform-category' as const,
      categoryId: `0190a000-0000-7000-8000-${String(index).padStart(12, '0')}`,
      basis: 'SELLER_REQUIRED',
    }));
    view({
      published: {
        revisionNo: 1,
        createdAt: '2026-11-01T01:00:00.000Z',
        rows,
        reason: null,
      },
    });
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Add a category row' }).disabled,
    ).toBe(true);
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Add a handling row' }).disabled,
    ).toBe(true);
  }, 30_000);

  it('lists what the API refused and keeps the dialog open', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 422,
        code: 'claim-policy.revision-invalid',
        details: { issues: [{ path: 'rows[1].categoryId', code: 'category-unknown' }] },
      },
    });
    view();
    fireEvent.change(screen.getAllByLabelText('Basis')[0]!, {
      target: { value: 'NOT_APPLICABLE' },
    });
    click('Review changes');
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Save the change' }),
    );
    await screen.findByText(/isn't an active platform category/);
    expect(assigned).toBe('');
  });

  it('offers a reload when the policy moved on meanwhile', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 409, code: 'conflict.stale' } });
    view();
    fireEvent.change(screen.getAllByLabelText('Basis')[0]!, {
      target: { value: 'NOT_APPLICABLE' },
    });
    click('Review changes');
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Save the change' }),
    );
    await screen.findByRole('button', { name: 'Reload the page' });
  });
});

describe('claim policy relaxations', () => {
  const pending = (allowed = true): Partial<PolicyDetail> => ({
    pendingRevision: {
      rows: [],
      proposal: {
        id: PROP,
        proposedAt: '2026-11-02T01:00:00.000Z',
        state: 'pending',
        version: 7,
        reason: { state: 'given', text: 'relax it' },
        diff: [
          {
            path: `row:${MEAT}`,
            before: 'SELLER_REQUIRED',
            after: 'NOT_APPLICABLE',
            relaxes: true,
          },
        ],
        actions: {
          approve: { allowed },
          reject: { allowed },
          withdraw: { allowed: !allowed },
        },
      },
    },
  });

  it('shows the waiting change with the category named, and no form beside it', () => {
    view(pending());
    expect(screen.getByText('A policy change waiting for a second admin')).toBeTruthy();
    expect(screen.getAllByText('Meat').length).toBeGreaterThan(1);
    expect(screen.getByText('No certificate needed')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review changes' })).toBeNull();
  });

  it('approves under the proposal version and goes back to the policy page', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: {} });
    view(pending());
    click('Approve change');
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve change' }),
    );
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call).toHaveBeenCalledWith(
      'POST',
      `certification/admin/claim-policies/${TYPE}/relaxations/${PROP}/approve`,
      { version: 7 },
      'c',
    );
    await waitFor(() => expect(assigned).toBe(`/certificates/types/${TYPE}/policy?done=approved`));
  });

  it('lets the requester withdraw but not approve, from what the API allows', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: {} });
    view(pending(false));
    expect(screen.queryByRole('button', { name: 'Approve change' })).toBeNull();
    click('Withdraw proposal');
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Withdraw proposal' }),
    );
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    expect(call.mock.calls[0]?.[1]).toBe(
      `certification/admin/claim-policies/${TYPE}/proposals/${PROP}/withdraw`,
    );
  });

  it('tells a viewer that a change is waiting, without the buttons', () => {
    view(pending(), { canEdit: false });
    expect(screen.getByText(/waiting for a second admin/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve change' })).toBeNull();
  });
});

describe('claim policy entry points and errors', () => {
  const type = (): TypeDetail => ({
    typeId: TYPE,
    code: 'halal',
    status: 'active',
    version: 3,
    published: {
      revisionNo: 2,
      createdAt: '2026-11-01T01:00:00.000Z',
      content: { verificationMode: 'THIRD_PARTY_DOCUMENT', defaultBasis: 'SELLER_REQUIRED' },
    },
    pendingRevision: null,
    pendingReactivation: null,
  });

  it('links to the policy for someone who may view it and nobody else', () => {
    const { unmount } = wrap(
      <TypeDetailView type={type()} name="Halal" canEdit={false} canViewPolicy csrfToken="c" />,
    );
    expect(screen.getByRole('link', { name: 'Claim basis policy' }).getAttribute('href')).toBe(
      `/certificates/types/${TYPE}/policy`,
    );
    unmount();
    wrap(<TypeDetailView type={type()} name="Halal" canEdit={false} csrfToken="c" />);
    expect(screen.queryByRole('link', { name: 'Claim basis policy' })).toBeNull();
  });

  it('names the refusals of a policy save and keeps the issue codes it knows', () => {
    const problem = typeProblemOf({
      status: 422,
      code: 'claim-policy.revision-invalid',
      details: {
        issues: [
          { path: 'rows[0]', code: 'duplicate-selector' },
          { path: 'rows[1]', code: 'duplicate-selector' },
          { path: 'rows[2]', code: 'manufacturer-basis-on-handling' },
          { path: 'rows[3]', code: 'something.else' },
        ],
      },
    });
    expect(problem.key).toBe('certificates.types.error.policy-invalid');
    expect(problem.issues).toEqual(['duplicate', 'manufacturer-handling']);
    expect(typeProblemOf({ status: 409, code: 'claim-policy.revision-unchanged' }).key).toBe(
      'certificates.types.error.unchanged',
    );
  });
});

describe('claim policy relay', () => {
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

  it('relays the policy save and the answers for UUID ids, and no other route', async () => {
    const base = `certification/admin/claim-policies/${TYPE}`;
    for (const path of [
      'revisions',
      `relaxations/${PROP}/approve`,
      `proposals/${PROP}/reject`,
      `proposals/${PROP}/withdraw`,
    ]) {
      expect(await send('POST', `${base}/${path}`)).toBe(1);
    }
    expect(await send('GET', `${base}/revisions`)).toBe(0);
    expect(await send('POST', 'certification/admin/claim-policies/x/revisions')).toBe(0);
    expect(await send('POST', `${base}/proposals/x/reject`)).toBe(0);
    expect(await send('POST', `${base}/reactivation`)).toBe(0);
    expect(await send('DELETE', base)).toBe(0);
  });

  it('refuses a policy write from another origin', async () => {
    const upstream = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('{}', { status: 200 })),
    );
    const target = `certification/admin/claim-policies/${TYPE}/revisions`;
    const request = new Request(`http://admin.localhost:3002/api/${target}`, {
      method: 'POST',
      headers: {
        host: 'admin.localhost:3002',
        origin: 'http://evil.test',
        'sec-fetch-site': 'cross-site',
        'content-type': 'application/json',
      },
      body: '{}',
    });
    await relay(config, request, target.split('/'), upstream);
    expect(upstream).not.toHaveBeenCalled();
  });
});
