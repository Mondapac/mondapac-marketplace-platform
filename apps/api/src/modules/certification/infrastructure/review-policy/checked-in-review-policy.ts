import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import type { MarketContext } from '@mondapac/shared-kernel';
import { z } from 'zod';
import type { ReviewPolicyProvider } from '../../application/ports/review.ports';
import type { ReviewPolicy } from '../../domain/review';
import { ZZ_REVIEW_POLICY } from './zz.review.seed';

/**
 * The directory of the per-Market review policies (`config/certification-review/<MARKET>.json`):
 * Market data, so the Market's checks and reasons live in a configuration file and not in core
 * code (ADR-0003 decision 2; design 5.1).
 */
export const DEFAULT_REVIEW_POLICY_DIR = path.resolve(
  __dirname,
  '../../../../../../../config/certification-review',
);

const code = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const mode = z.enum(['THIRD_PARTY_DOCUMENT', 'SELF_DECLARATION']);
const outcome = z.enum(['changes-requested', 'declined']);
const file = z.strictObject({
  market: z.string().regex(/^[A-Z][A-Z0-9_]{1,7}$/),
  note: z.string().optional(),
  checks: z.array(z.strictObject({ code, required: z.boolean(), modes: z.array(mode).min(1) })),
  reasons: z.array(
    z.strictObject({
      code,
      check: code.nullable(),
      nextStep: code,
      label: z.string().min(1).max(300),
      outcomes: z.array(outcome).min(1),
    }),
  ),
  issuerRequestReasons: z.array(z.strictObject({ code, label: z.string().min(1).max(300) })),
});

const logger = new Logger('CertificationReviewPolicyFiles');

/** A policy that is unreadable, malformed or inconsistent: the start-up stops. */
export class ReviewPolicyError extends Error {}

/**
 * Check codes are distinct, reasons are distinct and name a check of the list (when they name one),
 * and the issuer request reasons are distinct.
 */
export function assertReviewPolicy(policy: ReviewPolicy, where: string): void {
  const checks = new Set<string>();
  for (const check of policy.checks) {
    if (checks.has(check.code)) throw new ReviewPolicyError(`${where}: check ${check.code} twice`);
    checks.add(check.code);
  }
  const answers = new Set<string>();
  for (const reason of policy.issuerRequestReasons) {
    if (answers.has(reason.code)) {
      throw new ReviewPolicyError(`${where}: issuer request reason ${reason.code} twice`);
    }
    answers.add(reason.code);
  }
  const reasons = new Set<string>();
  for (const reason of policy.reasons) {
    if (reasons.has(reason.code)) {
      throw new ReviewPolicyError(`${where}: reason ${reason.code} twice`);
    }
    reasons.add(reason.code);
    if (reason.outcomes.length === 0) {
      throw new ReviewPolicyError(`${where}: reason ${reason.code} has no outcome`);
    }
    if (reason.check !== null && !checks.has(reason.check)) {
      throw new ReviewPolicyError(`${where}: reason ${reason.code} names an unknown check`);
    }
  }
}

/**
 * Reads every `<MARKET>.json` of the directory. A missing directory or a bad file throws, so the
 * start-up stops (Ali ruling 2026-10-17 on ADR-0003 decision 5: no warn-and-continue).
 */
export function loadFileReviewPolicies(
  directory: string = DEFAULT_REVIEW_POLICY_DIR,
): Readonly<Record<string, ReviewPolicy>> {
  const policies: Record<string, ReviewPolicy> = {};
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch {
    logger.error({ msg: 'certification.review-policy.no-directory', directory });
    throw new ReviewPolicyError(`${directory}: the review policy folder is missing`);
  }
  for (const name of names) {
    const parsed = file.safeParse(JSON.parse(readFileSync(path.join(directory, name), 'utf8')));
    if (!parsed.success) throw new ReviewPolicyError(`${name}: ${parsed.error.message}`);
    if (path.basename(name, '.json') !== parsed.data.market) {
      throw new ReviewPolicyError(`${name}: names Market ${parsed.data.market}`);
    }
    const policy: ReviewPolicy = {
      checks: parsed.data.checks,
      reasons: parsed.data.reasons,
      issuerRequestReasons: parsed.data.issuerRequestReasons,
    };
    assertReviewPolicy(policy, name);
    policies[parsed.data.market] = policy;
  }
  return policies;
}

/**
 * Start-up check (Ali ruling 2026-10-17): every Market the Region Stack hosts has a review policy,
 * as `ServiceAreaDirectory` requires its files. A hosted Market without one stops the start-up.
 */
export function assertReviewPoliciesHosted(
  policies: Readonly<Record<string, ReviewPolicy>>,
  hostedMarketIds: readonly string[],
): void {
  const missing = hostedMarketIds.filter((marketId) => policies[marketId] === undefined);
  if (missing.length > 0) {
    throw new ReviewPolicyError(
      `Hosted Market(s) ${missing.join(', ')} have no file in config/certification-review/`,
    );
  }
}

/**
 * The checked-in policies by Market id; a Market with none fails closed (no review). With
 * `hostedMarketIds` (the application's binding), a hosted Market without a policy stops the
 * start-up.
 */
export class CheckedInReviewPolicy implements ReviewPolicyProvider {
  readonly #policies: Readonly<Record<string, ReviewPolicy>>;

  constructor(
    policies: Readonly<Record<string, ReviewPolicy>> = {
      ...loadFileReviewPolicies(),
      ZZ: ZZ_REVIEW_POLICY,
    },
    hostedMarketIds?: readonly string[],
  ) {
    this.#policies = policies;
    for (const [market, policy] of Object.entries(policies)) assertReviewPolicy(policy, market);
    if (hostedMarketIds !== undefined) assertReviewPoliciesHosted(policies, hostedMarketIds);
  }

  policyFor(market: MarketContext): ReviewPolicy {
    const policy = this.#policies[market.marketId];
    if (policy === undefined) {
      throw new ReviewPolicyError('The Market has no review policy');
    }
    return policy;
  }
}
