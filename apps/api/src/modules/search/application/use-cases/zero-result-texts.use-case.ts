import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result, Temporal } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type AccessDenied,
  type UseCaseGate,
} from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { ZeroResultLog } from '../ports/zero-result-log';

/** What the zero-result use cases need. */
export interface ZeroResultDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly zeroResults: ZeroResultLog;
  readonly clock: Clock;
}

/** The most texts one window answers: those noted in the most quarter hours. */
export const MAX_ZERO_RESULT_TEXTS = 2_000;
/** The longest window one read may cover: a Market day of 25 hours, with a margin. */
export const MAX_ZERO_RESULT_WINDOW_HOURS = 26;

export interface ZeroResultTextsRequest {
  readonly window: { readonly from: Temporal.Instant; readonly to: Temporal.Instant };
}

export interface ZeroResultTexts {
  /** Folded texts, those noted in the most quarter hours first; at most 2,000. */
  readonly texts: readonly string[];
}

export type ZeroResultTextsFailure = AccessDenied | { readonly code: 'validation.failed' };

const isInstant = (value: unknown): value is Temporal.Instant =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { epochNanoseconds?: unknown }).epochNanoseconds === 'bigint';

/**
 * `search.zero-result-texts` (dashboards v2, phase 2): the folded texts the storefront search
 * found nothing for in one window (a Market day), for reporting's nightly snapshot. Rule `system`.
 * Texts only: nothing about who searched is held. At most {@link MAX_ZERO_RESULT_TEXTS}, those
 * noted in the most quarter hours first, so a flood of one-off texts cannot push out the texts
 * many shoppers miss. One read-only unit (ADR-0025).
 */
export class ZeroResultTextsOf extends UseCase<
  ZeroResultTextsRequest,
  ZeroResultTexts,
  ZeroResultTextsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'search.zero-result-texts',
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
    input: ZeroResultTextsRequest,
  ): Promise<Result<ZeroResultTexts, ZeroResultTextsFailure>> {
    const window = input?.window;
    if (!isInstant(window?.from) || !isInstant(window.to)) {
      return err({ code: 'validation.failed' });
    }
    const span = window.to.epochMilliseconds - window.from.epochMilliseconds;
    if (!(span > 0) || span > MAX_ZERO_RESULT_WINDOW_HOURS * 3_600_000) {
      return err({ code: 'validation.failed' });
    }
    const { market } = context;
    return this.deps.unitOfWork.run<ZeroResultTexts, ZeroResultTextsFailure>(
      market,
      async () =>
        ok({ texts: await this.deps.zeroResults.textsIn(market, window, MAX_ZERO_RESULT_TEXTS) }),
      { readOnly: true },
    );
  }
}
