import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Logger } from '@nestjs/common';
import type { MarketContext } from '@mondapac/shared-kernel';
import { z } from 'zod';
import type { ExpiryPolicyProvider } from '../../application/ports/expiry.repository';
import { assertExpiryPolicy, ExpiryPolicyError, type ExpiryPolicy } from '../../domain/expiry';

/**
 * The directory of the per-Market expiry policies (`config/certification-expiry/<MARKET>.json`):
 * Market data in a configuration file, not in core code (ADR-0003 decision 2; design 5.1).
 */
export const DEFAULT_EXPIRY_POLICY_DIR = path.resolve(
  __dirname,
  '../../../../../../../config/certification-expiry',
);

/**
 * The synthetic Market's policy (design 5.1: thresholds as AU, a shorter submit-by), so tests
 * prove the job generic.
 */
export const ZZ_EXPIRY_POLICY: ExpiryPolicy = {
  warningThresholdsDays: [30, 14, 1],
  renewalSubmitByDays: 2,
};

const file = z.strictObject({
  market: z.string().regex(/^[A-Z][A-Z0-9_]{1,7}$/),
  note: z.string().optional(),
  warningThresholdsDays: z.array(z.number().int()).max(10),
  renewalSubmitByDays: z.number().int(),
});

const logger = new Logger('CertificationExpiryPolicyFiles');

/** Reads every `<MARKET>.json` of the directory. A missing directory is an empty set; a bad file throws. */
export function loadFileExpiryPolicies(
  directory: string = DEFAULT_EXPIRY_POLICY_DIR,
): Readonly<Record<string, ExpiryPolicy>> {
  const policies: Record<string, ExpiryPolicy> = {};
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch {
    logger.warn({ msg: 'certification.expiry-policy.no-directory', directory });
    return policies;
  }
  for (const name of names) {
    const parsed = file.safeParse(JSON.parse(readFileSync(path.join(directory, name), 'utf8')));
    if (!parsed.success) throw new ExpiryPolicyError(`${name}: ${parsed.error.message}`);
    if (path.basename(name, '.json') !== parsed.data.market) {
      throw new ExpiryPolicyError(`${name}: names Market ${parsed.data.market}`);
    }
    const policy: ExpiryPolicy = {
      warningThresholdsDays: parsed.data.warningThresholdsDays,
      renewalSubmitByDays: parsed.data.renewalSubmitByDays,
    };
    assertExpiryPolicy(policy, name);
    policies[parsed.data.market] = policy;
  }
  return policies;
}

/** The checked-in policies by Market id; a Market with none warns nobody (null). */
export class CheckedInExpiryPolicy implements ExpiryPolicyProvider {
  readonly #policies: Readonly<Record<string, ExpiryPolicy>>;

  constructor(
    policies: Readonly<Record<string, ExpiryPolicy>> = {
      ...loadFileExpiryPolicies(),
      ZZ: ZZ_EXPIRY_POLICY,
    },
  ) {
    for (const [market, policy] of Object.entries(policies)) assertExpiryPolicy(policy, market);
    this.#policies = policies;
  }

  policyFor(market: MarketContext): ExpiryPolicy | null {
    return this.#policies[market.marketId] ?? null;
  }
}
