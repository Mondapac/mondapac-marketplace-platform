// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../../messages/en.json';
import { expectToast } from '../../test/toast-spy.ts';

const router = { push: vi.fn(), refresh: vi.fn() };
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('../api/client.ts', () => ({ callApi: vi.fn() }));

import { callApi } from '../api/client.ts';
import { CertificateForm, draftBody, zonePlace } from './certificate-form.tsx';
import { CertificatesList } from './certificates-list.tsx';
import { certificateProblemOf } from './errors.ts';
import { blocksNewOfType, rowActionKey, sortForList, statusLook } from './status.ts';
import {
  typeName,
  type CertificateDetail,
  type CertificateSummary,
  type CertificateTypeOption,
} from './types.ts';

const call = vi.mocked(callApi);
const wrap = (node: ReactNode) => (
  <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="UTC">
    {node}
  </NextIntlClientProvider>
);

const A = '0190a000-0000-7000-8000-0000000000a1';
const B = '0190a000-0000-7000-8000-0000000000b2';
const C = '0190a000-0000-7000-8000-0000000000c3';
const ISSUER = '0190a000-0000-7000-8000-0000000000f1';

// The type names are data the Market owns: the test Market calls its types by made-up names.
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

const detail = (over: Partial<CertificateSummary> = {}): CertificateDetail => ({
  certificate: summary(over),
  draft: {
    issuerId: null,
    certificateNumber: null,
    issueDate: null,
    expiryDate: null,
    selfDeclared: null,
    selfDeclarationNote: null,
  },
  documents: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  call.mockReset();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

describe('certificate statuses', () => {
  it('has an icon, a tone and words for all thirteen statuses, and a safe unknown', () => {
    const codes = [
      'draft',
      'draft-issuer-not-listed',
      'awaiting-review',
      'changes-needed',
      'declined',
      'approved',
      'approved-expiring',
      'approved-renewal-pending',
      'approved-renewal-changes-needed',
      'expired',
      'expired-renewal-pending',
      'revoked',
      'issuer-not-recognised',
    ];
    const words = messages.certification.status as Record<string, string>;
    for (const code of codes) {
      const look = statusLook(code);
      expect(look.labelKey).toBe(`certification.status.${code}`);
      expect(words[code], code).toBeTruthy();
    }
    expect(statusLook('brand-new').labelKey).toBe('certification.status.unknown');
  });

  it('puts what needs work first, then the newest change', () => {
    const rows = sortForList([
      summary({ certificateId: A, status: 'approved', lastChangedAt: '2026-11-25T00:00:00Z' }),
      summary({
        certificateId: B,
        status: 'changes-needed',
        lastChangedAt: '2026-11-01T00:00:00Z',
      }),
      summary({ certificateId: C, status: 'expired', lastChangedAt: '2026-10-01T00:00:00Z' }),
    ]);
    expect(rows.map((row) => row.certificateId)).toEqual([C, B, A]);
  });

  it('offers Continue for a draft, Correct for changes, and nothing while under review', () => {
    expect(rowActionKey(summary())).toBe('certification.action.continue');
    expect(rowActionKey(summary({ status: 'changes-needed' }))).toBe(
      'certification.changes.action',
    );
    expect(rowActionKey(summary({ status: 'awaiting-review' }))).toBeNull();
    expect(rowActionKey(summary({ status: 'draft', editable: false }))).toBeNull();
  });

  it('lets a declined or revoked certificate make way for a new one of its type', () => {
    expect(blocksNewOfType(summary({ status: 'declined' }))).toBe(false);
    expect(blocksNewOfType(summary({ status: 'revoked' }))).toBe(false);
    expect(blocksNewOfType(summary({ status: 'expired' }))).toBe(true);
  });
});

describe('certificate refusals', () => {
  it('maps the API codes to the approved copy, never to the server text', () => {
    expect(certificateProblemOf({ status: 422, code: 'file.encrypted' }).key).toBe(
      'certification.error.file.encrypted-pdf',
    );
    expect(certificateProblemOf({ status: 409, code: 'conflict.stale' })).toMatchObject({
      key: 'certification.error.stale',
      then: 'reload',
    });
    expect(certificateProblemOf({ status: 404, code: 'certificate.not-found' })).toMatchObject({
      then: 'list',
    });
    expect(certificateProblemOf({ status: 418, code: 'teapot.new' }).key).toBe(
      'identity.error.unknown',
    );
    expect(
      certificateProblemOf({
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'expiryDate', code: 'before-issue-date' }] },
      }).fields,
    ).toEqual({ expiryDate: 'certification.form.error.before-issue-date' });
  });

  it('has a message for every key it can name', () => {
    const codes = [
      'type.inactive',
      'certificate.exists',
      'certificate.expired',
      'issuer.not-active',
      'seller.zone-missing',
      'draft-quota.exceeded',
      'document.limit-reached',
      'file.too-large',
      'file.unsupported-type',
      'file.encrypted',
      'file.active-content',
      'file.infected',
      'file.too-many-pages',
      'file.unreadable',
      'file.scan-unavailable',
      'type.no-issuer-registry',
      'issuer-request.already-open',
      'request.throttled',
      'access.acting-as-refused',
      'access.denied',
      'certificate.not-editable',
      'type.not-found',
    ];
    const lookup = (key: string): unknown =>
      key
        .split('.')
        .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], messages);
    for (const code of codes) {
      const { key } = certificateProblemOf({ status: 400, code });
      expect(typeof lookup(key), `${code} -> ${key}`).toBe('string');
    }
  });
});

describe('typeName and the zone line', () => {
  it('reads the Market name in the panel language, else the code', () => {
    expect(typeName({ 'en-AU': 'AU name', en: 'EN name' }, 'x', 'en-AU')).toBe('AU name');
    expect(typeName({ en: 'EN name' }, 'x', 'en-NZ')).toBe('EN name');
    expect(typeName({ ms: 'Nama' }, 'x', 'en-AU')).toBe('Nama');
    expect(typeName({}, 'code-only', 'en-AU')).toBe('code-only');
    expect(zonePlace('America/Los_Angeles')).toBe('Los Angeles');
  });
});

describe('CertificatesList', () => {
  const mount = (rows: CertificateSummary[], canManage = true, types = [docType, selfType]) =>
    render(
      wrap(
        <CertificatesList
          list={{ certificates: rows, nextAfterId: null }}
          options={{ types }}
          account="approved"
          canManage={canManage}
          zone="Australia/Brisbane"
          csrfToken="csrf"
        />,
      ),
    );

  it('shows the title and Add on one row, the account line, and an empty state', () => {
    mount([]);
    const heading = screen.getByRole('heading', { level: 1, name: 'Certificates' });
    expect(heading.closest('header')?.textContent).toContain('Add a certificate');
    expect(screen.getByTestId('seller-state').textContent).toContain(
      'Your seller account: Seller approved',
    );
    expect(screen.getByText("You haven't added a certificate yet.")).toBeTruthy();
  });

  it('lists a row with its status word, a dash for unknown issuer and validity, and Continue', () => {
    mount([summary()]);
    const table = screen.getByRole('table');
    const row = within(table).getAllByRole('row')[1]!;
    expect(within(row).getByRole('link', { name: 'Sample One' }).getAttribute('href')).toBe(
      `/settings/certificates/${A}`,
    );
    expect(row.textContent).toContain('Draft');
    expect(within(row).getAllByText('—')).toHaveLength(2);
    expect(within(row).getByRole('link', { name: 'Continue: Sample One' })).toBeTruthy();
    expect(row.textContent).toContain('20 Nov 2026');
  });

  it('shows the issuer and validity once the API sends them', () => {
    mount([
      summary({ status: 'approved', issuerName: 'Sample Certifier', validUntil: '2027-06-30' }),
    ]);
    const row = within(screen.getByRole('table')).getAllByRole('row')[1]!;
    expect(row.textContent).toContain('Sample Certifier');
    // A calendar day, shown as it is in the page's language (no zone conversion).
    const day = new Intl.DateTimeFormat('en-AU', { dateStyle: 'medium', timeZone: 'UTC' }).format(
      new Date('2027-06-30T00:00:00Z'),
    );
    expect(row.textContent).toContain(day);
  });

  it('is view only without the manage key: one banner, Add stays focusable and says why', () => {
    mount([], false);
    expect(screen.getByText('View only')).toBeTruthy();
    const add = screen.getByRole('button', { name: 'Add a certificate' });
    expect(add.getAttribute('aria-disabled')).toBe('true');
    const reason = add.getAttribute('aria-describedby');
    expect(reason && document.getElementById(reason)?.textContent).toContain(
      'You can view certificates but not change them. Ask your shop owner.',
    );
    fireEvent.click(add);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says so when no type is open, and Add does nothing', () => {
    mount([], true, []);
    const add = screen.getByRole('button', { name: 'Add a certificate' });
    expect(add.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText('No certificate types are open for new certificates.')).toBeTruthy();
  });

  it('starts a draft of the chosen type and opens its form', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 201, body: summary({ certificateId: C }) });
    mount([summary({ certificateId: B, typeCode: 'type-two', status: 'awaiting-review' })]);
    fireEvent.click(screen.getByRole('button', { name: 'Add a certificate' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a certificate' });
    // The type with an open certificate is not a choice; the dialog links to it instead.
    expect(within(dialog).queryByRole('radio', { name: /Sample Two/ })).toBeNull();
    expect(within(dialog).getByRole('link', { name: 'Open it' }).getAttribute('href')).toBe(
      `/settings/certificates/${B}`,
    );
    expect(dialog.textContent).toContain(
      'Issuer, certificate number, issue and expiry dates, a scan or photo of the certificate.',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/settings/certificates/${C}`));
    expect(call).toHaveBeenCalledWith(
      'POST',
      'certification/seller/certificates',
      { typeCode: 'type-one' },
      'csrf',
    );
  });

  it('shows a refusal in words and refreshes the list behind it', async () => {
    call.mockResolvedValueOnce({ ok: false, failure: { status: 409, code: 'certificate.exists' } });
    mount([]);
    fireEvent.click(screen.getByRole('button', { name: 'Add a certificate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(
      await screen.findByText('You already have a Sample One certificate. Open it.'),
    ).toBeTruthy();
    expect(router.refresh).toHaveBeenCalled();
  });
});

describe('CertificateForm', () => {
  const mount = (
    over: Partial<CertificateSummary> = {},
    type: CertificateTypeOption | undefined = docType,
    canManage = true,
  ) =>
    render(
      wrap(
        <CertificateForm
          detail={detail(over)}
          type={type}
          canManage={canManage}
          zone="Australia/Brisbane"
          csrfToken="csrf"
        />,
      ),
    );

  it('builds the whole draft for the type, a field it does not use as null', () => {
    const values = {
      issuerId: ISSUER,
      certificateNumber: ' HAL-1 ',
      issueDate: '2026-07-01',
      expiryDate: '2027-06-30',
      selfDeclared: true,
      selfDeclarationNote: 'note',
    };
    expect(draftBody(values, docType)).toEqual({
      issuerId: ISSUER,
      certificateNumber: 'HAL-1',
      issueDate: '2026-07-01',
      expiryDate: '2027-06-30',
      selfDeclared: null,
      selfDeclarationNote: null,
    });
    expect(draftBody(values, selfType)).toEqual({
      issuerId: null,
      certificateNumber: null,
      issueDate: null,
      expiryDate: null,
      selfDeclared: true,
      selfDeclarationNote: 'note',
    });
  });

  it('shows the details card, the zone line and Save draft in the bar', () => {
    mount();
    expect(screen.getByRole('heading', { level: 1, name: 'Sample One certificate' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Certificate details' })).toBeTruthy();
    expect(screen.getByLabelText('Issuer')).toBeTruthy();
    const number = screen.getByLabelText('Certificate number');
    expect(number.getAttribute('dir')).toBe('ltr');
    expect(number.getAttribute('autocomplete')).toBe('off');
    expect(number.getAttribute('maxlength')).toBe('64');
    expect(
      screen.getByText(/We'll measure the expiry in your work time zone: Brisbane time\./),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeTruthy();
    expect(screen.getAllByText('Delete draft').length).toBeGreaterThan(0);
  });

  it('saves the whole draft with a PUT and says Draft saved', async () => {
    call.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        certificate: summary({ lastChangedAt: '2026-11-27T00:00:00Z' }),
        draft: {
          issuerId: ISSUER,
          certificateNumber: 'HAL-1',
          issueDate: null,
          expiryDate: null,
          selfDeclared: null,
          selfDeclarationNote: null,
        },
        withdrawnSubmissionId: null,
      },
    });
    mount();
    fireEvent.change(screen.getByLabelText('Issuer'), { target: { value: ISSUER } });
    fireEvent.change(screen.getByLabelText('Certificate number'), { target: { value: 'HAL-1' } });
    expect(screen.getByText('Unsaved changes')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        'PUT',
        `certification/seller/certificates/${A}`,
        {
          issuerId: ISSUER,
          certificateNumber: 'HAL-1',
          issueDate: null,
          expiryDate: null,
          selfDeclared: null,
          selfDeclarationNote: null,
        },
        'csrf',
      ),
    );
    expect(await screen.findByText('Draft saved')).toBeTruthy();
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('puts field refusals in the summary and under the field', async () => {
    call.mockResolvedValueOnce({
      ok: false,
      failure: {
        status: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'expiryDate', code: 'before-issue-date' }] },
      },
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    const summaryBox = await screen.findByText('1 field needs fixing');
    expect(summaryBox).toBeTruthy();
    expect(
      screen.getAllByText('The expiry date must be after the issue date.').length,
    ).toBeGreaterThan(0);
  });

  it('reloads the record when it changed under the page', async () => {
    call.mockResolvedValueOnce({
      ok: false,
      failure: { status: 409, code: 'certificate.not-editable' },
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(
      await screen.findByText("This certificate has changed. We've loaded its latest state."),
    ).toBeTruthy();
    expect(router.refresh).toHaveBeenCalled();
  });

  it('deletes a never-submitted draft after the ask, with Cancel focused first', async () => {
    call.mockResolvedValueOnce({ ok: true, status: 200, body: { deleted: true } });
    mount();
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete draft' })[0]!);
    const dialog = screen.getByRole('dialog', { name: 'Delete this draft?' });
    expect(dialog.textContent).toContain(
      "The draft and its files are removed. This can't be undone.",
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete draft' }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/settings/certificates'));
    await expectToast('Draft deleted', 'success');
    expect(call).toHaveBeenCalledWith(
      'DELETE',
      `certification/seller/certificates/${A}`,
      undefined,
      'csrf',
    );
  });

  it('has no Delete draft once the certificate was submitted', () => {
    mount({ deletable: false, status: 'changes-needed' });
    expect(screen.queryByRole('button', { name: 'Delete draft' })).toBeNull();
    expect(
      screen.getByText('Changes were requested. Your earlier answers are filled in.'),
    ).toBeTruthy();
  });

  it('is read only while under review, and with view only', () => {
    mount({ status: 'awaiting-review', deletable: false });
    expect(screen.getByLabelText<HTMLInputElement>('Certificate number').disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    cleanup();
    mount({}, docType, false);
    expect(screen.getByText('View only')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Certificate number').disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
  });

  it("shows a self declaration as a seller's claim, with a tick and a note", () => {
    mount({ typeCode: 'type-two' }, selfType);
    expect(screen.getByText("This will show as a seller's claim, not a certificate.")).toBeTruthy();
    expect(screen.queryByLabelText('Issuer')).toBeNull();
    expect(screen.queryByLabelText('Certificate number')).toBeNull();
    expect(screen.getByLabelText('Note (optional)').getAttribute('dir')).toBe('auto');
  });

  it('names no type, Market or file limit of its own', () => {
    mount();
    const text = document.body.textContent ?? '';
    for (const word of ['Halal', 'halal', 'AU', 'Australia', '10 MiB', 'MB']) {
      expect(text).not.toContain(word);
    }
  });
});
