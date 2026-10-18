import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { retentionEdge, type InAppNoticeDependencies } from '../in-app-notice-flow';

export interface PurgeExpiredNoticesOutput {
  readonly notices: number;
}

/**
 * `notifications.purge-expired-notices` (in-app notifications package 1): for one Market, deletes
 * the notices past the 90-day retention, with their reads. Only what is already hidden goes, so it
 * is safe to run twice and concurrently. Rule `system`: run by the daily job only.
 */
export class PurgeExpiredNotices extends UseCase<
  Record<string, never>,
  PurgeExpiredNoticesOutput,
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.purge-expired-notices',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: InAppNoticeDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<PurgeExpiredNoticesOutput, { readonly code: 'access.denied' }>> {
    const cutoff = retentionEdge(this.deps.clock);
    const done = await this.deps.unitOfWork.run(context.market, async () =>
      ok(await this.deps.notices.purgeBefore(context.market, cutoff)),
    );
    if (!done.ok) return err({ code: 'access.denied' });
    return ok({ notices: done.value });
  }
}
