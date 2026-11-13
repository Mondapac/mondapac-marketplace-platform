import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_PLATFORM_PRODUCT_EDIT } from '../../contracts/permissions';
import {
  writeDescriptionDraft,
  type DescriptionWriterDependencies,
  type WriterDraft,
  type WriterFailure,
} from '../ai/description-writer.flow';

/**
 * `catalog.admin-description-draft` (AIS-03): an admin's description draft for a platform product (owner decision 2026-10-31: the writer in the admin panel too). Nothing is stored.
 * Rule: `catalog.platform-product.edit`; an acting-as session gets no AI (ADR-0019 R3).
 */
export class AdminDescriptionDraft extends UseCase<
  { readonly body?: unknown },
  WriterDraft,
  WriterFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.admin-description-draft',
    rule: { kind: 'permissions', allOf: [CATALOG_PLATFORM_PRODUCT_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DescriptionWriterDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly body?: unknown },
  ): Promise<Result<WriterDraft, WriterFailure>> {
    return writeDescriptionDraft(this.deps, context, 'admin', input?.body);
  }
}
