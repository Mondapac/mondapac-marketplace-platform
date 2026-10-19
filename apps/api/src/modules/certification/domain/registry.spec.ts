import {
  accreditationNumberIn,
  changeReasonIn,
  closeProposal,
  deactivateType,
  expertApprovalIn,
  issuerNameIn,
  issuerNameKey,
  MAX_CHANGE_REASON_LENGTH,
  reactivateType,
  requestTypeReactivation,
  type ProposalRecord,
} from './registry';

// The registry rules of certification slice 12 (design 3.5, 3.6, 3.7, 7.6; H1): issuer fields,
// the optional change reason, type deactivation and reactivation, and the closing of a pending
// relaxation proposal (approve by a second admin, reject by another admin, withdraw by its
// proposer). Pure: no Market, no clock.

const A = '01990000-0000-7000-8000-00000000a001';
const B = '01990000-0000-7000-8000-00000000a002';

const pending = (overrides: Partial<ProposalRecord> = {}): ProposalRecord => ({
  state: 'pending',
  proposerAccountId: A,
  ...overrides,
});
const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? null : r.error!.code);

describe('issuer fields', () => {
  it('keys a display name by NFKC, case and inner whitespace, so look-alike entries collide', () => {
    expect(issuerNameKey('  Halal   Authority ')).toBe('halal authority');
    expect(issuerNameKey('ＨＡＬＡＬ Authority')).toBe(issuerNameKey('halal authority'));
    expect(issuerNameKey('Halal Authority')).toBe('halal authority');
    expect(issuerNameKey('Halal Authority')).not.toBe(issuerNameKey('Halal Authority 2'));
  });

  it('accepts a trimmed one-line name of 1 to 200 characters, nothing hidden', () => {
    expect(issuerNameIn(' Halal Authority ')).toEqual({ ok: true, value: 'Halal Authority' });
    expect(issuerNameIn('').ok).toBe(false);
    expect(issuerNameIn(undefined)).toEqual({ ok: false, code: 'required' });
    expect(issuerNameIn(12)).toEqual({ ok: false, code: 'type' });
    expect(issuerNameIn('a'.repeat(201))).toEqual({ ok: false, code: 'too-long' });
    expect(issuerNameIn('Halal\nAuthority')).toEqual({ ok: false, code: 'invalid-character' });
    expect(issuerNameIn('Halal‮Authority')).toEqual({ ok: false, code: 'invalid-character' });
    expect(issuerNameIn('<b>x</b>')).toEqual({ ok: false, code: 'invalid-character' });
  });

  it('takes an optional accreditation number of at most 64 characters', () => {
    expect(accreditationNumberIn(undefined)).toEqual({ ok: true, value: null });
    expect(accreditationNumberIn(null)).toEqual({ ok: true, value: null });
    expect(accreditationNumberIn(' ACC-1 ')).toEqual({ ok: true, value: 'ACC-1' });
    expect(accreditationNumberIn('x'.repeat(65))).toEqual({ ok: false, code: 'too-long' });
    expect(accreditationNumberIn('a\tb')).toEqual({ ok: false, code: 'invalid-character' });
  });

  it('needs both parts of an expert approval, each bounded plain text', () => {
    expect(expertApprovalIn({ confirmedBy: ' Expert ', reference: ' DOC-1 ' })).toEqual({
      ok: true,
      value: { confirmedBy: 'Expert', reference: 'DOC-1' },
    });
    expect(expertApprovalIn(undefined)).toEqual({ ok: false, path: '', code: 'required' });
    expect(expertApprovalIn('x')).toEqual({ ok: false, path: '', code: 'type' });
    expect(expertApprovalIn({ confirmedBy: '', reference: 'DOC' })).toEqual({
      ok: false,
      path: 'confirmedBy',
      code: 'required',
    });
    expect(expertApprovalIn({ confirmedBy: 'E', reference: 'r'.repeat(301) })).toEqual({
      ok: false,
      path: 'reference',
      code: 'too-long',
    });
    expect(expertApprovalIn({ confirmedBy: 'E', reference: 'R', extra: 1 })).toEqual({
      ok: false,
      path: 'extra',
      code: 'unknown-field',
    });
  });
});

describe('change reason (design 3.7, Q-C9)', () => {
  it('is optional plain text of at most 500 characters; newlines allowed, hidden ones not', () => {
    expect(changeReasonIn(undefined)).toEqual({ ok: true, value: null });
    expect(changeReasonIn('   ')).toEqual({ ok: true, value: null });
    expect(changeReasonIn(' Tightened after review.\nSee minutes. ')).toEqual({
      ok: true,
      value: 'Tightened after review.\nSee minutes.',
    });
    expect(changeReasonIn('r'.repeat(MAX_CHANGE_REASON_LENGTH)).ok).toBe(true);
    expect(changeReasonIn('r'.repeat(MAX_CHANGE_REASON_LENGTH + 1))).toEqual({
      ok: false,
      code: 'too-long',
    });
    expect(changeReasonIn('a⁦b')).toEqual({ ok: false, code: 'invalid-character' });
    expect(changeReasonIn(5)).toEqual({ ok: false, code: 'type' });
  });
});

describe('type status (design 3.6; CERT-03)', () => {
  it('deactivates an active type at once and refuses an inactive one', () => {
    expect(deactivateType('active')).toEqual({ ok: true, value: 'inactive' });
    expect(code(deactivateType('inactive'))).toBe('type.already-inactive');
  });

  it('reactivates only through a proposal approved by a second admin (H1)', () => {
    expect(code(requestTypeReactivation('active'))).toBe('type.already-active');
    expect(requestTypeReactivation('inactive')).toEqual({ ok: true, value: true });
    expect(code(reactivateType('active', pending(), B))).toBe('type.already-active');
    expect(code(reactivateType('inactive', pending(), A))).toBe('review.second-admin-required');
    expect(code(reactivateType('inactive', pending({ state: 'withdrawn' }), B))).toBe(
      'review.proposal-closed',
    );
    expect(reactivateType('inactive', pending(), B)).toEqual({ ok: true, value: 'active' });
  });
});

describe('closing a pending proposal (design 7.6; H1)', () => {
  it('approve: a second admin only; never the proposer, in any case or spacing', () => {
    expect(closeProposal(pending(), 'approve', B)).toEqual({ ok: true, value: 'approved' });
    expect(code(closeProposal(pending(), 'approve', A))).toBe('review.second-admin-required');
    expect(code(closeProposal(pending(), 'approve', ` ${A.toUpperCase()} `))).toBe(
      'review.second-admin-required',
    );
    expect(code(closeProposal(pending(), 'approve', ''))).toBe('review.second-admin-required');
  });

  it('reject: another admin, never the proposer', () => {
    expect(closeProposal(pending(), 'reject', B)).toEqual({ ok: true, value: 'rejected' });
    expect(code(closeProposal(pending(), 'reject', A))).toBe('review.proposer-cannot-reject');
  });

  it('withdraw: the proposer only', () => {
    expect(closeProposal(pending(), 'withdraw', A)).toEqual({ ok: true, value: 'withdrawn' });
    expect(code(closeProposal(pending(), 'withdraw', B))).toBe('review.not-proposer');
  });

  it('a decided proposal is frozen for every action', () => {
    for (const state of ['approved', 'rejected', 'withdrawn', 'superseded'] as const) {
      for (const action of ['approve', 'reject', 'withdraw'] as const) {
        expect(code(closeProposal(pending({ state }), action, B))).toBe('review.proposal-closed');
      }
    }
  });
});
