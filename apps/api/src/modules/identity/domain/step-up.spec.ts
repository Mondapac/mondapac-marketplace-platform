import { Temporal } from '@mondapac/shared-kernel';
import { IDENTITY_STEP_UP_ACTIONS } from '../contracts/step-up';
import { PRICING_STEP_UP_ACTIONS } from '../../pricing/contracts/step-up';
import { CATALOG_STEP_UP_ACTIONS } from '../../catalog/contracts/step-up';
import { SELLERS_STEP_UP_ACTIONS } from '../../sellers/contracts/step-up';
import { PAYMENTS_STEP_UP_ACTIONS } from '../../payments/contracts/step-up';
import { WALLET_STEP_UP_ACTIONS } from '../../wallet/contracts/step-up';
import {
  proofCovers,
  proofIsFresh,
  STEP_UP_ACTION_KEYS,
  stepUpAudienceOf,
  stepUpRequired,
} from './step-up';

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

describe('stepUpAudienceOf', () => {
  it('is the seller panel unless the action names the admin panel', () => {
    expect(stepUpAudienceOf({})).toBe('seller');
    expect(stepUpAudienceOf({ audience: 'seller' })).toBe('seller');
    expect(stepUpAudienceOf({ audience: 'admin' })).toBe('admin');
  });
});

describe('proofCovers', () => {
  const SESSION = 'session-a';
  const ACTION = 'wallet.settings.change';
  const request = (overrides: Partial<Parameters<typeof proofCovers>[1]> = {}) => ({
    sessionId: SESSION,
    actionKey: ACTION,
    now: T0.add({ minutes: 2 }),
    factorActivatedAt: T0.subtract({ hours: 1 }),
    minutes: 5,
    ...overrides,
  });
  const proof = (overrides: Partial<NonNullable<Parameters<typeof proofCovers>[0]>> = {}) => ({
    sessionId: SESSION,
    actionKey: ACTION,
    verifiedAt: T0,
    ...overrides,
  });

  it('covers a fresh proof of this session for this action', () => {
    expect(proofCovers(proof(), request())).toBe(true);
    expect(proofCovers(proof(), request({ factorActivatedAt: null }))).toBe(true);
    expect(proofCovers(proof(), request({ now: T0.add({ minutes: 4, seconds: 59 }) }))).toBe(true);
  });

  it('does not cover no proof, an expired one or one from the future', () => {
    expect(proofCovers(null, request())).toBe(false);
    expect(proofCovers(proof(), request({ now: T0.add({ minutes: 5 }) }))).toBe(false);
    expect(proofCovers(proof({ verifiedAt: T0.add({ minutes: 3 }) }), request())).toBe(false);
  });

  it('is bound to its session and its action', () => {
    expect(proofCovers(proof({ sessionId: 'session-b' }), request())).toBe(false);
    expect(proofCovers(proof({ actionKey: 'pricing.price.change' }), request())).toBe(false);
  });

  it('does not cover a proof made before the current factor was activated', () => {
    expect(proofCovers(proof(), request({ factorActivatedAt: T0.add({ seconds: 1 }) }))).toBe(
      false,
    );
    expect(proofCovers(proof(), request({ factorActivatedAt: T0 }))).toBe(true);
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
      ...WALLET_STEP_UP_ACTIONS,
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

  it('keeps every admin action locked: an admin action always asks for a code', () => {
    const admin = [...IDENTITY_STEP_UP_ACTIONS, ...WALLET_STEP_UP_ACTIONS].filter(
      (a) => stepUpAudienceOf(a) === 'admin',
    );

    expect(admin.map((a) => a.key)).toEqual([
      'wallet.credit.approve',
      'wallet.credit.issue',
      'wallet.settings.change',
    ]);
    for (const action of admin)
      expect(action).toMatchObject({ locked: true, defaultRequired: true });
  });
});
