import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { purgeExpiredBlockCounts, type BlockCountDependencies } from '../block-count-flow';

export interface PurgeExpiredBlockCountsOutput {
  readonly blockCounts: number;
}

/**
 * `engagement.purge-expired-block-counts`: for one Market, deletes the daily block counts older
 * than 13 months. Rule `system`: run by the daily job only.
 */
export class PurgeExpiredBlockCounts extends UseCase<
  Record<string, never>,
  PurgeExpiredBlockCountsOutput,
  never
> {
  static override readonly access: AccessDeclaration = {
    name: 'engagement.purge-expired-block-counts',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: Pick<BlockCountDependencies, 'unitOfWork' | 'counts' | 'clock'>,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return purgeExpiredBlockCounts(this.deps, context);
  }
}
