import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { ok } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { parseSellerIds, type SellerIdsRefused } from '../summaries/read-seller-summaries';

export interface SellingEligibilityInput {
  readonly sellerIds: readonly string[];
}

/** One answer per requested seller. No reason code leaves the facade (sellers design 7.2 row 6). */
export type SellingEligibilityAnswer = ReadonlyMap<Id<'Seller'>, { readonly eligible: boolean }>;

export type SellingEligibilityFailure = SellerIdsRefused;

/**
 * Fail-closed stand-in for the may-sell contract (sellers design 7.2; slice 9 builds the real
 * one). Every seller is `eligible: false`. That is the true answer today because 7.2 row 2
 * needs an approved `sellers` revision and none can exist before slice 7a-decide; identity's
 * `approved` alone never means eligible (ADR-0022 decision 6: `sellers`' conditions only narrow
 * identity's yes). `catalog` can build against the final signature. It reads nothing and calls
 * no other module. Slice 9 replaces it and deletes this comment; until then nothing here can
 * return `true`, and no flag, config switch or default-true branch may be added.
 */
export function answerFor(ids: ReadonlySet<Id<'Seller'>>): SellingEligibilityAnswer {
  return new Map([...ids].map((sellerId) => [sellerId, { eligible: false }] as const));
}

/** `sellingEligibility` for request actors: rule `anonymous`; its pair is the `system` case. */
export class SellingEligibility extends UseCase<
  SellingEligibilityInput,
  SellingEligibilityAnswer,
  SellingEligibilityFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.selling-eligibility',
    rule: { kind: 'anonymous' },
  };

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(
    _context: CallContext,
    input: SellingEligibilityInput,
  ): Promise<Result<SellingEligibilityAnswer, SellingEligibilityFailure>> {
    const ids = parseSellerIds(input.sellerIds);
    return Promise.resolve(ids.ok ? ok(answerFor(ids.value)) : ids);
  }
}
