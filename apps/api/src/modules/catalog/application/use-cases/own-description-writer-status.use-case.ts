import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import {
  writerAvailability,
  type DescriptionWriterDependencies,
  type WriterAvailability,
  type WriterFailure,
} from '../ai/description-writer.flow';

export type { WriterAvailability } from '../ai/description-writer.flow';
/**
 * `catalog.own-description-writer-status` (AIS-03): whether "Write with AI" is offered to this seller now (the Market's switch, the seller's switch and a configured model).
 * Rule: `catalog.own-product.edit`; an acting-as session gets no AI (ADR-0019 R3).
 */
export class OwnDescriptionWriterStatus extends UseCase<
  Record<string, never>,
  WriterAvailability,
  WriterFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-description-writer-status',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DescriptionWriterDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext): Promise<Result<WriterAvailability, WriterFailure>> {
    return writerAvailability(this.deps, context, 'seller');
  }
}
