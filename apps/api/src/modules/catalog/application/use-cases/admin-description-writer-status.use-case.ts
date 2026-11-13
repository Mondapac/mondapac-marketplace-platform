import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_PLATFORM_PRODUCT_EDIT } from '../../contracts/permissions';
import {
  writerAvailability,
  type DescriptionWriterDependencies,
  type WriterAvailability,
  type WriterFailure,
} from '../ai/description-writer.flow';

/**
 * `catalog.admin-description-writer-status` (AIS-03): whether "Write with AI" is offered to this admin now (the Market's switch and a configured model; admins have no seller switch).
 * Rule: `catalog.platform-product.edit`; an acting-as session gets no AI (ADR-0019 R3).
 */
export class AdminDescriptionWriterStatus extends UseCase<
  Record<string, never>,
  WriterAvailability,
  WriterFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.admin-description-writer-status',
    rule: { kind: 'permissions', allOf: [CATALOG_PLATFORM_PRODUCT_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DescriptionWriterDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext): Promise<Result<WriterAvailability, WriterFailure>> {
    return writerAvailability(this.deps, context, 'admin');
  }
}
