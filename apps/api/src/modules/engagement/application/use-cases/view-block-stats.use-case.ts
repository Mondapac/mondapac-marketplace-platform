import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { STOREFRONT_PAGE_STATS } from '../../../storefront';
import {
  viewBlockStats,
  type BlockCountDependencies,
  type BlockStatsView,
  type ViewBlockStatsFailure,
} from '../block-count-flow';

export type { BlockStatsView };

/**
 * `engagement.view-block-stats`: an admin reads how often each block of a storefront page was
 * shown and clicked, per UTC day (needs storefront's `storefront.page.stats`). Aggregate numbers
 * only; nothing about who saw or clicked is kept, so nothing about them can be read.
 */
export class ViewBlockStats extends UseCase<
  { readonly query: Readonly<Record<string, unknown>> },
  BlockStatsView,
  ViewBlockStatsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'engagement.view-block-stats',
    rule: { kind: 'permissions', allOf: [STOREFRONT_PAGE_STATS.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BlockCountDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly query: Readonly<Record<string, unknown>> },
  ) {
    return viewBlockStats(this.deps, context, input);
  }
}
