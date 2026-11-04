import { Logger } from '@nestjs/common';
import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { AttributeRelaxationExpiredAudit } from '../../domain/audit';
import type { AttributeRelaxationRequest } from '../../domain/attribute-relaxation-request';
import type { AttributeRelaxationDependencies } from '../attributes/attribute-relaxation';

/** Requests closed in one run; the next run takes the rest. */
const BATCH = 100;

/**
 * `catalog.expire-relaxation-requests` (catalog design 8.2, data design A21; attributes A2 part 3):
 * each open request past its time becomes `expired`, in its own unit, conditional on `open` and
 * the version read, so a confirm or cancel that won is never overwritten (the row is skipped).
 * One audit row each. Rule `system`. The requester's notice (EC14) is a follow-up; until then the
 * request leaves the "Waiting for you" list and the attribute stays `material`.
 */
export class ExpireRelaxationRequests extends UseCase<
  Record<string, never>,
  { readonly expired: number },
  never
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.expire-relaxation-requests',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('ExpireRelaxationRequests');

  constructor(
    gate: UseCaseGate,
    private readonly deps: Pick<
      AttributeRelaxationDependencies,
      'unitOfWork' | 'relaxations' | 'audit' | 'clock'
    >,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<{ readonly expired: number }, never>> {
    const { market } = context;
    const { deps } = this;
    const now = deps.clock.now();
    const due = await deps.unitOfWork.run<readonly AttributeRelaxationRequest[], never>(
      market,
      async () => ok(await deps.relaxations.listExpired(market, now, BATCH)),
      { readOnly: true },
    );
    if (!due.ok) return due;
    let expired = 0;
    for (const listed of due.value) {
      try {
        const done = await deps.unitOfWork.run<boolean, never>(market, async () => {
          const request = await deps.relaxations.findById(market, listed.state.id);
          if (request === null) return ok(false);
          const next = request.expire(deps.clock.now());
          if (!next.ok) return ok(false);
          await deps.relaxations.saveMove(market, next.value);
          await deps.audit.record(
            context,
            AttributeRelaxationExpiredAudit.entry(request.state.definitionId, {
              after: {
                requestId: request.state.id,
                requestedByAccountId: request.state.requestedByAccountId,
              },
            }),
          );
          return ok(true);
        });
        if (done.ok && done.value) expired += 1;
      } catch (error) {
        if (!(error instanceof StaleAggregateError)) throw error;
      }
    }
    this.#logger.log({
      msg: 'catalog.expire-relaxation-requests',
      expired,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok({ expired });
  }
}
