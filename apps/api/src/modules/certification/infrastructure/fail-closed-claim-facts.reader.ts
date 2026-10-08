import type { ClaimFactsReader } from '../application/ports/claim-facts.ports';

/**
 * The stand-in of {@link ClaimFactsReader} until its raw read statements and the policy tables
 * exist (ADR-0031: fail-closed placeholder for an unbuilt dependency). Every read rejects, so
 * `evaluateClaims` answers `unavailable` for every query: no tag is ever allowed on it.
 */
export class FailClosedClaimFactsReader implements ClaimFactsReader {
  typesAndPolicies(): Promise<never> {
    return Promise.reject(new Error('claim facts reader is not built'));
  }

  sellerCertificates(): Promise<never> {
    return Promise.reject(new Error('claim facts reader is not built'));
  }
}
