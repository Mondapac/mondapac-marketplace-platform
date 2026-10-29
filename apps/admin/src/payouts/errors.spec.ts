import { describe, expect, it } from 'vitest';
import messages from '../../messages/en.json';
import { approveProblemOf, STALE_PROBLEMS } from './errors.ts';

const failure = (status: number, code: string) => ({ status, code });

describe('approveProblemOf', () => {
  it.each([
    [409, 'commission-payouts.payout.amount-changed', 'amount-changed'],
    [409, 'commission-payouts.payout.not-awaiting-approval', 'not-awaiting'],
    [404, 'commission-payouts.payout-not-found', 'not-found'],
    [403, 'access.denied', 'denied'],
    [403, 'request.csrf', 'session'],
    [429, 'request.throttled', 'throttled'],
    [400, 'validation.failed', 'unknown'],
    [503, 'access.unavailable', 'unavailable'],
    [0, 'network', 'unavailable'],
    [500, 'something.else', 'unknown'],
  ])('maps %i %s to %s, a message that exists', (status, code, key) => {
    const problem = approveProblemOf(failure(status, code));
    expect(problem).toBe(key);
    const errors = messages.payouts.approve.error as Record<string, string>;
    expect(typeof errors[problem]).toBe('string');
  });

  it('marks only the problems that leave the screen out of date as stale', () => {
    expect(STALE_PROBLEMS).toEqual(['amount-changed', 'not-awaiting', 'not-found']);
  });
});
