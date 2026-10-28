import { approvalDecision, writersOf } from './separation';

const parties = { approver: 'a', writers: ['b'], submittedBy: 'c' };

describe('separation of duties', () => {
  it('allows an approver who neither wrote nor sent the version', () => {
    expect(approvalDecision(parties, false)).toEqual({ kind: 'allowed', selfApproved: false });
    expect(approvalDecision(parties, true)).toEqual({ kind: 'allowed', selfApproved: false });
  });

  it.each([
    ['the writer', { ...parties, approver: 'b' }],
    ['the submitter', { ...parties, approver: 'c' }],
    [
      'an earlier writer of a reviewer-edited version',
      { ...parties, writers: ['r', 'b'], approver: 'b' },
    ],
  ])('denies %s when the Market does not allow self-approval', (_name, who) => {
    expect(approvalDecision(who, false)).toEqual({ kind: 'denied' });
  });

  it('asks for a step-up when the Market allows self-approval', () => {
    expect(approvalDecision({ ...parties, approver: 'c' }, true)).toEqual({
      kind: 'step-up',
      selfApproved: true,
    });
  });

  it('treats a version with no submitter as unsent: only the writers are involved', () => {
    expect(approvalDecision({ approver: 'a', writers: ['b'], submittedBy: null }, false).kind).toBe(
      'allowed',
    );
  });
});

describe('writersOf', () => {
  const v = (versionNo: number, createdBy: string, editedByReviewer = false) => ({
    versionNo,
    createdBy,
    editedByReviewer,
  });

  it('is the writer alone for a version that is not a reviewer edit', () => {
    expect(writersOf([v(1, 'a'), v(2, 'b')], 2)).toEqual(['b']);
  });

  it('walks back through reviewer edits to the author of the edited version', () => {
    expect(writersOf([v(1, 'x'), v(2, 'a'), v(3, 'r', true), v(4, 's', true)], 4)).toEqual([
      's',
      'r',
      'a',
    ]);
  });

  it('stops at the first version when every version is an edit', () => {
    expect(writersOf([v(1, 'a', true)], 1)).toEqual(['a']);
  });
});
