import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { ExpiryPolicyError } from '../../domain/expiry';
import {
  CheckedInExpiryPolicy,
  loadFileExpiryPolicies,
  ZZ_EXPIRY_POLICY,
} from './checked-in-expiry-policy';

// The checked-in expiry policies (certification design 5.1, 8.6): the launch Market's file loads
// with the CERT-14 thresholds, the synthetic Market differs in its submit-by days, a Market
// without a file warns nobody, and a malformed file stops the start-up.

describe('the checked-in expiry policies', () => {
  const policies = new CheckedInExpiryPolicy();

  it('loads AU from config and ZZ from the fixture', () => {
    const au = policies.policyFor(testMarketContext('AU', 'default'));
    const zz = policies.policyFor(testMarketContext('ZZ', 'default'));
    expect(au).toEqual({ warningThresholdsDays: [30, 14, 1], renewalSubmitByDays: 7 });
    expect(zz).toBe(ZZ_EXPIRY_POLICY);
    expect(zz!.renewalSubmitByDays).not.toBe(au!.renewalSubmitByDays);
  });

  it('answers null for a Market without a policy', () => {
    expect(policies.policyFor(testMarketContext('NZ', 'default'))).toBeNull();
  });

  it.each([
    ['a duplicate threshold', { warningThresholdsDays: [14, 14], renewalSubmitByDays: 7 }],
    ['a zero threshold', { warningThresholdsDays: [0], renewalSubmitByDays: 7 }],
    ['a fractional submit-by', { warningThresholdsDays: [30], renewalSubmitByDays: 1.5 }],
    ['an unknown key', { warningThresholdsDays: [30], renewalSubmitByDays: 7, extra: true }],
  ])('refuses %s', (_name, body) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'expiry-policy-'));
    writeFileSync(path.join(dir, 'XX.json'), JSON.stringify({ market: 'XX', ...body }));
    expect(() => loadFileExpiryPolicies(dir)).toThrow(ExpiryPolicyError);
  });

  it('refuses a file named for another Market', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'expiry-policy-'));
    writeFileSync(
      path.join(dir, 'XX.json'),
      JSON.stringify({ market: 'YY', warningThresholdsDays: [1], renewalSubmitByDays: 0 }),
    );
    expect(() => loadFileExpiryPolicies(dir)).toThrow(ExpiryPolicyError);
  });
});
