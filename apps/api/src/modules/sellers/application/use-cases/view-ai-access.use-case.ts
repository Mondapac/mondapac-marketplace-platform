import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLERS_SELLER_VIEW } from '../../contracts/permissions';
import type { AiAccessSettingRepository } from '../ports/ai-access-setting.repository';

export interface ViewAiAccessInput {
  readonly sellerId?: unknown;
}

export interface ViewAiAccessResult {
  readonly enabled: boolean;
  /** When an admin last changed the switch; null when it never changed. */
  readonly changedAt: Temporal.Instant | null;
}

export type ViewAiAccessFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'file.not-found' }
  | { readonly code: 'sellers.unavailable' };

export interface ViewAiAccessDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly aiAccessSetting: AiAccessSettingRepository;
}

/**
 * `sellers.view-ai-access` (SEL-25): the admin read of a seller's AI switch and when it last
 * changed. Rule `permissions [sellers.seller.view]`; admin population only. One read-only unit. An
 * unknown seller and another Market's seller are both `file.not-found`.
 */
export class ViewAiAccessUseCase extends UseCase<
  ViewAiAccessInput,
  ViewAiAccessResult,
  ViewAiAccessFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.view-ai-access',
    rule: { kind: 'permissions', allOf: [SELLERS_SELLER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ViewAiAccessDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ViewAiAccessInput,
  ): Promise<Result<ViewAiAccessResult, ViewAiAccessFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const seller =
      typeof (input ?? {}).sellerId === 'string'
        ? parseId<'Seller'>(input.sellerId as string)
        : null;
    if (seller === null || !seller.ok) return err({ code: 'file.not-found' });
    const sellerId = seller.value;
    return this.deps.unitOfWork.run<ViewAiAccessResult, ViewAiAccessFailure>(
      market,
      async () => {
        const view = await this.deps.aiAccessSetting.read(market, sellerId);
        return view === null ? err({ code: 'file.not-found' }) : ok(view);
      },
      { readOnly: true },
    );
  }
}
