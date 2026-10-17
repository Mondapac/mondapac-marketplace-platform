import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  expiryBoundaryIn,
  draftEditVerdict,
  incompleteFields,
  isDraftEditable,
  parseDraftContent,
  sameDraftContent,
  sellerStatusOf,
  submissionContentOf,
  submissionKindFor,
  statusAfterWithdraw,
  type DraftContent,
  type SellerStatusInput,
  type TypeSettings,
} from './seller-certificate';
import { rateVerdict, windowRestartBefore, type RateLimit } from './rate-limits';

// The pure rules of the seller side of a certificate (certification design 2.4, 3.1 to 3.3, 7.5).

const ISSUER = '01990000-0000-7000-8000-00000000a001';
const NOW = Temporal.Instant.from('2026-10-16T00:00:00Z');

const thirdParty: TypeSettings = {
  typeId: 'type-1' as Id<'CertificationType'>,
  code: 'halal',
  status: 'active',
  revisionId: 'rev-1' as Id<'CertificationTypeRevision'>,
  verificationMode: 'THIRD_PARTY_DOCUMENT',
  requiresIssuerRegistry: true,
  requiresDocument: true,
  requiresExpiry: true,
};
const selfDeclaration: TypeSettings = {
  ...thirdParty,
  code: 'vegan',
  verificationMode: 'SELF_DECLARATION',
  requiresIssuerRegistry: false,
  requiresDocument: false,
  requiresExpiry: false,
};

const emptyDraft: DraftContent = {
  issuerId: null,
  certificateNumber: null,
  issueDate: null,
  expiryDate: null,
  selfDeclared: null,
  selfDeclarationNote: null,
};

const body = (overrides: Record<string, unknown> = {}) => ({
  issuerId: null,
  certificateNumber: null,
  issueDate: null,
  expiryDate: null,
  selfDeclared: null,
  selfDeclarationNote: null,
  ...overrides,
});

describe('parseDraftContent', () => {
  it('reads a full draft, trimming text and parsing local dates', () => {
    const result = parseDraftContent(
      body({
        issuerId: ISSUER,
        certificateNumber: '  HC-123 ',
        issueDate: '2026-01-31',
        expiryDate: '2027-01-31',
        selfDeclared: true,
        selfDeclarationNote: 'ours',
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.certificateNumber).toBe('HC-123');
    expect(result.value.issueDate?.toString()).toBe('2026-01-31');
    expect(result.value.expiryDate?.toString()).toBe('2027-01-31');
  });

  it('treats an empty text as cleared', () => {
    const result = parseDraftContent(body({ certificateNumber: '   ' }));
    expect(result).toMatchObject({ ok: true, value: { certificateNumber: null } });
  });

  it.each([
    ['a date that does not exist', { issueDate: '2026-02-30' }, 'issueDate', 'format'],
    ['a date with a time', { expiryDate: '2026-02-03T00:00:00Z' }, 'expiryDate', 'format'],
    ['a year out of range', { expiryDate: '1800-01-01' }, 'expiryDate', 'format'],
    ['an issuer that is not an id', { issuerId: 'abc' }, 'issuerId', 'format'],
    ['a tick that is not a boolean', { selfDeclared: 'yes' }, 'selfDeclared', 'type'],
    ['a number that is not text', { certificateNumber: 12 }, 'certificateNumber', 'type'],
    [
      'a number over 64 characters',
      { certificateNumber: 'x'.repeat(65) },
      'certificateNumber',
      'too-long',
    ],
    [
      'a note over 1000 characters',
      { selfDeclarationNote: 'x'.repeat(1001) },
      'selfDeclarationNote',
      'too-long',
    ],
    [
      'an expiry before the issue date',
      { issueDate: '2026-05-01', expiryDate: '2026-04-30' },
      'expiryDate',
      'before-issue-date',
    ],
  ])('refuses %s', (_label, overrides, path, code) => {
    const result = parseDraftContent(body(overrides));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContainEqual({ path, code });
  });

  it('refuses a body that is not an object', () => {
    expect(parseDraftContent(null).ok).toBe(false);
    expect(parseDraftContent([]).ok).toBe(false);
    expect(parseDraftContent('x').ok).toBe(false);
  });
});

describe('editing and submission kind', () => {
  it('allows an edit unless a submission is pending or the record is closed', () => {
    expect(isDraftEditable('draft', null)).toBe(true);
    expect(isDraftEditable('changes-needed', null)).toBe(true);
    expect(isDraftEditable('approved', null)).toBe(true);
    expect(isDraftEditable('expired', null)).toBe(true);
    expect(isDraftEditable('approved', 'pending')).toBe(false);
    expect(isDraftEditable('in-review', null)).toBe(false);
    expect(isDraftEditable('declined', null)).toBe(false);
    expect(isDraftEditable('revoked', null)).toBe(false);
  });

  it('names the kind of the next submission and refuses the rest', () => {
    expect(submissionKindFor('draft', null)).toBe('initial');
    expect(submissionKindFor('changes-needed', null)).toBe('resubmission');
    expect(submissionKindFor('approved', null)).toBe('renewal');
    expect(submissionKindFor('expired', null)).toBe('renewal');
    expect(submissionKindFor('draft', 'pending')).toBeNull();
    expect(submissionKindFor('in-review', null)).toBeNull();
    expect(submissionKindFor('declined', null)).toBeNull();
    expect(submissionKindFor('revoked', null)).toBeNull();
  });
});

describe('withdraw by edit (design 3.2 row 2, slice 8)', () => {
  it('edits an open record, asks first while a submission is pending, then withdraws it', () => {
    expect(draftEditVerdict('draft', null, false)).toBe('edit');
    expect(draftEditVerdict('approved', null, true)).toBe('edit');
    expect(draftEditVerdict('in-review', 'pending', false)).toBe('confirm-withdraw');
    expect(draftEditVerdict('approved', 'pending', false)).toBe('confirm-withdraw');
    expect(draftEditVerdict('expired', 'pending', false)).toBe('confirm-withdraw');
    expect(draftEditVerdict('in-review', 'pending', true)).toBe('withdraw-then-edit');
    expect(draftEditVerdict('approved', 'pending', true)).toBe('withdraw-then-edit');
    expect(draftEditVerdict('expired', 'pending', true)).toBe('withdraw-then-edit');
  });

  it('never edits a closed record, whatever the seller confirms', () => {
    for (const confirmed of [false, true]) {
      expect(draftEditVerdict('declined', null, confirmed)).toBe('closed');
      expect(draftEditVerdict('revoked', null, confirmed)).toBe('closed');
      expect(draftEditVerdict('revoked', 'pending', confirmed)).toBe('closed');
      expect(draftEditVerdict('in-review', null, confirmed)).toBe('closed');
      expect(draftEditVerdict('draft', 'pending', confirmed)).toBe('closed');
    }
  });

  it('takes a never-approved record back to draft and keeps an approved or expired one', () => {
    expect(statusAfterWithdraw('in-review', false)).toBe('draft');
    expect(statusAfterWithdraw('approved', true)).toBe('approved');
    expect(statusAfterWithdraw('expired', true)).toBe('expired');
  });

  it('never leaves a record with an approval in-review after a withdrawal (I2)', () => {
    expect(statusAfterWithdraw('in-review', true)).toBe('approved');
    for (const status of ['approved', 'expired', 'in-review'] as const) {
      expect(statusAfterWithdraw(status, true)).not.toBe('in-review');
    }
  });

  it('compares every field of two drafts', () => {
    const base: DraftContent = {
      issuerId: ISSUER as Id<'Issuer'>,
      certificateNumber: 'HC-1',
      issueDate: Temporal.PlainDate.from('2026-01-01'),
      expiryDate: Temporal.PlainDate.from('2027-01-01'),
      selfDeclared: null,
      selfDeclarationNote: null,
    };
    expect(sameDraftContent(base, { ...base })).toBe(true);
    expect(sameDraftContent(base, { ...base, certificateNumber: 'HC-2' })).toBe(false);
    expect(sameDraftContent(base, { ...base, issuerId: null })).toBe(false);
    expect(
      sameDraftContent(base, { ...base, expiryDate: Temporal.PlainDate.from('2027-01-02') }),
    ).toBe(false);
    expect(sameDraftContent(base, { ...base, issueDate: null })).toBe(false);
    expect(sameDraftContent(base, { ...base, selfDeclared: false })).toBe(false);
    expect(sameDraftContent(base, { ...base, selfDeclarationNote: 'x' })).toBe(false);
  });
});

describe('incompleteFields', () => {
  it('asks a third-party type for issuer, number, expiry and a file', () => {
    expect(incompleteFields(thirdParty, emptyDraft, 0).map((f) => f.path)).toEqual([
      'issuerId',
      'certificateNumber',
      'expiryDate',
      'documents',
    ]);
  });

  it('passes a complete third-party draft', () => {
    const draft: DraftContent = {
      ...emptyDraft,
      issuerId: ISSUER as Id<'Issuer'>,
      certificateNumber: 'N-1',
      expiryDate: Temporal.PlainDate.from('2027-01-01'),
    };
    expect(incompleteFields(thirdParty, draft, 1)).toEqual([]);
  });

  it('asks a self-declaration for the tick only', () => {
    expect(incompleteFields(selfDeclaration, emptyDraft, 0)).toEqual([
      { path: 'selfDeclared', code: 'required' },
    ]);
    expect(incompleteFields(selfDeclaration, { ...emptyDraft, selfDeclared: false }, 0)).toEqual([
      { path: 'selfDeclared', code: 'required' },
    ]);
    expect(incompleteFields(selfDeclaration, { ...emptyDraft, selfDeclared: true }, 0)).toEqual([]);
  });
});

describe('submissionContentOf', () => {
  const full: DraftContent = {
    issuerId: ISSUER as Id<'Issuer'>,
    certificateNumber: 'N-1',
    issueDate: Temporal.PlainDate.from('2026-01-01'),
    expiryDate: Temporal.PlainDate.from('2027-01-01'),
    selfDeclared: true,
    selfDeclarationNote: 'note',
  };

  it('keeps no issuer and no number for a self-declaration', () => {
    expect(submissionContentOf(selfDeclaration, full)).toMatchObject({
      issuerId: null,
      certificateNumber: null,
      expiryDate: null,
      selfDeclared: true,
      selfDeclarationNote: 'note',
    });
  });

  it('keeps no tick and no note for a third-party certificate', () => {
    expect(submissionContentOf(thirdParty, full)).toMatchObject({
      issuerId: ISSUER,
      certificateNumber: 'N-1',
      selfDeclared: null,
      selfDeclarationNote: null,
    });
  });
});

describe('expiryBoundaryIn', () => {
  it('is 00:00 on the day after the expiry date in the seller zone', () => {
    const date = Temporal.PlainDate.from('2026-12-31');
    expect(expiryBoundaryIn(date, 'Australia/Brisbane').toString()).toBe('2026-12-31T14:00:00Z');
    expect(expiryBoundaryIn(date, 'UTC').toString()).toBe('2027-01-01T00:00:00Z');
  });

  it('rejects a zone Temporal cannot resolve', () => {
    expect(() => expiryBoundaryIn(Temporal.PlainDate.from('2026-12-31'), 'Not/AZone')).toThrow();
  });
});

describe('sellerStatusOf', () => {
  const approved = (overrides: Partial<SellerStatusInput> = {}): SellerStatusInput => ({
    status: 'approved',
    pendingKind: null,
    approvedBoundaryAt: NOW.add({ hours: 24 * 90 }),
    hasApproval: true,
    approvedIssuerState: 'active',
    issuerRequestOpen: false,
    latestOutcome: 'approved',
    ...overrides,
  });

  it.each([
    ['draft', 'draft'],
    ['changes-needed', 'changes-needed'],
    ['declined', 'declined'],
    ['revoked', 'revoked'],
  ] as const)('shows %s as %s', (status, code) => {
    expect(
      sellerStatusOf({ ...approved(), status, hasApproval: false, approvedBoundaryAt: null }, NOW)
        .code,
    ).toBe(code);
  });

  it('shows a draft with an open issuer request as draft-issuer-not-listed, only while a draft', () => {
    const draft = { ...approved(), hasApproval: false, approvedBoundaryAt: null };
    expect(sellerStatusOf({ ...draft, status: 'draft', issuerRequestOpen: true }, NOW).code).toBe(
      'draft-issuer-not-listed',
    );
    expect(
      sellerStatusOf({ ...draft, status: 'changes-needed', issuerRequestOpen: true }, NOW).code,
    ).toBe('changes-needed');
    expect(sellerStatusOf({ ...approved(), issuerRequestOpen: true }, NOW).code).toBe('approved');
  });

  it('shows a first review as awaiting review', () => {
    expect(
      sellerStatusOf(
        {
          status: 'in-review',
          pendingKind: 'initial',
          approvedBoundaryAt: null,
          hasApproval: false,
          approvedIssuerState: null,
          issuerRequestOpen: false,
          latestOutcome: null,
        },
        NOW,
      ).code,
    ).toBe('awaiting-review');
  });

  it('shows approved, then approved-expiring in the last 30 days', () => {
    expect(sellerStatusOf(approved(), NOW).code).toBe('approved');
    const soon = approved({ approvedBoundaryAt: NOW.add({ hours: 24 * 29 }) });
    expect(sellerStatusOf(soon, NOW)).toEqual({
      code: 'approved-expiring',
      submitBy: soon.approvedBoundaryAt,
    });
  });

  it('shows a pending renewal on an approved record', () => {
    expect(sellerStatusOf(approved({ pendingKind: 'renewal' }), NOW).code).toBe(
      'approved-renewal-pending',
    );
  });

  it('shows a renewal sent back for changes while the approved one is valid, with its boundary', () => {
    const refused = approved({ latestOutcome: 'changes-requested' });
    expect(sellerStatusOf(refused, NOW)).toEqual({
      code: 'approved-renewal-changes-needed',
      submitBy: refused.approvedBoundaryAt,
    });
    // Also inside the warning window: the reason to act is the refused renewal.
    const soon = approved({
      latestOutcome: 'changes-requested',
      approvedBoundaryAt: NOW.add({ hours: 24 * 3 }),
    });
    expect(sellerStatusOf(soon, NOW).code).toBe('approved-renewal-changes-needed');
    // A correction sent again is a pending renewal; a declined or withdrawn one is plain approved.
    expect(
      sellerStatusOf(approved({ latestOutcome: 'changes-requested', pendingKind: 'renewal' }), NOW)
        .code,
    ).toBe('approved-renewal-pending');
    expect(sellerStatusOf(approved({ latestOutcome: 'withdrawn' }), NOW).code).toBe('approved');
    expect(sellerStatusOf(approved({ latestOutcome: 'declined' }), NOW).code).toBe('approved');
  });

  it('never shows a refused renewal as valid past the boundary or with a derecognised issuer', () => {
    const past = approved({
      latestOutcome: 'changes-requested',
      approvedBoundaryAt: NOW.subtract({ hours: 1 }),
    });
    expect(sellerStatusOf(past, NOW).code).toBe('expired');
    expect(
      sellerStatusOf(
        approved({ latestOutcome: 'changes-requested', approvedIssuerState: 'derecognised' }),
        NOW,
      ).code,
    ).toBe('issuer-not-recognised');
  });

  it('shows expired past the stored boundary whether or not the job ran', () => {
    const past = approved({ approvedBoundaryAt: NOW.subtract({ hours: 1 }) });
    expect(sellerStatusOf(past, NOW).code).toBe('expired');
    expect(sellerStatusOf({ ...past, pendingKind: 'renewal' }, NOW).code).toBe(
      'expired-renewal-pending',
    );
    expect(sellerStatusOf(approved({ status: 'expired' }), NOW).code).toBe('expired');
  });

  it('shows a derecognised issuer', () => {
    expect(sellerStatusOf(approved({ approvedIssuerState: 'derecognised' }), NOW).code).toBe(
      'issuer-not-recognised',
    );
  });
});

describe('rate limits', () => {
  const limit: RateLimit = { kind: 'save.account.minute', limit: 2, windowMinutes: 1 };

  it('allows up to the limit and refuses past it with a wait', () => {
    const at = (count: number) => [{ kind: limit.kind, count, windowStartedAt: NOW }];
    expect(rateVerdict([limit], at(2), NOW)).toEqual({ allowed: true });
    expect(rateVerdict([limit], at(3), NOW.add({ seconds: 20 }))).toEqual({
      allowed: false,
      retryAfterSeconds: 40,
    });
  });

  it('never passes a limit with no reservation', () => {
    expect(() => rateVerdict([limit], [], NOW)).toThrow();
  });

  it('restarts a window that began at or before now minus its length', () => {
    expect(windowRestartBefore(limit, NOW).toString()).toBe('2026-10-15T23:59:00Z');
  });
});
