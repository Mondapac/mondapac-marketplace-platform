import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import {
  writeDescriptionDraft,
  type DescriptionWriterDependencies,
  type WriterDraft,
  type WriterFailure,
} from '../ai/description-writer.flow';

export type { WriterDraft } from '../ai/description-writer.flow';
/**
 * `catalog.own-description-draft` (AIS-03): a seller's description draft from the form data, keywords and short note. Nothing is stored.
 * Rule: `catalog.own-product.edit`; an acting-as session gets no AI (ADR-0019 R3).
 */
export class OwnDescriptionDraft extends UseCase<
  { readonly body?: unknown },
  WriterDraft,
  WriterFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-description-draft',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
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
    return writeDescriptionDraft(this.deps, context, 'seller', input?.body);
  }
}
