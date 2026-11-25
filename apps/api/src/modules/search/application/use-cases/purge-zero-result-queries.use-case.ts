import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ZERO_RESULT_RETENTION_DAYS } from '../../domain/zero-result';
import type { ZeroResultDependencies } from './zero-result-texts.use-case';

/** Rows deleted per statement (Mojtaba L2). */
export const PURGE_BATCH = 10_000;
/** Batches per run: 1 million rows, far above a normal day's backlog. */
export const MAX_PURGE_BATCHES = 100;

/**
 * `search.purge-zero-result-queries` (dashboards v2, phase 2): deletes the Market's zero-result
 * notes older than {@link ZERO_RESULT_RETENTION_DAYS} days (the injected Clock), well after
 * reporting's snapshot read them (its look-back is 28 days), in batches of {@link PURGE_BATCH}
 * rows, each in its own unit. Rule `system`. Answers a count only.
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
    let deleted = 0;
    // Batches of PURGE_BATCH rows, each its own short unit (Mojtaba L2); a backlog larger than
    // MAX_PURGE_BATCHES batches is finished by the next run.
    for (let batch = 0; batch < MAX_PURGE_BATCHES; batch += 1) {
      const unit = await this.deps.unitOfWork.run(market, async () =>
        ok(await this.deps.zeroResults.purgeBefore(market, before, PURGE_BATCH)),
      );
      if (!unit.ok) throw new Error('search.purge-zero-result-queries: write refused');
      deleted += unit.value;
      if (unit.value < PURGE_BATCH) break;
    }
    return ok({ deleted });
  }
}
