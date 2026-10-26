import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  UseCase,
  type AccessDeclaration,
  type StepUpActionRegistry,
  type UseCaseGate,
} from '../../../../platform/authz';
import { stepUpAudienceOf, stepUpRequired } from '../../domain/step-up';
import type { StepUpRepository } from '../ports/step-up.repository';

/** One action's rule as the panel shows it. */
export interface StepUpPolicyItem {
  readonly actionKey: string;
  /** What applies now: the floor, the shop's own rule or the default. */
  readonly required: boolean;
  /** The platform floor: always required, cannot be turned off. */
  readonly locked: boolean;
  /** What applies when the shop has set no rule. */
  readonly defaultRequired: boolean;
  /** When the shop last set its own rule, or null. */
  readonly updatedAt: Temporal.Instant | null;
}

export interface ListSellerStepUpPolicyOutput {
  readonly items: readonly StepUpPolicyItem[];
}

export interface ListSellerStepUpPolicyDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly stepUp: StepUpRepository;
  readonly stepUpActions: Pick<StepUpActionRegistry, 'list'>;
}

/** The rules of one shop, for a seller session or (support) an admin session; see callers. */
export async function stepUpPolicyOf(
  deps: ListSellerStepUpPolicyDependencies,
  context: CallContext,
  sellerId: Id<'Seller'>,
): Promise<Result<ListSellerStepUpPolicyOutput, never>> {
  return deps.unitOfWork.run(
    context.market,
    async () => {
      const stored = new Map(
        (await deps.stepUp.policiesOf(context.market, sellerId)).map((row) => [row.actionKey, row]),
      );
      return ok({
        // A platform admin action is never a shop's to see or set (issue #491).
        items: deps.stepUpActions
          .list()
          .filter((action) => stepUpAudienceOf(action) === 'seller')
          .map((action) => {
            const row = stored.get(action.key);
            return {
              actionKey: action.key,
              required: stepUpRequired(action, row?.required),
              locked: action.locked,
              defaultRequired: action.defaultRequired,
              updatedAt: row?.updatedAt ?? null,
            };
          }),
      });
    },
    { readOnly: true },
  );
}

/**
 * The two-step rules of the signed-in seller's own shop, one row per registered action (seller
 * OTP policy). Rule `own-resources`, approved sellers only: every member reads them, only the
 * Owner changes them (`SetSellerStepUpPolicy`). The shop is the session's, never input (R6).
 */
export class ListSellerStepUpPolicy extends UseCase<
  Record<string, never>,
  ListSellerStepUpPolicyOutput,
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.list-seller-step-up-policy',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ListSellerStepUpPolicyDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
  ): Promise<Result<ListSellerStepUpPolicyOutput, { readonly code: 'access.denied' }>> {
    const { actor } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null
    ) {
      return Promise.resolve(err({ code: 'access.denied' }));
    }
    return stepUpPolicyOf(this.deps, context, actor.sellerId);
  }
}
