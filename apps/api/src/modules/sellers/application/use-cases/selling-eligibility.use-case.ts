import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { ok } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { AccessState } from '../../domain/seller-status';
import type { SellerAccessReader } from '../ports/seller-access-reader';
import type { SellerMarketPolicy } from '../ports/seller-market-policy';
import type {
  ApprovedSellingFacts,
  SellingFactsRepository,
} from '../ports/selling-facts.repository';
import { parseSellerIds, type SellerIdsRefused } from '../summaries/read-seller-summaries';

export interface SellingEligibilityInput {
  readonly sellerIds: readonly string[];
}

/** One answer per requested seller. No reason code leaves the facade (sellers design 7.2 row 6). */
export type SellingEligibilityAnswer = ReadonlyMap<Id<'Seller'>, { readonly eligible: boolean }>;

export type SellingEligibilityFailure = SellerIdsRefused;

export interface SellingEligibilityDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellingFacts: SellingFactsRepository;
  readonly accessReader: SellerAccessReader;
  readonly policy: SellerMarketPolicy;
}

/** The runtime's canonical IANA zone names; an alias, an offset or a wrong case fails closed. */
const IANA_ZONES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('timeZone'));

/**
 * The one condition of sellers design 7.2 row 2 on `sellers`' side, given identity's state. The
 * ServiceArea condition holds by construction: a revision is only created from a draft whose
 * address was in an onboarding-enabled area (`BusinessFileRevision.submit`), and approval binds
 * that revision. The identifier rule is the Market's **current** one (14.3 Q-M18); a Market with
 * no rule answers no.
 */
export function mayAnswerYes(
  access: AccessState | undefined,
  facts: ApprovedSellingFacts | undefined,
  identifierRequired: boolean | null,
): boolean {
  if (access !== 'approved' || facts === undefined || identifierRequired === null) return false;
  if (identifierRequired && !facts.hasIdentifier) return false;
  if (!IANA_ZONES.has(facts.operatingTimezone)) return false;
  return !facts.openClaimConflict;
}

/**
 * The may-sell contract (sellers design 7.2), the one query function behind both use cases of the
 * pair. The actor is not a parameter, so the answer is the same for every caller. Order (row 3):
 * `sellers`' own rows in one read-only unit, then `identity.sellerAccessOf` outside any unit, only
 * for the ids `sellers` would allow. Fails closed (row 4): an unknown id, another Market's seller,
 * a read error or an `identity` refusal is `eligible: false`; nothing is cached; no register call
 * (row 5); no reason code leaves (row 6). `sellers`' conditions only narrow identity's yes (row 7).
 */
export async function sellingEligibilityFor(
  deps: SellingEligibilityDependencies,
  context: CallContext,
  sellerIds: readonly string[],
): Promise<Result<SellingEligibilityAnswer, SellingEligibilityFailure>> {
  const ids = parseSellerIds(sellerIds);
  if (!ids.ok) return ids;
  const distinct = [...ids.value];
  const answer = (yes: ReadonlySet<Id<'Seller'>>): SellingEligibilityAnswer =>
    new Map(distinct.map((sellerId) => [sellerId, { eligible: yes.has(sellerId) }] as const));
  if (distinct.length === 0) return ok(answer(new Set()));
  const { market } = context;

  let identifierRequired: boolean | null = null;
  try {
    identifierRequired = deps.policy.businessIdentifier(market)?.required ?? null;
  } catch {
    identifierRequired = null;
  }
  if (identifierRequired === null) return ok(answer(new Set()));

  let facts: ReadonlyMap<Id<'Seller'>, ApprovedSellingFacts>;
  try {
    const read = await deps.unitOfWork.run(
      market,
      async () => ok(await deps.sellingFacts.approvedSellingFacts(market, distinct)),
      { readOnly: true },
    );
    if (!read.ok) return ok(answer(new Set()));
    facts = read.value;
  } catch {
    return ok(answer(new Set()));
  }
  const candidates = distinct.filter((sellerId) =>
    mayAnswerYes('approved', facts.get(sellerId), identifierRequired),
  );
  if (candidates.length === 0) return ok(answer(new Set()));

  let access: ReadonlyMap<Id<'Seller'>, AccessState>;
  try {
    access = await deps.accessReader.accessOfMany(context, candidates);
  } catch {
    return ok(answer(new Set()));
  }
  return ok(
    answer(
      new Set(
        candidates.filter((sellerId) =>
          mayAnswerYes(access.get(sellerId), facts.get(sellerId), identifierRequired),
        ),
      ),
    ),
  );
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

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellingEligibilityDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: SellingEligibilityInput,
  ): Promise<Result<SellingEligibilityAnswer, SellingEligibilityFailure>> {
    return sellingEligibilityFor(this.deps, context, input.sellerIds);
  }
}
