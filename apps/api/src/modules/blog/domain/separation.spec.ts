import { approvalDecision } from './separation';

const parties = { approver: 'a', createdBy: 'b', submittedBy: 'c' };

describe('separation of duties', () => {
  it('allows an approver who neither wrote nor sent the version', () => {
    expect(approvalDecision(parties, false)).toEqual({ kind: 'allowed', selfApproved: false });
    expect(approvalDecision(parties, true)).toEqual({ kind: 'allowed', selfApproved: false });
  });

  it.each([
    ['the writer', { ...parties, approver: 'b' }],
    ['the submitter', { ...parties, approver: 'c' }],
  ])('denies %s when the Market does not allow self-approval', (_name, who) => {
    expect(approvalDecision(who, false)).toEqual({ kind: 'denied' });
  });

  it('asks for a step-up when the Market allows self-approval', () => {
    expect(approvalDecision({ ...parties, approver: 'c' }, true)).toEqual({
      kind: 'step-up',
      selfApproved: true,
    });
  });

  it('treats a version with no submitter as unsent: only the writer is involved', () => {
    expect(approvalDecision({ approver: 'a', createdBy: 'b', submittedBy: null }, false).kind).toBe(
      'allowed',
    );
  });
});
