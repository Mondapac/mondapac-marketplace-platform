// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { expectToast } from '../../test/toast-spy.ts';
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
import { CertificateReview, missingFields } from './certificate-review.tsx';
import { DocumentsCard } from './documents-card.tsx';
import { certificateProblemOf } from './errors.ts';
import { IssuerRequestDialog } from './issuer-request-dialog.tsx';
import { mediaList, postWithProgress, sizeText } from './upload.ts';
import type {
  CertificateDetail,
  CertificateDocument,
  CertificateDocumentLimits,
  CertificateSummary,
  CertificateTypeOption,
} from './types.ts';

const call = vi.mocked(callApi);
const post = vi.mocked(postWithProgress);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="UTC">
    {node}
  </NextIntlClientProvider>
);

const A = '0190a000-0000-7000-8000-0000000000a1';
const D1 = '0190a000-0000-7000-8000-0000000000d1';
const D2 = '0190a000-0000-7000-8000-0000000000d2';
const ISSUER = '0190a000-0000-7000-8000-0000000000f1';

// The test Market's limits and type names are made up: the panel reads both from the API.
const limits: CertificateDocumentLimits = {
  mediaTypes: ['image/jpeg', 'image/png', 'application/pdf'],
  maxBytes: 4 * 1024 * 1024,
  maxFiles: 2,
  maxPdfPages: 7,
  draftQuotaBytes: 50 * 1024 * 1024,
};
const docType: CertificateTypeOption = {
  code: 'type-one',
  names: { en: 'Sample One' },
  verificationMode: 'THIRD_PARTY_DOCUMENT',
  requiresIssuerRegistry: true,
  requiresDocument: true,
  requiresExpiry: true,
  issuers: [{ issuerId: ISSUER, displayName: 'Sample Certifier' }],
};
const selfType: CertificateTypeOption = {
  code: 'type-two',
  names: { en: 'Sample Two' },
  verificationMode: 'SELF_DECLARATION',
  requiresIssuerRegistry: false,
  requiresDocument: false,
  requiresExpiry: false,
  issuers: [],
};

const summary = (over: Partial<CertificateSummary> = {}): CertificateSummary => ({
  certificateId: A,
  typeCode: 'type-one',
  status: 'draft',
  recordStatus: 'draft',
  submitBy: null,
  editable: true,
  deletable: true,
  withdrawable: false,
  createdAt: '2026-11-20T00:00:00.000Z',
  lastChangedAt: '2026-11-20T01:00:00.000Z',
  ...over,
});
const doc = (documentId: string, position: number, over: Partial<CertificateDocument> = {}) => ({
  documentId,
  position,
  mediaType: 'application/pdf',
  byteSize: 1468006,
  pageCount: 2,
  createdAt: '2026-11-20T01:00:00.000Z',
  ...over,
});
const complete: CertificateDetail = {
  certificate: summary(),
  draft: {
    issuerId: ISSUER,
    certificateNumber: 'NUM-0042',
    issueDate: '2026-07-01',
    expiryDate: '2027-06-30',
    selfDeclared: null,
    selfDeclarationNote: null,
  },
  documents: [doc(D1, 1)],
};
const empty: CertificateDetail = {
  certificate: summary(),
  draft: {
    issuerId: null,
    certificateNumber: null,
    issueDate: null,
    expiryDate: null,
    selfDeclared: null,
    selfDeclarationNote: null,
  },
  documents: [],
};

const file = (name: string, type: string, size: number) => {
  const made = new File(['x'], name, { type });
  Object.defineProperty(made, 'size', { value: size });
  return made;
};
const picker = () => document.querySelector<HTMLInputElement>('input[type="file"]');

beforeEach(() => {
  vi.clearAllMocks();
  call.mockReset();
  post.mockReset();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('file limits in words', () => {
  it('names the kinds and sizes the API gives, in the page language', () => {
    expect(mediaList(limits.mediaTypes, 'en-AU')).toBe('JPEG, PNG or PDF');
    expect(sizeText(limits.maxBytes, 'en-AU')).toBe('4 MB');
    expect(sizeText(1468006, 'en-AU')).toBe('1.4 MB');
  });

  it('has words for every file refusal the card can show', () => {
    for (const code of [
      'file.too-large',
      'file.unsupported-type',
      'file.encrypted',
      'file.active-content',
      'file.infected',
      'file.too-many-pages',
      'file.unreadable',
      'file.scan-unavailable',
      'document.limit-reached',
      'draft-quota.exceeded',
    ]) {
      const key = certificateProblemOf({ status: 422, code }).key;
      expect(key.startsWith('certification.error.'), code).toBe(true);
    }
  });
});

describe('Documents card', () => {
  const card = (documents: readonly CertificateDocument[] = [], editable = true) =>
    render(
      wrap(
        <DocumentsCard
          certificateId={A}
          documents={documents}
          limits={limits}
          editable={editable}
          required
          csrfToken="csrf"
        />,
      ),
    );

  it('shows the limits from the API and each stored file with Download as an attachment', () => {
    card([doc(D2, 3, { mediaType: 'image/jpeg', pageCount: null }), doc(D1, 1)]);
    expect(
      screen.getByText('JPEG, PNG or PDF. Up to 4 MB per file, 2 files, 7 pages per PDF.'),
    ).toBeTruthy();
    const rows = screen.getAllByRole('listitem');
    // The server keeps no file name: the files read "Page n" in their order.
    expect(within(rows[0]!).getByText('Page 1')).toBeTruthy();
    expect(within(rows[0]!).getByText('PDF · 2 pages · 1.4 MB')).toBeTruthy();
    expect(within(rows[1]!).getByText('Page 2')).toBeTruthy();
    const download = within(rows[0]!).getByRole('link', { name: 'Download Page 1' });
    expect(download.getAttribute('href')).toBe(
      `/api/certification/seller/certificates/${A}/documents/${D1}`,
    );
    expect(download.hasAttribute('download')).toBe(true);
  });

  it('refuses a file over the size limit before sending a byte', async () => {
    card();
    fireEvent.change(picker()!, { target: { files: [file('big.pdf', 'application/pdf', 5e6)] } });
    expect(await screen.findByText(/This file is larger than 4 MB/)).toBeTruthy();
    expect(screen.getByText("Can't use this file.")).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    expect(screen.queryByRole('link', { name: /Download/ })).toBeNull();
  });

  it('uploads at once, shows checking, then Ready, and says so politely', async () => {
    let sent: () => void = () => undefined;
    let finish: (value: Awaited<ReturnType<typeof postWithProgress>>) => void = () => undefined;
    post.mockImplementation((_path, _body, _csrf, onProgress, onSent) => {
      onProgress(0.5);
      sent = onSent;
      return new Promise((resolve) => (finish = resolve));
    });
    card();
    fireEvent.change(picker()!, {
      target: { files: [file('photo.jpg', 'image/jpeg', 3_000_000)] },
    });
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![0]).toBe(`certification/seller/certificates/${A}/documents`);
    expect(post.mock.calls[0]![1]).toEqual({ data: 'QUJD' });
    expect(screen.getByText('photo.jpg')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
    sent();
    expect(await screen.findByText('Checking this file…')).toBeTruthy();
    finish({
      ok: true,
      status: 201,
      body: {
        ...doc(D1, 1, { mediaType: 'image/jpeg', pageCount: null }),
        withdrawnSubmissionId: null,
      },
    });
    expect(await screen.findByText('Ready')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('photo.jpg: Ready');
    expect(screen.getByRole('link', { name: 'Download photo.jpg' })).toBeTruthy();
  });

  it('shows the API refusal as "Can\'t use this file" with the reason, and no Download', async () => {
    post.mockResolvedValue({ ok: false, failure: { status: 422, code: 'file.encrypted' } });
    card();
    fireEvent.change(picker()!, {
      target: { files: [file('scan-old.pdf', 'application/pdf', 1000)] },
    });
    expect(await screen.findByText(/This PDF is locked with a password/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Download/ })).toBeNull();
    expect(screen.getByText('Replace')).toBeTruthy();
    // Removing a refused file only takes it off the page.
    fireEvent.click(screen.getByRole('button', { name: 'Remove scan-old.pdf' }));
    expect(screen.queryByText('scan-old.pdf')).toBeNull();
    expect(call).not.toHaveBeenCalled();
  });

  it('turns Choose files off at the file limit', () => {
    card([doc(D1, 1), doc(D2, 2)]);
    expect(picker()!.disabled).toBe(true);
    expect(screen.getByText("You've added the most files allowed.")).toBeTruthy();
  });

  it('removes a stored file on the server', async () => {
    call.mockResolvedValue({ ok: true, status: 200, body: { removed: true } });
    card([doc(D1, 1)]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Page 1' }));
    await waitFor(() => expect(screen.queryByText('Page 1')).toBeNull());
    expect(call).toHaveBeenCalledWith(
      'DELETE',
      `certification/seller/certificates/${A}/documents/${D1}`,
      undefined,
      'csrf',
    );
    expect(screen.getByRole('status').textContent).toBe('Page 1: Removed');
  });

  it('offers no upload, Replace or Remove in view only', () => {
    card([doc(D1, 1)], false);
    expect(picker()).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Download Page 1' })).toBeTruthy();
  });
});

describe("My issuer isn't listed", () => {
  const dialog = (onSent = vi.fn()) =>
    render(
      wrap(
        <IssuerRequestDialog
          open
          typeCode="type-one"
          limits={limits}
          csrfToken="csrf"
          onClose={vi.fn()}
          onSent={onSent}
        />,
      ),
    );

  it('needs the name and one file', async () => {
    dialog();
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByText('Fill this in.')).toBeTruthy();
    expect(screen.getByText('Add the certificate file.')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('sends the typed name and the file as a request, nothing else', async () => {
    post.mockResolvedValue({
      ok: true,
      status: 201,
      body: { issuerRequestId: D1 },
    });
    const onSent = vi.fn();
    dialog(onSent);
    fireEvent.change(screen.getByLabelText('Issuer name (as written on your certificate)'), {
      target: { value: '  A Local Certifier  ' },
    });
    fireEvent.change(picker()!, { target: { files: [file('c.pdf', 'application/pdf', 1000)] } });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(onSent).toHaveBeenCalled());
    expect(post.mock.calls[0]![0]).toBe('certification/seller/issuer-requests');
    expect(post.mock.calls[0]![1]).toEqual({
      typeCode: 'type-one',
      issuerName: 'A Local Certifier',
      data: 'QUJD',
    });
  });

  it('says a request is already open in the approved words', async () => {
    post.mockResolvedValue({
      ok: false,
      failure: { status: 409, code: 'issuer-request.already-open' },
    });
    dialog();
    fireEvent.change(screen.getByLabelText('Issuer name (as written on your certificate)'), {
      target: { value: 'Name' },
    });
    fireEvent.change(picker()!, { target: { files: [file('c.png', 'image/png', 1000)] } });
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByText("We're checking your issuer.")).toBeTruthy();
  });
});

describe('certificate form with documents', () => {
  const form = (detail: CertificateDetail = complete) =>
    render(
      wrap(
        <CertificateForm
          detail={detail}
          type={docType}
          canManage
          zone="Australia/Brisbane"
          limits={limits}
          csrfToken="csrf"
        />,
      ),
    );

  it('has the Documents card, the issuer link, and Save draft and Review in the bar', () => {
    form();
    expect(screen.getByRole('heading', { name: 'Documents' })).toBeTruthy();
    expect(screen.getByRole('button', { name: "My issuer isn't listed" })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review' })).toBeTruthy();
  });

  it('Review opens the review page; with changes it saves them first', async () => {
    form();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    await waitFor(() =>
      expect(router.push).toHaveBeenCalledWith(`/settings/certificates/${A}/review`),
    );
    expect(call).not.toHaveBeenCalled();

    cleanup();
    router.push.mockReset();
    call.mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        certificate: summary(),
        draft: { ...complete.draft, certificateNumber: 'NUM-0043' },
        withdrawnSubmissionId: null,
      },
    });
    form();
    fireEvent.change(screen.getByLabelText('Certificate number'), {
      target: { value: 'NUM-0043' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    await waitFor(() => expect(router.push).toHaveBeenCalled());
    expect(call.mock.calls[0]![0]).toBe('PUT');
  });

  it('stays on the form when the save before Review is refused', async () => {
    call.mockResolvedValue({ ok: false, failure: { status: 409, code: 'conflict.stale' } });
    form();
    fireEvent.change(screen.getByLabelText('Certificate number'), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(await screen.findByText(/This certificate has changed/)).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('shows "Checking your issuer" and hides the link while a request is open', () => {
    form({ ...empty, certificate: summary({ status: 'draft-issuer-not-listed' }) });
    expect(screen.getByText(/Once we've added your issuer, choose it from the list/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: "My issuer isn't listed" })).toBeNull();
  });
});

describe('review and submit', () => {
  const review = (detail: CertificateDetail = complete, type = docType) =>
    render(
      wrap(
        <CertificateReview
          detail={detail}
          type={type}
          zone="Australia/Brisbane"
          csrfToken="csrf"
        />,
      ),
    );

  it('works out what is missing as the API does', () => {
    expect(missingFields(docType, complete)).toEqual([]);
    expect(missingFields(docType, empty)).toEqual([
      'issuerId',
      'certificateNumber',
      'expiryDate',
      'documents',
    ]);
    expect(
      missingFields(selfType, { ...empty, certificate: summary({ typeCode: 'type-two' }) }),
    ).toEqual(['selfDeclared']);
    // An issuer that no longer takes certificates is not a choice.
    expect(missingFields({ ...docType, issuers: [] }, complete)).toEqual(['issuerId']);
  });

  it('lists every value with Edit back to its field', () => {
    review();
    expect(screen.getByRole('heading', { name: 'Review your certificate' })).toBeTruthy();
    expect(screen.getByText('Sample Certifier')).toBeTruthy();
    expect(screen.getByText('NUM-0042')).toBeTruthy();
    expect(screen.getByText('Valid until the end of 30 June 2027, Brisbane time')).toBeTruthy();
    expect(screen.getByText('Page 1 · PDF · 2 pages')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Edit Certificate number' }).getAttribute('href')).toBe(
      `/settings/certificates/${A}#certificate-certificateNumber`,
    );
  });

  it('keeps Submit unavailable while items are missing and links the first one', () => {
    review(empty);
    expect(screen.getAllByText('Missing')).toHaveLength(4);
    const submit = screen.getByRole('button', { name: 'Submit for review' });
    expect(submit.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(submit);
    expect(call).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Finish 4 items first.' }).getAttribute('href')).toBe(
      `/settings/certificates/${A}#certificate-issuerId`,
    );
  });

  it('submits and opens the certificate', async () => {
    call.mockResolvedValue({
      ok: true,
      status: 201,
      body: { certificateId: A, submissionId: D1, kind: 'initial', submittedAt: '' },
    });
    review();
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/settings/certificates/${A}`));
    expect(call).toHaveBeenCalledWith(
      'POST',
      `certification/seller/certificates/${A}/submit`,
      undefined,
      'csrf',
    );
    await expectToast('Submitted for review');
  });

  it('marks what the API says is missing', async () => {
    call.mockResolvedValue({
      ok: false,
      failure: {
        status: 422,
        code: 'certificate.incomplete',
        details: { fields: [{ path: 'documents', code: 'required' }] },
      },
    });
    review();
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    expect(await screen.findByText('Missing')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Finish 1 item first.' })).toBeTruthy();
  });

  it('says "Submit again" after changes were requested', () => {
    review({ ...complete, certificate: summary({ status: 'changes-needed', deletable: false }) });
    expect(screen.getByRole('button', { name: 'Submit again' })).toBeTruthy();
  });

  it('cannot submit while the issuer is being checked', () => {
    review({
      ...complete,
      draft: { ...complete.draft, issuerId: null },
      certificate: summary({ status: 'draft-issuer-not-listed' }),
    });
    expect(
      screen.getByRole('button', { name: 'Submit for review' }).getAttribute('aria-disabled'),
    ).toBe('true');
    expect(
      screen.getByText("You can submit once we've added your issuer and you've chosen it."),
    ).toBeTruthy();
  });
});
