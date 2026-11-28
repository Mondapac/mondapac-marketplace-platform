// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import type * as UploadModule from './upload.ts';

const router = { push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));
vi.mock('./upload.ts', async (original) => ({
  ...(await original<typeof UploadModule>()),
  readAsBase64: vi.fn(() => Promise.resolve('QUJD')),
  postWithProgress: vi.fn(),
}));

import { callApi } from '../api/client.ts';
import { CertificateForm } from './certificate-form.tsx';
import { CertificateReview } from './certificate-review.tsx';
import { ADD_CERTIFICATE_PATH, CertificateStatusPage } from './certificate-status.tsx';
import { CertificatesList } from './certificates-list.tsx';
import {
  dashboardAlertOf,
  formModeOf,
  formPathOf,
  mostUrgentExpiry,
  nextStepKey,
  rowActionKey,
  statusActions,
  submitKeyOf,
} from './status.ts';
import { postWithProgress } from './upload.ts';
import type {
  CertificateDetail,
  CertificateSummary,
  CertificateTypeOption,
  SellerAccountState,
} from './types.ts';

// Seller certificates PR 4 (design sections 5.1, 7.2, 9 to 11): the status page, withdraw, edit
// while under review, correct, renew and the expiry banner. Type names and reasons are made up:
// the panel reads every one from the API.

const call = vi.mocked(callApi);
const post = vi.mocked(postWithProgress);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="UTC">
    {node}
  </NextIntlClientProvider>
);

const A = '0190a000-0000-7000-8000-0000000000a1';
const B = '0190a000-0000-7000-8000-0000000000b1';
const C = '0190a000-0000-7000-8000-0000000000c1';
const ISSUER = '0190a000-0000-7000-8000-0000000000f1';
const D1 = '0190a000-0000-7000-8000-0000000000d1';

const docType: CertificateTypeOption = {
  code: 'type-one',
  names: { en: 'Sample One' },
  verificationMode: 'THIRD_PARTY_DOCUMENT',
  requiresIssuerRegistry: true,
  requiresDocument: true,
  requiresExpiry: true,
  issuers: [{ issuerId: ISSUER, displayName: 'Sample Certifier' }],
};

const summary = (over: Partial<CertificateSummary> = {}): CertificateSummary => ({
  certificateId: A,
  typeCode: 'type-one',
  status: 'awaiting-review',
  recordStatus: 'in-review',
  submitBy: null,
  editable: false,
  deletable: false,
  withdrawable: true,
  createdAt: '2026-11-20T00:00:00.000Z',
  lastChangedAt: '2026-11-20T01:00:00.000Z',
  issuerName: 'Sample Certifier',
  validUntil: null,
  renewalSubmitBy: null,
  daysLeft: null,
  bannerTone: null,
  ...over,
});

const detail = (over: Partial<CertificateDetail> = {}): CertificateDetail => ({
  certificate: summary(),
  draft: {
    issuerId: ISSUER,
    certificateNumber: 'NUM-0042',
    issueDate: '2026-07-01',
    expiryDate: '2027-06-30',
    selfDeclared: null,
    selfDeclarationNote: null,
  },
  documents: [
    {
      documentId: D1,
      position: 1,
      mediaType: 'application/pdf',
      byteSize: 1000,
      pageCount: 2,
      createdAt: '2026-11-20T01:00:00.000Z',
    },
  ],
  decision: null,
  history: [{ event: 'submitted', reasonLabel: null, at: '2026-11-26T23:14:00.000Z' }],
  inForce: null,
  ...over,
});

const approved = (over: Partial<CertificateSummary> = {}) =>
  summary({
    status: 'approved',
    recordStatus: 'approved',
    editable: true,
    withdrawable: false,
    validUntil: '2027-06-30',
    renewalSubmitBy: '2027-06-16',
    daysLeft: 200,
    ...over,
  });

const inForce = {
  issuerId: ISSUER,
  issuerName: 'Sample Certifier',
  certificateNumber: 'NUM-0001',
  issueDate: '2025-07-01',
  expiryDate: '2026-06-30',
  approvedAt: '2025-07-02T00:00:00.000Z',
};

function statusPage(
  value: CertificateDetail,
  {
    canManage = true,
    account = 'approved',
  }: { readonly canManage?: boolean; readonly account?: SellerAccountState } = {},
) {
  return render(
    wrap(
      <CertificateStatusPage
        detail={value}
        type={docType}
        canManage={canManage}
        account={account}
        zone="Australia/Brisbane"
        csrfToken="csrf"
      />,
    ),
  );
}

beforeEach(() => {
  // jsdom has no modal dialogs: open and close the element as the browser would.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  vi.clearAllMocks();
  call.mockReset();
  post.mockReset();
});
afterEach(cleanup);

describe('the buttons of each status', () => {
  it('builds every button from the API flags and the status', () => {
    const ids = (value: CertificateSummary) => statusActions(value).map((action) => action.id);
    expect(ids(summary())).toEqual(['edit', 'withdraw']);
    expect(ids(summary({ status: 'approved-renewal-pending', recordStatus: 'approved' }))).toEqual([
      'edit',
      'withdraw',
    ]);
    const sentBack = { editable: true, withdrawable: false };
    expect(ids(summary({ status: 'changes-needed', ...sentBack }))).toEqual(['correct']);
    expect(ids(summary({ status: 'approved-renewal-changes-needed', ...sentBack }))).toEqual([
      'correct',
    ]);
    expect(ids(approved())).toEqual(['renew']);
    expect(ids(approved({ status: 'approved-expiring' }))).toEqual(['renew']);
    expect(ids(approved({ status: 'expired' }))).toEqual(['renew']);
    expect(ids(summary({ status: 'declined', withdrawable: false }))).toEqual(['add']);
    expect(ids(summary({ status: 'revoked', withdrawable: false }))).toEqual(['add']);
    // A record the API closed offers nothing, whatever its status says.
    expect(ids(approved({ editable: false }))).toEqual([]);
  });

  it('names the replacement of an issuer no longer recognised', () => {
    const replacement = approved({ status: 'issuer-not-recognised' });
    expect(rowActionKey(replacement)).toBe('certification.issuer-not-recognised.action');
    expect(rowActionKey(approved())).toBe('certification.action.renew');
    expect(rowActionKey(summary())).toBeNull();
  });

  it('opens a draft on its own page and every other form at edit', () => {
    expect(formPathOf(summary({ status: 'draft', editable: true, withdrawable: false }))).toBe(
      `/settings/certificates/${A}`,
    );
    expect(formPathOf(approved())).toBe(`/settings/certificates/${A}/edit`);
    expect(formModeOf(summary())).toBe('pending');
    expect(formModeOf(approved())).toBe('renew');
  });

  it('words Submit after the kind of the next submission', () => {
    expect(submitKeyOf(approved())).toBe('certification.review.action.renew');
    expect(
      submitKeyOf(summary({ status: 'changes-needed', editable: true, withdrawable: false })),
    ).toBe('certification.review.action.again');
    expect(submitKeyOf(summary({ status: 'draft', editable: true, withdrawable: false }))).toBe(
      'certification.review.action.submit',
    );
  });

  it('has words for a known next step only', () => {
    expect(nextStepKey('check-dates')).toBe('certification.next-step.check-dates');
    expect(nextStepKey('made-up-step')).toBeNull();
  });
});

describe('the expiry banner and the dashboard alert', () => {
  it('picks the most urgent certificate: expired first, then the fewest days left', () => {
    const soon = approved({
      certificateId: B,
      status: 'approved-expiring',
      daysLeft: 3,
      bannerTone: 'attention',
    });
    const later = approved({
      certificateId: C,
      status: 'approved-expiring',
      daysLeft: 25,
      bannerTone: 'info',
    });
    const gone = approved({ status: 'expired', daysLeft: -4, bannerTone: 'critical' });
    expect(mostUrgentExpiry([later, soon])?.certificateId).toBe(B);
    expect(mostUrgentExpiry([later, soon, gone])?.certificateId).toBe(A);
    // No tone from the API, no banner: the panel counts no days itself.
    expect(mostUrgentExpiry([approved({ daysLeft: 2 })])).toBeNull();
  });

  it('warns on the dashboard about expired, expiring and sent-back certificates only', () => {
    expect(dashboardAlertOf([approved(), summary()])).toBeNull();
    const changes = summary({ certificateId: B, status: 'changes-needed', withdrawable: false });
    expect(dashboardAlertOf([approved(), changes])?.certificateId).toBe(B);
    const gone = approved({ certificateId: C, status: 'expired', bannerTone: 'critical' });
    expect(dashboardAlertOf([changes, gone])?.certificateId).toBe(C);
  });

  it('shows one banner on the list with both dates and Renew', () => {
    const soon = approved({ status: 'approved-expiring', daysLeft: 10, bannerTone: 'attention' });
    render(
      wrap(
        <CertificatesList
          list={{ certificates: [soon], nextAfterId: null }}
          options={{ types: [docType] }}
          account="approved"
          canManage
          zone="Australia/Brisbane"
          csrfToken="csrf"
        />,
      ),
    );
    const banner = screen.getByTestId('expiry-banner');
    expect(banner.dataset.tone).toBe('attention');
    expect(banner.textContent).toContain('Your Sample One certificate expires on 30 June 2027');
    expect(banner.textContent).toContain('Brisbane time');
    expect(banner.textContent).toContain('Submit your renewal by 16 June 2027');
    expect(
      within(banner).getByRole('link', { name: 'Renew: Sample One' }).getAttribute('href'),
    ).toBe(`/settings/certificates/${A}/edit`);
  });
});

describe('the status page', () => {
  it('shows a certificate under review with Edit and Withdraw, and no review time', () => {
    statusPage(detail());
    expect(screen.getByRole('heading', { name: 'Sample One certificate' })).toBeTruthy();
    expect(screen.getByText("We're reviewing your certificate")).toBeTruthy();
    expect(screen.getByTestId('seller-state').textContent).toContain('Seller approved');
    expect(screen.getByRole('link', { name: 'Edit certificate' }).getAttribute('href')).toBe(
      `/settings/certificates/${A}/edit`,
    );
    expect(screen.getByRole('button', { name: 'Withdraw submission' })).toBeTruthy();
    expect(screen.getByText(/Submitted on 27 Nov 2026/)).toBeTruthy();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/within|usually|queue position|verified/i);
  });

  it('withdraws after the seller confirms, and keeps everything on Cancel', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: summary({ status: 'draft' }) });
    statusPage(detail());
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw submission' }));
    const dialog = await screen.findByRole('dialog', { name: 'Withdraw your submission?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(call).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Withdraw submission' }));
    const again = await screen.findByRole('dialog', { name: 'Withdraw your submission?' });
    fireEvent.click(within(again).getByRole('button', { name: 'Withdraw submission' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'POST',
        `certification/seller/certificates/${A}/withdraw`,
        undefined,
        'csrf',
      ),
    );
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('shows the reason, the next step and the reviewer note as plain text', () => {
    statusPage(
      detail({
        certificate: summary({ status: 'changes-needed', editable: true, withdrawable: false }),
        decision: {
          outcome: 'changes-requested',
          reasonCode: 'dates-unclear',
          reasonLabel: 'The dates you entered do not match the certificate.',
          nextStep: 'check-dates',
          reasonText: '<a href="https://example.com">The scan shows 30 June 2026.</a>',
          decidedAt: '2026-11-28T04:05:00.000Z',
        },
      }),
    );
    const reason = screen.getByTestId('decision-reason');
    expect(reason.textContent).toContain('The dates you entered do not match the certificate.');
    expect(reason.textContent).toContain('Correct the dates, or upload the right document.');
    expect(reason.textContent).toContain('<a href="https://example.com">');
    expect(reason.querySelector('a')).toBeNull();
    expect(screen.getByText(/Decided on 28 Nov 2026/)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Correct and submit again' }).getAttribute('href'),
    ).toBe(`/settings/certificates/${A}/edit`);
  });

  it('offers a new certificate after a decline, and says it can not be sent again', () => {
    statusPage(
      detail({
        certificate: summary({ status: 'declined', withdrawable: false }),
        decision: {
          outcome: 'declined',
          reasonCode: 'x',
          reasonLabel: 'Sample reason.',
          nextStep: 'made-up-step',
          reasonText: null,
          decidedAt: '2026-11-28T04:05:00.000Z',
        },
      }),
    );
    expect(
      screen.getByText("You can't send this certificate again. You can add a different one."),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Add a certificate' }).getAttribute('href')).toBe(
      ADD_CERTIFICATE_PATH,
    );
  });

  it('shows the certificate in force beside a renewal under review', () => {
    statusPage(
      detail({
        certificate: approved({
          status: 'approved-renewal-pending',
          editable: false,
          withdrawable: true,
        }),
        inForce,
      }),
    );
    expect(screen.getByText('Your renewal is being reviewed')).toBeTruthy();
    expect(screen.getByText(/stays valid until 30 June 2027/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Certificate in force' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Your renewal' })).toBeTruthy();
    expect(screen.getByText('NUM-0001')).toBeTruthy();
    expect(screen.getByText('NUM-0042')).toBeTruthy();
  });

  it('says a certificate has no effect before the seller is approved', () => {
    statusPage(detail(), { account: 'awaiting-review' });
    expect(
      screen.getByText(
        'This certificate can be reviewed now. It has no effect until your seller application is approved.',
      ),
    ).toBeTruthy();
    expect(screen.getByTestId('seller-state').textContent).toContain('Application in review');
  });

  it('keeps the buttons focusable with the reason for a view-only role', () => {
    statusPage(detail(), { canManage: false });
    const withdraw = screen.getByRole('button', { name: 'Withdraw submission' });
    expect(withdraw.getAttribute('aria-disabled')).toBe('true');
    expect(withdraw.getAttribute('aria-describedby')).toBeTruthy();
    fireEvent.click(withdraw);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Edit certificate' })).toBeNull();
  });

  it('lists the short history in the seller’s words', () => {
    statusPage(
      detail({
        certificate: approved(),
        inForce,
        history: [
          { event: 'approved', reasonLabel: null, at: '2026-11-28T00:00:00.000Z' },
          { event: 'submitted-again', reasonLabel: null, at: '2026-11-27T00:00:00.000Z' },
          {
            event: 'changes-requested',
            reasonLabel: 'Sample reason.',
            at: '2026-11-26T00:00:00.000Z',
          },
          { event: 'made-up', reasonLabel: null, at: '2026-11-25T00:00:00.000Z' },
        ],
      }),
    );
    const history = screen.getByTestId('certificate-history');
    expect(within(history).getAllByRole('listitem')).toHaveLength(3);
    expect(history.textContent).toContain('Submitted again');
    expect(history.textContent).toContain('Sample reason.');
    expect(screen.getByText('Your certificate is approved')).toBeTruthy();
  });
});

describe('the form after a submission', () => {
  function form(value: CertificateDetail) {
    return render(
      wrap(
        <CertificateForm
          detail={value}
          type={docType}
          canManage
          zone="Australia/Brisbane"
          csrfToken="csrf"
        />,
      ),
    );
  }
  const saved = (status: string) => ({
    ok: true as const,
    status: 200,
    body: {
      certificate: summary({ status, editable: true, withdrawable: false }),
      draft: { ...detail().draft, certificateNumber: 'NUM-0043' },
      withdrawnSubmissionId: B,
    },
  });

  it('asks before a change withdraws the submission under review', async () => {
    call.mockResolvedValue(saved('draft'));
    form(detail());
    expect(screen.getByText(/Your certificate is waiting for review/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Certificate number'), {
      target: { value: 'NUM-0043' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Save and withdraw your submission?',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByLabelText<HTMLInputElement>('Certificate number').value).toBe('NUM-0043');

    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    const again = await screen.findByRole('dialog', { name: 'Save and withdraw your submission?' });
    fireEvent.click(within(again).getByRole('button', { name: 'Save and withdraw' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'PUT',
        `certification/seller/certificates/${A}?withdrawPending=true`,
        expect.objectContaining({ certificateNumber: 'NUM-0043' }),
        'csrf',
      ),
    );
    // Withdrawn, it is a draft again: Review is back and the warning is gone.
    expect(await screen.findByRole('button', { name: 'Review' })).toBeTruthy();
    expect(screen.queryByText(/Your certificate is waiting for review/)).toBeNull();
  });

  it('asks before a new file withdraws the submission, and sends nothing on Cancel', async () => {
    form(detail());
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error('no file input');
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'scan.pdf', { type: 'application/pdf' })] },
    });
    const dialog = await screen.findByRole('dialog', {
      name: 'Save and withdraw your submission?',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(post).not.toHaveBeenCalled();

    post.mockResolvedValue({
      ok: true,
      status: 201,
      body: {
        documentId: B,
        position: 2,
        mediaType: 'application/pdf',
        byteSize: 1,
        pageCount: 1,
        createdAt: '2026-11-28T00:00:00.000Z',
        withdrawnSubmissionId: C,
      },
    });
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: detail({
        certificate: summary({ status: 'draft', editable: true, withdrawable: false }),
      }),
    });
    fireEvent.change(input, {
      target: { files: [new File(['x'], 'scan.pdf', { type: 'application/pdf' })] },
    });
    const again = await screen.findByRole('dialog', { name: 'Save and withdraw your submission?' });
    fireEvent.click(within(again).getByRole('button', { name: 'Save and withdraw' }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0]?.[0]).toBe(
      `certification/seller/certificates/${A}/documents?withdrawPending=true`,
    );
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith('GET', `certification/seller/certificates/${A}`),
    );
  });

  it('opens a correction with the reason and saves without asking', async () => {
    call.mockResolvedValue(saved('changes-needed'));
    form(
      detail({
        certificate: summary({ status: 'changes-needed', editable: true, withdrawable: false }),
        decision: {
          outcome: 'changes-requested',
          reasonCode: 'dates-unclear',
          reasonLabel: 'The dates you entered do not match the certificate.',
          nextStep: 'check-dates',
          reasonText: null,
          decidedAt: '2026-11-28T04:05:00.000Z',
        },
      }),
    );
    expect(screen.getByTestId('form-reason').textContent).toContain(
      'Correct the dates, or upload the right document.',
    );
    fireEvent.change(screen.getByLabelText('Certificate number'), {
      target: { value: 'NUM-0043' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'PUT',
        `certification/seller/certificates/${A}`,
        expect.anything(),
        'csrf',
      ),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens a renewal prefilled, saying the current certificate stays valid', () => {
    form(detail({ certificate: approved(), inForce }));
    expect(
      screen.getByText(
        "Your current certificate stays valid until 30 June 2027. A renewal doesn't extend it until it's approved.",
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Certificate number').value).toBe('NUM-0042');
    expect(screen.getByRole('button', { name: 'Review' })).toBeTruthy();
  });

  it('submits a renewal as "Submit renewal" and returns to the status page', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 201,
      body: {
        certificateId: A,
        submissionId: B,
        kind: 'renewal',
        submittedAt: '2026-11-28T00:00:00.000Z',
      },
    });
    render(
      wrap(
        <CertificateReview
          detail={detail({ certificate: approved(), inForce })}
          type={docType}
          zone="Australia/Brisbane"
          csrfToken="csrf"
        />,
      ),
    );
    expect(screen.getByRole('link', { name: 'Back to edit' }).getAttribute('href')).toBe(
      `/settings/certificates/${A}/edit`,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit renewal' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/settings/certificates/${A}`));
  });
});
