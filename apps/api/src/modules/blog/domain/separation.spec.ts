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
  type State = 'draft' | 'in_review' | 'returned' | 'approved' | 'live' | 'retired';
  const v = (
    versionNo: number,
    createdBy: string,
    state: State,
    extra: { editedByReviewer?: boolean; decision?: string | null; published?: boolean } = {},
  ) => ({
    versionNo,
    createdBy,
    state,
    editedByReviewer: extra.editedByReviewer ?? false,
    decision:
      extra.decision !== undefined
        ? extra.decision
        : state === 'approved' || state === 'live'
          ? 'approved'
          : state === 'returned'
            ? 'changes_requested'
            : null,
    publishedAt: (extra.published ?? state === 'live') ? 'at' : null,
  });

  it('is the writer alone for a new draft after a live version', () => {
    expect(
      writersOf(
        [v(1, 'a', 'retired', { decision: 'approved', published: true }), v(2, 'b', 'draft')],
        2,
      ),
    ).toEqual(['b']);
  });

  it('is the writer alone for a new draft after a returned version', () => {
    expect(writersOf([v(1, 'a', 'returned'), v(2, 'b', 'in_review')], 2)).toEqual(['b']);
  });

  it('walks back through reviewer edits to the author of the edited version', () => {
    expect(
      writersOf(
        [
          v(1, 'x', 'live'),
          v(2, 'a', 'retired'),
          v(3, 'r', 'retired', { editedByReviewer: true }),
          v(4, 's', 'in_review', { editedByReviewer: true }),
        ],
        4,
      ),
    ).toEqual(['s', 'r', 'a']);
  });

  it('walks back through drafts another writer replaced', () => {
    expect(
      writersOf([v(1, 'a', 'retired'), v(2, 'b', 'retired'), v(3, 'a', 'in_review')], 3),
    ).toEqual(['a', 'b']);
  });

  it('keeps every writer of the round across replaced drafts and reviewer edits', () => {
    expect(
      writersOf(
        [
          v(1, 'old', 'retired', { decision: 'approved', published: true }),
          v(2, 'a', 'retired'),
          v(3, 'b', 'retired'),
          v(4, 'r', 'in_review', { editedByReviewer: true }),
        ],
        4,
      ),
    ).toEqual(['r', 'b', 'a']);
  });

  it('stops at a version that carries a decision, even when the current one is a reviewer edit', () => {
    expect(
      writersOf(
        [
          v(1, 'a', 'retired', { decision: 'changes_requested' }),
          v(2, 'r', 'in_review', { editedByReviewer: true }),
        ],
        2,
      ),
    ).toEqual(['r']);
  });

  it('stops at the first version', () => {
    expect(writersOf([v(1, 'a', 'in_review', { editedByReviewer: true })], 1)).toEqual(['a']);
  });
});
