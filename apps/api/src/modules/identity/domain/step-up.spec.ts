import { Temporal } from '@mondapac/shared-kernel';
import { IDENTITY_STEP_UP_ACTIONS } from '../contracts/step-up';
import { PRICING_STEP_UP_ACTIONS } from '../../pricing/contracts/step-up';
import { CATALOG_STEP_UP_ACTIONS } from '../../catalog/contracts/step-up';
import { SELLERS_STEP_UP_ACTIONS } from '../../sellers/contracts/step-up';
import { PAYMENTS_STEP_UP_ACTIONS } from '../../payments/contracts/step-up';
import { proofIsFresh, STEP_UP_ACTION_KEYS, stepUpRequired } from './step-up';

const T0 = Temporal.Instant.from('2026-10-16T10:00:00Z');

describe('stepUpRequired', () => {
  it('uses the shop rule, then the default, and never lets a locked action off', () => {
    const open = { defaultRequired: false, locked: false };
    const onByDefault = { defaultRequired: true, locked: false };
    const locked = { defaultRequired: true, locked: true };

    expect(stepUpRequired(open, undefined)).toBe(false);
    expect(stepUpRequired(open, true)).toBe(true);
    expect(stepUpRequired(onByDefault, undefined)).toBe(true);
    expect(stepUpRequired(onByDefault, false)).toBe(false);
    expect(stepUpRequired(locked, false)).toBe(true);
    expect(stepUpRequired(locked, undefined)).toBe(true);
  });
});

describe('proofIsFresh', () => {
  it('covers the five minutes after the code and nothing else', () => {
    expect(proofIsFresh(T0, T0, 5)).toBe(true);
    expect(proofIsFresh(T0, T0.add({ minutes: 4, seconds: 59 }), 5)).toBe(true);
    expect(proofIsFresh(T0, T0.add({ minutes: 5 }), 5)).toBe(false);
    expect(proofIsFresh(T0.add({ seconds: 1 }), T0, 5)).toBe(false);
  });
});

describe('the audit key list', () => {
  it('is sorted, without duplicates, and holds every action a module registers', () => {
    expect([...STEP_UP_ACTION_KEYS]).toEqual([...new Set(STEP_UP_ACTION_KEYS)].sort());
    const registered = [
      ...IDENTITY_STEP_UP_ACTIONS,
      ...PRICING_STEP_UP_ACTIONS,
      ...CATALOG_STEP_UP_ACTIONS,
      ...SELLERS_STEP_UP_ACTIONS,
      ...PAYMENTS_STEP_UP_ACTIONS,
    ].map((a) => a.key);

    for (const key of registered) expect(STEP_UP_ACTION_KEYS as readonly string[]).toContain(key);
  });

  it('keeps the floor of the proposal: payout account, second factor and role change are locked', () => {
    const locked = [...IDENTITY_STEP_UP_ACTIONS, ...PAYMENTS_STEP_UP_ACTIONS]
      .filter((a) => a.locked)
      .map((a) => a.key)
      .sort();

    expect(locked).toEqual([
      'identity.second-factor.manage',
      'identity.team.change-role',
      'payments.payout-account.change',
    ]);
  });
});
