// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../../messages/en.json';

vi.mock('../../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi, type ApiResult } from '../../api/client.ts';
import { TypeDetailView } from './type-detail.tsx';
import { TypeNewForm } from './type-new-form.tsx';
import { TypesToolbar } from './types-toolbar.tsx';
import type { ImpactCount, TypeDetail, TypeNewOptions, TypeProposal } from './types.ts';

const call = vi.mocked(callApi);
const TYPE = '0190a000-0000-7000-8000-0000000000b1';
const wrap = (node: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="en-AU" messages={messages}>
      {node}
    </NextIntlClientProvider>,
  );

const options: TypeNewOptions = {
  locales: ['en-AU'],
  verificationModes: ['THIRD_PARTY_DOCUMENT', 'SELF_DECLARATION'],
  defaultBases: ['SELLER_REQUIRED', 'NOT_APPLICABLE'],
  badgeArtworkKeys: ['text', 'halal'],
  limits: {
    codeMinLength: 2,
    codeMaxLength: 32,
    nameMaxLength: 80,
    descriptionMaxLength: 500,
    claimTermsPerLocale: 200,
    claimTermMaxLength: 100,
    reasonMaxLength: 500,
  },
};
const count = (over: Partial<ImpactCount> = {}): ApiResult<ImpactCount> => ({
  ok: true,
  status: 200,
  body: { products: 30, offers: 7, total: 37, complete: true, ...over },
});
const fail = (status: number, code: string): ApiResult<never> => ({
  ok: false,
  failure: { status, code },
});

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
    reload: () => undefined,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const form = () => wrap(<TypeNewForm options={options} csrfToken="c" />);
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
function fill() {
  type('Code (required)', 'organic');
  fireEvent.click(screen.getByLabelText(/Certificate from an issuer/));
  type('Name (required)', 'Organic');
  type('Description for customers (required)', 'The seller holds an organic certificate.');
  type(/Claim terms/, 'organic\ncertified organic');
}

describe('New type form', () => {
  it('refuses an empty form with a summary that takes focus, and shows each error under its field', () => {
    form();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const summary = screen.getByRole('alert', { name: 'Problems with the form' });
    expect(document.activeElement).toBe(summary);
    expect(within(summary).getByText(/things need fixing/)).toBeTruthy();
    expect(screen.getAllByText('Choose how the certificate is checked.').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Enter a name of up to 80/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('dialog')).toBeNull();
    // An entry of the summary moves focus to its field.
    fireEvent.click(within(summary).getAllByRole('link')[0]!);
    expect(document.activeElement).toBe(screen.getByLabelText('Code (required)'));
  });

  it('rejects a code that does not follow the pattern', () => {
    form();
    type('Code (required)', '1x');
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.getAllByText(/lowercase letters, digits or hyphens/).length).toBeGreaterThan(0);
  });

  it('follows the check method: document locked for an issuer certificate, no issuer switch and an auto-approve switch for a declaration', () => {
    form();
    fireEvent.click(screen.getByLabelText(/Certificate from an issuer/));
    const needsDocument = screen.getByLabelText<HTMLInputElement>('Needs a document');
    expect(needsDocument.checked).toBe(true);
    expect(needsDocument.disabled).toBe(true);
    expect(screen.getByLabelText('Needs an issuer from the registry')).toBeTruthy();
    expect(screen.queryByLabelText('Approve without a person')).toBeNull();
    fireEvent.click(screen.getByLabelText(/Seller's own declaration/));
    expect(screen.queryByLabelText('Needs an issuer from the registry')).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Needs a document').disabled).toBe(false);
    expect(screen.getByLabelText('Approve without a person')).toBeTruthy();
  });

  it('offers only the artwork of the API, with the text badge by its words', () => {
    form();
    const select = screen.getByLabelText<HTMLSelectElement>('Badge artwork');
    expect([...select.options].map((option) => option.value)).toEqual(['text', 'halal']);
    expect(select.value).toBe('text');
  });

  it('shows the review with the count, and sends the whole content', async () => {
    call.mockImplementation((_method, path) =>
      Promise.resolve(
        path.endsWith('impact-count')
          ? count()
          : { ok: true, status: 201, body: { typeId: TYPE, proposalId: 'p', status: 'proposed' } },
      ),
    );
    form();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Send this type for approval?')).toBeTruthy();
    expect(within(dialog).getByText(/organic, certified organic/)).toBeTruthy();
    expect(within(dialog).getByText('Another admin has to approve it.')).toBeTruthy();
    await within(dialog).findByText(/37 published texts that use these terms/);
    expect(call).toHaveBeenCalledWith(
      'POST',
      'catalog/admin/claim-terms/impact-count',
      { typeCode: 'organic', termsByLocale: { 'en-AU': ['organic', 'certified organic'] } },
      'c',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send for approval' }));
    await waitFor(() => expect(assigned).toBe(`/certificates/types/${TYPE}?done=proposed`));
    const sent = call.mock.calls.find(([, path]) => path === 'certification/admin/types');
    expect(sent?.[2]).toMatchObject({
      code: 'organic',
      content: {
        verificationMode: 'THIRD_PARTY_DOCUMENT',
        requiresDocument: true,
        autoApproveSelfDeclaration: false,
        badgeIconKey: 'text',
        locales: { 'en-AU': { name: 'Organic', claimTerms: ['organic', 'certified organic'] } },
      },
    });
  });

  it('says "at least" when the count is partial, and lets the admin send when the count fails', async () => {
    call.mockResolvedValueOnce(count({ total: 20000, complete: false }));
    form();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(await screen.findByText(/at least 20000 published texts/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    call.mockResolvedValueOnce(fail(503, 'claim-text.check-unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(
      await screen.findByText("We couldn't count the affected texts. You can still send it."),
    ).toBeTruthy();
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Send for approval' }).disabled,
    ).toBe(false);
  });

  it('closes the dialog on a taken code, shows the error under Code and focuses it', async () => {
    call.mockImplementation((_method, path) =>
      Promise.resolve(path.endsWith('impact-count') ? count() : fail(409, 'type.code-taken')),
    );
    form();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send for approval' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const code = screen.getByLabelText('Code (required)');
    expect(code.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getAllByText(/already used by another type/).length).toBeGreaterThan(0);
    await waitFor(() => expect(document.activeElement).toBe(code));
  });

  it('warns before leaving with entries that were not sent', () => {
    form();
    const quiet = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(quiet);
    expect(quiet.defaultPrevented).toBe(false);
    type('Code (required)', 'organic');
    const asks = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(asks);
    expect(asks.defaultPrevented).toBe(true);
  });
});

const proposal = (over: Partial<TypeProposal> = {}): TypeProposal => ({
  id: 'prop-1',
  proposer: { accountId: 'me' },
  proposedAt: '2026-11-22T01:00:00.000Z',
  state: 'pending',
  version: 4,
  reason: { state: 'given', text: 'A new scheme' },
  diff: [],
  actions: {
    approve: { allowed: false, code: 'review.second-admin-required' },
    reject: { allowed: false, code: 'review.proposer-cannot-reject' },
    withdraw: { allowed: true },
  },
  ...over,
});
const proposed = (pending: TypeProposal | null, status: TypeDetail['status'] = 'proposed') =>
  ({
    typeId: TYPE,
    code: 'organic',
    status,
    version: 1,
    published: {
      revisionNo: 1,
      createdAt: '2026-11-22T01:00:00.000Z',
      content: {
        verificationMode: 'THIRD_PARTY_DOCUMENT',
        requiresIssuerRegistry: true,
        requiresDocument: true,
        requiresExpiry: true,
        defaultBasis: 'SELLER_REQUIRED',
        badgeIconKey: 'text',
        locales: {
          'en-AU': { name: 'Organic', customerDescription: 'D', claimTerms: ['organic'] },
        },
      },
    },
    pendingRevision: null,
    pendingReactivation: null,
    pendingCreation: pending,
  }) satisfies TypeDetail;
const view = (
  type: TypeDetail,
  extra: { accountId?: string; canEdit?: boolean; hasActiveIssuer?: boolean | null } = {},
) =>
  wrap(
    <TypeDetailView
      type={type}
      name="Organic"
      canEdit={extra.canEdit ?? true}
      csrfToken="c"
      accountId={extra.accountId ?? 'me'}
      hasActiveIssuer={extra.hasActiveIssuer ?? true}
    />,
  );

describe('Proposed type page', () => {
  beforeEach(() => call.mockResolvedValue(count()));

  it('shows the proposer Withdraw and Change, with Approve and Reject disabled and the reason why', async () => {
    view(proposed(proposal()));
    expect(screen.getByText('Proposed')).toBeTruthy();
    expect(screen.getByText('Waiting for a second admin.')).toBeTruthy();
    expect(screen.getByText(/Proposed by you on 22 Nov 2026 \(UTC\)/)).toBeTruthy();
    expect(screen.getByText('You proposed this. Another admin has to approve it.')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Approve type' }).disabled).toBe(
      true,
    );
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Reject type' }).disabled).toBe(
      true,
    );
    expect(screen.getByRole('button', { name: 'Withdraw proposal' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Change this proposal' }).getAttribute('href')).toBe(
      `/certificates/types/${TYPE}/edit`,
    );
    await screen.findByText(/37 published texts/);
  });

  it('gives another admin Approve and Reject but no Withdraw, and approves under the proposal version', async () => {
    view(
      proposed(
        proposal({
          proposer: { accountId: 'someone' },
          actions: {
            approve: { allowed: true },
            reject: { allowed: true },
            withdraw: { allowed: false, code: 'review.not-proposer' },
          },
        }),
      ),
    );
    expect(screen.queryByRole('button', { name: 'Withdraw proposal' })).toBeNull();
    expect(screen.queryByText('You proposed this. Another admin has to approve it.')).toBeNull();
    call.mockResolvedValue({ ok: true, status: 200, body: {} });
    fireEvent.click(screen.getByRole('button', { name: 'Approve type' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve type' }),
    );
    await waitFor(() => expect(assigned).toBe(`/certificates/types/${TYPE}?done=type-approved`));
    expect(call).toHaveBeenLastCalledWith(
      'POST',
      `certification/admin/types/${TYPE}/creations/prop-1/approve`,
      { version: 4 },
      'c',
    );
  });

  it('shows the stale banner with a reload when the proposer changed the proposal meanwhile', async () => {
    view(
      proposed(
        proposal({
          proposer: { accountId: 'someone' },
          actions: {
            approve: { allowed: true },
            reject: { allowed: true },
            withdraw: { allowed: false },
          },
        }),
      ),
    );
    call.mockResolvedValue(fail(409, 'conflict.stale'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve type' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve type' }),
    );
    expect(
      await screen.findByText('This type changed while you were looking. Reload the page.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload the page' })).toBeTruthy();
  });

  it('warns, without blocking, when a type that needs an issuer has no active one', () => {
    view(proposed(proposal()), { hasActiveIssuer: false });
    expect(screen.getByText(/No issuer of this type is active/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Add an issuer' }).getAttribute('href')).toBe(
      '/certificates/issuers',
    );
  });

  it('shows the rule of no other admin when the server says so', () => {
    view(
      proposed(
        proposal({
          actions: {
            approve: { allowed: false, code: 'review.no-other-admin' },
            reject: { allowed: false },
            withdraw: { allowed: true },
          },
        }),
      ),
    );
    expect(screen.getByText(/No one else can approve this yet/)).toBeTruthy();
  });

  it('shows the artwork by its label and no Published row before the type is live', () => {
    view(proposed(proposal()));
    expect(screen.getByText('Text badge')).toBeTruthy();
    expect(screen.queryByText('text')).toBeNull();
    expect(screen.queryByText('Published')).toBeNull();
  });

  it('shows a rejected or withdrawn type read-only without buttons', () => {
    view(proposed(null, 'rejected'));
    expect(screen.getByText('Rejected')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Change this type' })).toBeNull();
  });

  it('keeps the buttons from a viewer without the edit permission', () => {
    view(proposed(proposal()), { canEdit: false });
    expect(screen.queryByRole('button', { name: 'Approve type' })).toBeNull();
  });
});

describe('Types toolbar', () => {
  it('hides New type without the edit permission and filters closed proposals', () => {
    wrap(<TypesToolbar canEdit={false} closed={false} />);
    expect(screen.queryByRole('link', { name: 'New type' })).toBeNull();
    fireEvent.click(screen.getByLabelText('Show closed proposals'));
    expect(assigned).toBe('/certificates/types?closed=true');
    cleanup();
    wrap(<TypesToolbar canEdit closed />);
    expect(screen.getByRole('link', { name: 'New type' }).getAttribute('href')).toBe(
      '/certificates/types/new',
    );
  });
});
