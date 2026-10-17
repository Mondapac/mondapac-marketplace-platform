import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import {
  loadFileReviewPolicies,
  assertReviewPolicy,
  CheckedInReviewPolicy,
  ReviewPolicyError,
} from './checked-in-review-policy';
import { ZZ_REVIEW_POLICY } from './zz.review.seed';

// The checked-in review policies (certification design 5.1): the launch Market's file loads and
// is consistent, the synthetic Market differs from it, and a Market without a policy fails closed.

describe('the checked-in review policies', () => {
  const policies = new CheckedInReviewPolicy();

  it('loads the launch Market from config and the synthetic Market from the test fixture', () => {
    const au = policies.policyFor(testMarketContext('AU', 'default'));
    const zz = policies.policyFor(testMarketContext('ZZ', 'default'));
    expect(au.checks.map((c) => c.code)).toContain('holder-name');
    expect(zz).toBe(ZZ_REVIEW_POLICY);
    expect(zz.checks.map((c) => c.code)).not.toEqual(au.checks.map((c) => c.code));
  });

  it('stops the start-up when the folder is missing', () => {
    const missing = path.join(mkdtempSync(path.join(tmpdir(), 'review-policy-')), 'absent');
    expect(() => loadFileReviewPolicies(missing)).toThrow(ReviewPolicyError);
  });

  it('accepts a Region Stack hosting AU and ZZ, both with a policy', () => {
    expect(() => new CheckedInReviewPolicy(undefined, ['AU', 'ZZ'])).not.toThrow();
  });

  it.each(['AU', 'ZZ'])('stops the start-up when hosted Market %s has no policy', (code) => {
    const all = { ...loadFileReviewPolicies(), ZZ: ZZ_REVIEW_POLICY };
    const without = Object.fromEntries(Object.entries(all).filter(([market]) => market !== code));
    expect(() => new CheckedInReviewPolicy(without, ['AU', 'ZZ'])).toThrow(ReviewPolicyError);
    expect(() => new CheckedInReviewPolicy(without, ['AU', 'ZZ'])).toThrow(new RegExp(code));
  });

  it('fails closed for a Market with no policy', () => {
    expect(() => policies.policyFor(testMarketContext('NZ', 'default'))).toThrow();
  });

  it('keeps every reason pointing at a check of the Market', () => {
    for (const policy of Object.values(loadFileReviewPolicies())) {
      expect(() => assertReviewPolicy(policy, 'test')).not.toThrow();
    }
  });

  it.each([
    [
      'a duplicate check',
      {
        checks: [ZZ_REVIEW_POLICY.checks[0]!, ZZ_REVIEW_POLICY.checks[0]!],
        reasons: [],
        issuerRequestReasons: [],
      },
    ],
    [
      'a reason for an unknown check',
      {
        checks: ZZ_REVIEW_POLICY.checks,
        reasons: [{ ...ZZ_REVIEW_POLICY.reasons[0]!, check: 'no-such-check' }],
        issuerRequestReasons: [],
      },
    ],
    [
      'a reason with no outcome',
      {
        checks: ZZ_REVIEW_POLICY.checks,
        reasons: [{ ...ZZ_REVIEW_POLICY.reasons[0]!, outcomes: [] }],
        issuerRequestReasons: [],
      },
    ],
    [
      'a duplicate issuer request reason',
      {
        checks: ZZ_REVIEW_POLICY.checks,
        reasons: ZZ_REVIEW_POLICY.reasons,
        issuerRequestReasons: [
          ZZ_REVIEW_POLICY.issuerRequestReasons[0]!,
          ZZ_REVIEW_POLICY.issuerRequestReasons[0]!,
        ],
      },
    ],
  ])('refuses %s', (_name, policy) => {
    expect(() => assertReviewPolicy(policy, 'test')).toThrow();
  });
});
