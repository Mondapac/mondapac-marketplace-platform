import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ZERO_RESULT_RETENTION_DAYS } from '../../domain/zero-result';
import type { ZeroResultDependencies } from './zero-result-texts.use-case';

/**
 * `search.purge-zero-result-queries` (dashboards v2, phase 2): deletes the Market's zero-result
 * notes older than {@link ZERO_RESULT_RETENTION_DAYS} days (the injected Clock), well after
 * reporting's snapshot read them (its look-back is 28 days). Rule `system`. Answers a count only.
 */
export class PurgeZeroResultQueries extends UseCase<
  Record<string, never>,
  { readonly deleted: number },
  never
> {
  static override readonly access: AccessDeclaration = {
    name: 'search.purge-zero-result-queries',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ZeroResultDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<{ readonly deleted: number }, never>> {
    const { market } = context;
    const before = this.deps.clock.now().subtract({ hours: ZERO_RESULT_RETENTION_DAYS * 24 });
    const unit = await this.deps.unitOfWork.run(market, async () =>
      ok(await this.deps.zeroResults.purgeBefore(market, before)),
    );
    if (!unit.ok) throw new Error('search.purge-zero-result-queries: write refused');
    return ok({ deleted: unit.value });
  }
}
