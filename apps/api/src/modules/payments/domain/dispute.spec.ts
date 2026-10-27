import { Temporal } from '@mondapac/shared-kernel';
import {
  disputeStateChanged,
  isInquiry,
  mergeDisputeState,
  outcomeOf,
  reasonOf,
  type ReadDisputeState,
} from './dispute';

// The pure dispute rules: inquiry and outcome from Stripe's status, unknown reasons kept as
// `other`, and a merge in which money flags, their instants and a closed outcome never go back.

const T1 = Temporal.Instant.from('2026-10-27T10:00:00Z');
const T2 = Temporal.Instant.from('2026-10-28T10:00:00Z');

const read = (fields: Partial<ReadDisputeState> = {}): ReadDisputeState => ({
  status: 'needs_response',
  reason: 'fraudulent',
  evidenceDueBy: null,
  fundsWithdrawn: false,
  fundsReinstated: false,
  ...fields,
});

describe('dispute rules', () => {
  it('tells an inquiry from a chargeback and sets an outcome only when won or lost', () => {
    expect(isInquiry('warning_needs_response')).toBe(true);
    expect(isInquiry('warning_closed')).toBe(true);
    expect(isInquiry('needs_response')).toBe(false);
    expect(outcomeOf('won')).toBe('won');
    expect(outcomeOf('lost')).toBe('lost');
    expect(outcomeOf('warning_closed')).toBeNull();
    expect(outcomeOf('prevented')).toBeNull();
  });

  it('keeps a known reason and stores any other as other', () => {
    expect(reasonOf('product_not_received')).toBe('product_not_received');
    expect(reasonOf('something_new')).toBe('other');
    expect(reasonOf('')).toBe('other');
  });

  it('stamps a money flag with the first read that saw it, and never clears it', () => {
    const first = mergeDisputeState(null, read({ fundsWithdrawn: true }), T1);
    expect(first).toMatchObject({ fundsWithdrawn: true, fundsWithdrawnAt: T1 });

    const later = mergeDisputeState(first, read({ fundsWithdrawn: false }), T2);
    expect(later).toMatchObject({ fundsWithdrawn: true, fundsWithdrawnAt: T1 });
    expect(disputeStateChanged(first, later)).toBe(false);
  });

  it('a reinstatement implies the withdrawal', () => {
    expect(mergeDisputeState(null, read({ fundsReinstated: true }), T1)).toMatchObject({
      fundsWithdrawn: true,
      fundsWithdrawnAt: T1,
      fundsReinstated: true,
      fundsReinstatedAt: T1,
    });
  });

  it('a closed dispute keeps its status and outcome against any later read', () => {
    const lost = mergeDisputeState(null, read({ status: 'lost', fundsWithdrawn: true }), T1);
    expect(lost).toMatchObject({ status: 'lost', outcome: 'lost' });
    const after = mergeDisputeState(lost, read({ status: 'won' }), T2);
    expect(after).toMatchObject({ status: 'lost', outcome: 'lost' });
  });

  it('sees a change of the deadline, the status or the reason', () => {
    const base = mergeDisputeState(null, read(), T1);
    expect(
      disputeStateChanged(base, mergeDisputeState(base, read({ evidenceDueBy: T2 }), T2)),
    ).toBe(true);
    expect(
      disputeStateChanged(base, mergeDisputeState(base, read({ status: 'under_review' }), T2)),
    ).toBe(true);
    expect(
      disputeStateChanged(base, mergeDisputeState(base, read({ reason: 'general' }), T2)),
    ).toBe(true);
    expect(disputeStateChanged(base, mergeDisputeState(base, read(), T2))).toBe(false);
  });
});
