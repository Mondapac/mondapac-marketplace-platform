import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_VARIANT_REQUEST_REVIEW } from '../../contracts/permissions';
import { parseBulkItems, runBulkDecide } from '../lists/bulk-decide';
import type { VariantRequestApprove } from './variant-request-approve.use-case';
import type { VariantRequestDecline } from './variant-request-decline.use-case';
import {
  adminOnly,
  closed,
  refuse,
  type BulkDecideOutput,
  type BulkDecideRefusal,
} from '../lists/bulk-decide-shared';

export interface VariantRequestBulkDecideDependencies {
  readonly variantApprove: VariantRequestApprove;
  readonly variantDecline: VariantRequestDecline;
}

/** `variant-request.bulk-decide`: approve, or decline with one reason, up to 50 open requests. */
export class VariantRequestBulkDecide extends UseCase<
  unknown,
  BulkDecideOutput,
  BulkDecideRefusal
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.variant-request-bulk-decide',
    rule: { kind: 'permissions', allOf: [CATALOG_VARIANT_REQUEST_REVIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: VariantRequestBulkDecideDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<BulkDecideOutput, BulkDecideRefusal>> {
    if (!adminOnly(context)) return err({ code: 'access.denied' });
    const body = closed(input, ['action', 'items', 'reason']);
    if (!body.ok) return body;
    const items = parseBulkItems(body.value['items']);
    if (!items.ok) return items;
    const action = body.value['action'];
    if (action === 'approve') {
      if (body.value['reason'] !== undefined) return refuse('reason', 'unknown');
      const done = await runBulkDecide(items.value, (item) =>
        this.deps.variantApprove.execute(context, { requestId: item.id, version: item.version }),
      );
      return ok({ action, ...done });
    }
    if (action === 'decline') {
      const reason = body.value['reason'];
      if (typeof reason !== 'string' || reason.trim() === '') return refuse('reason', 'required');
      const done = await runBulkDecide(items.value, (item) =>
        this.deps.variantDecline.execute(context, {
          requestId: item.id,
          version: item.version,
          reason,
        }),
      );
      return ok({ action, ...done });
    }
    return refuse('action', 'value');
  }
}
