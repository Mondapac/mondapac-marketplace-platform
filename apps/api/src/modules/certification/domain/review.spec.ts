import { Temporal } from '@mondapac/shared-kernel';
import {
  approvalRefusal,
  approvalBoundary,
  checkCodesFor,
  latestChecks,
  missingChecks,
  normaliseCertificateNumber,
  reasonFor,
  statusAfterDecision,
  submissionStatusOf,
  type ReviewPolicy,
} from './review';

// The pure rules of the admin review of a seller certificate (certification design 3.2, 5.1).

const POLICY: ReviewPolicy = {
  checks: [
    { code: 'holder-name', required: true, modes: ['THIRD_PARTY_DOCUMENT'] },
    { code: 'dates', required: true, modes: ['THIRD_PARTY_DOCUMENT'] },
    { code: 'issuer-enquiry', required: false, modes: ['THIRD_PARTY_DOCUMENT'] },
    { code: 'declaration-read', required: true, modes: ['SELF_DECLARATION'] },
  ],
  reasons: [
    {
      code: 'unreadable',
      check: 'dates',
      nextStep: 'upload-clearer-file',
      label: 'The file cannot be read.',
      outcomes: ['changes-requested'],
    },
    {
      code: 'not-genuine',
      check: null,
      nextStep: 'contact-support',
      label: 'The certificate could not be verified.',
      outcomes: ['declined'],
    },
  ],
  issuerRequestReasons: [],
};
const NOW = Temporal.Instant.from('2026-10-16T00:00:00Z');
const day = (text: string) => Temporal.PlainDate.from(text);

describe('review checks by verification mode', () => {
  it('lists the checks of a mode and marks the required ones', () => {
    expect(checkCodesFor(POLICY, 'THIRD_PARTY_DOCUMENT')).toEqual([
      { code: 'holder-name', required: true },
      { code: 'dates', required: true },
      { code: 'issuer-enquiry', required: false },
    ]);
    expect(checkCodesFor(POLICY, 'SELF_DECLARATION')).toEqual([
      { code: 'declaration-read', required: true },
    ]);
  });

  it('takes the latest row per code, so a re-recording replaces the earlier result', () => {
    const rows = [
      { code: 'dates', result: 'problem' as const, recordedAt: NOW },
      { code: 'dates', result: 'done' as const, recordedAt: NOW.add({ minutes: 1 }) },
      { code: 'holder-name', result: 'done' as const, recordedAt: NOW },
    ];
    expect([...latestChecks(rows)]).toEqual([
      ['dates', 'done'],
      ['holder-name', 'done'],
    ]);
    // The same instant: the later row in the list wins (insert order).
    expect(
      latestChecks([
        { code: 'dates', result: 'done' as const, recordedAt: NOW },
        { code: 'dates', result: 'problem' as const, recordedAt: NOW },
      ]).get('dates'),
    ).toBe('problem');
  });

  it('names the required checks that are not done or not applicable', () => {
    const latest = new Map([
      ['holder-name', 'done' as const],
      ['dates', 'problem' as const],
    ]);
    expect(missingChecks(POLICY, 'THIRD_PARTY_DOCUMENT', latest)).toEqual(['dates']);
    expect(missingChecks(POLICY, 'THIRD_PARTY_DOCUMENT', new Map())).toEqual([
      'holder-name',
      'dates',
    ]);
    expect(
      missingChecks(
        POLICY,
        'THIRD_PARTY_DOCUMENT',
        new Map([
          ['holder-name', 'not-applicable' as const],
          ['dates', 'done' as const],
        ]),
      ),
    ).toEqual([]);
  });
});

describe('reasons', () => {
  it('finds a reason only for the outcome it is listed under', () => {
    expect(reasonFor(POLICY, 'unreadable', 'changes-requested')?.nextStep).toBe(
      'upload-clearer-file',
    );
    expect(reasonFor(POLICY, 'unreadable', 'declined')).toBeNull();
    expect(reasonFor(POLICY, 'not-genuine', 'declined')?.code).toBe('not-genuine');
    expect(reasonFor(POLICY, 'unknown', 'declined')).toBeNull();
  });
});

describe('the approval boundary', () => {
  it('is the earlier of the boundaries in the two zones, with the zone that gave it', () => {
    const boundary = approvalBoundary(day('2026-12-31'), {
      zone: 'Australia/Brisbane',
      addressZone: 'Pacific/Auckland',
    });
    // 2027-01-01 00:00 in Auckland (UTC+13 in summer) is earlier than in Brisbane (UTC+10).
    expect(boundary.zone).toBe('Pacific/Auckland');
    expect(boundary.at?.toString()).toBe('2026-12-31T11:00:00Z');
  });

  it('has no instant without an expiry date and then keeps the chosen zone', () => {
    expect(
      approvalBoundary(null, { zone: 'Australia/Brisbane', addressZone: 'Pacific/Auckland' }),
    ).toEqual({ zone: 'Australia/Brisbane', at: null });
  });
});

describe('approval guards', () => {
  const ok = {
    mode: 'THIRD_PARTY_DOCUMENT' as const,
    policy: POLICY,
    latest: new Map([
      ['holder-name', 'done' as const],
      ['dates', 'done' as const],
    ]),
    hasScope: true,
    requiresIssuerRegistry: true,
    issuer: { state: 'active' as const, typeMatches: true },
    typeActive: true,
    hasApproval: false,
    boundary: NOW.add({ hours: 5 }),
    now: NOW,
    selfDeclared: null,
  };

  it('allows a complete third-party submission', () => {
    expect(approvalRefusal(ok)).toBeNull();
  });

  it('refuses while a required check is missing, and says which', () => {
    expect(approvalRefusal({ ...ok, latest: new Map([['holder-name', 'done' as const]]) })).toEqual(
      {
        code: 'review.checks-incomplete',
        checks: ['dates'],
      },
    );
  });

  it('refuses without the location and scope for a third-party type only', () => {
    expect(approvalRefusal({ ...ok, hasScope: false })).toEqual({ code: 'review.scope-missing' });
    expect(
      approvalRefusal({
        ...ok,
        mode: 'SELF_DECLARATION',
        latest: new Map([['declaration-read', 'done' as const]]),
        hasScope: false,
        requiresIssuerRegistry: false,
        issuer: null,
        selfDeclared: true,
      }),
    ).toBeNull();
  });

  it('refuses an issuer that is not active, or of another type', () => {
    for (const state of ['proposed', 'closed-to-new', 'derecognised'] as const) {
      expect(approvalRefusal({ ...ok, issuer: { state, typeMatches: true } })).toEqual({
        code: 'issuer.not-active',
      });
    }
    expect(approvalRefusal({ ...ok, issuer: { state: 'active', typeMatches: false } })).toEqual({
      code: 'issuer.not-active',
    });
    expect(approvalRefusal({ ...ok, issuer: null })).toEqual({ code: 'issuer.not-active' });
  });

  it('adds no new certificate of an inactive type; a renewal of an approved one goes on (AC 19, CERT-03)', () => {
    expect(approvalRefusal({ ...ok, typeActive: false })).toEqual({ code: 'type.inactive' });
    expect(approvalRefusal({ ...ok, typeActive: false, hasApproval: true })).toBeNull();
  });

  it('refuses a boundary that is not after now', () => {
    expect(approvalRefusal({ ...ok, boundary: NOW })).toEqual({ code: 'certificate.expired' });
    expect(approvalRefusal({ ...ok, boundary: NOW.subtract({ hours: 24 }) })).toEqual({
      code: 'certificate.expired',
    });
    expect(approvalRefusal({ ...ok, boundary: null })).toBeNull();
  });

  it('refuses a self-declaration without the seller tick', () => {
    expect(
      approvalRefusal({
        ...ok,
        mode: 'SELF_DECLARATION',
        latest: new Map([['declaration-read', 'done' as const]]),
        requiresIssuerRegistry: false,
        issuer: null,
        selfDeclared: false,
      }),
    ).toEqual({ code: 'certificate.incomplete' });
  });
});

describe('status after a decision', () => {
  it('moves a first review to approved, changes-needed or declined', () => {
    expect(statusAfterDecision('in-review', false, 'approved')).toBe('approved');
    expect(statusAfterDecision('in-review', false, 'changes-requested')).toBe('changes-needed');
    expect(statusAfterDecision('in-review', false, 'declined')).toBe('declined');
  });

  it('keeps an approved or expired record on a refused renewal, and approves a renewal', () => {
    expect(statusAfterDecision('approved', true, 'changes-requested')).toBe('approved');
    expect(statusAfterDecision('expired', true, 'declined')).toBe('expired');
    expect(statusAfterDecision('expired', true, 'approved')).toBe('approved');
    expect(statusAfterDecision('approved', true, 'approved')).toBe('approved');
  });
});

describe('the normalised certificate number', () => {
  it('folds case, width, spaces and punctuation, so the same number matches', () => {
    expect(normaliseCertificateNumber(' hc-123 / 456 ')).toBe('HC123456');
    expect(normaliseCertificateNumber('ＨＣ１２３')).toBe('HC123');
    expect(normaliseCertificateNumber('hc.123')).toBe(normaliseCertificateNumber('HC 123'));
  });
});

describe('the status of a submission (design 3.2)', () => {
  it('reads pending from the pointer, superseded from an approval that is no longer current', () => {
    expect(submissionStatusOf({ outcome: null, pending: true, current: false })).toBe('pending');
    expect(submissionStatusOf({ outcome: 'approved', pending: false, current: true })).toBe(
      'approved',
    );
    expect(submissionStatusOf({ outcome: 'approved', pending: false, current: false })).toBe(
      'superseded',
    );
    for (const outcome of ['changes-requested', 'declined', 'withdrawn'] as const) {
      expect(submissionStatusOf({ outcome, pending: false, current: false })).toBe(outcome);
    }
  });

  it('shows a submission with no decision as pending even when no pointer names it (L1)', () => {
    expect(submissionStatusOf({ outcome: null, pending: false, current: false })).toBe('pending');
    expect(submissionStatusOf({ outcome: null, pending: false, current: true })).toBe('pending');
  });
});
