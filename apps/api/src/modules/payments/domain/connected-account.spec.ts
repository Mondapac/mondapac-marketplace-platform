import { isReady, statusOf, type AccountSnapshot } from './connected-account';

const snapshot = (fields: Partial<AccountSnapshot> = {}): AccountSnapshot => ({
  id: 'acct_test_0001',
  metadataMarketId: 'AU',
  metadataSellerId: 'seller',
  detailsSubmitted: false,
  transfersActive: false,
  payoutsEnabled: false,
  requirementsDue: 0,
  requirementsPastDue: false,
  disabledReason: null,
  payoutScheduleInterval: 'daily',
  externalAccountCount: 1,
  ...fields,
});

describe('statusOf', () => {
  it('is not-started until the details are submitted, then pending', () => {
    expect(statusOf(snapshot(), 'not-started')).toBe('not-started');
    expect(statusOf(snapshot({ detailsSubmitted: true }), 'not-started')).toBe('pending');
  });

  it('is enabled only with transfers active, payouts enabled and nothing past due', () => {
    const live = { detailsSubmitted: true, transfersActive: true, payoutsEnabled: true };
    expect(statusOf(snapshot(live), 'pending')).toBe('enabled');
    expect(statusOf(snapshot({ ...live, requirementsPastDue: true }), 'pending')).toBe('pending');
    expect(statusOf(snapshot({ ...live, payoutsEnabled: false }), 'pending')).toBe('pending');
    expect(statusOf(snapshot({ ...live, transfersActive: false }), 'pending')).toBe('pending');
  });

  it('is never enabled while Stripe gives a disabled reason', () => {
    const live = { detailsSubmitted: true, transfersActive: true, payoutsEnabled: true };
    expect(statusOf(snapshot({ ...live, disabledReason: 'under_review' }), 'pending')).toBe(
      'pending',
    );
    expect(statusOf(snapshot({ ...live, disabledReason: 'under_review' }), 'enabled')).toBe(
      'restricted',
    );
  });

  it('turns an enabled account that no longer qualifies into restricted, and back', () => {
    const live = { detailsSubmitted: true, transfersActive: true, payoutsEnabled: true };
    expect(statusOf(snapshot({ ...live, requirementsPastDue: true }), 'enabled')).toBe(
      'restricted',
    );
    expect(statusOf(snapshot({ ...live, requirementsPastDue: true }), 'restricted')).toBe(
      'restricted',
    );
    expect(statusOf(snapshot(live), 'restricted')).toBe('enabled');
  });

  it('keeps a rejection final', () => {
    const rejected = snapshot({ disabledReason: 'rejected.fraud' });
    expect(statusOf(rejected, 'pending')).toBe('rejected');
    const live = { detailsSubmitted: true, transfersActive: true, payoutsEnabled: true };
    expect(statusOf(snapshot(live), 'rejected')).toBe('rejected');
  });

  it('is ready only when enabled', () => {
    expect(
      ['not-started', 'pending', 'enabled', 'restricted', 'rejected'].map((s) =>
        isReady(s as Parameters<typeof isReady>[0]),
      ),
    ).toEqual([false, false, true, false, false]);
  });
});
