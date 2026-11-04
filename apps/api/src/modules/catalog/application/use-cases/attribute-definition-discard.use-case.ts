import { Logger } from '@nestjs/common';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_ATTRIBUTE_EDIT } from '../../contracts/permissions';
import { AttributeDefinitionDiscardedAudit } from '../../domain/audit';
import {
  changeStatus,
  type AttributeDefinitionStatusDependencies,
  type AttributeDefinitionStatusFailure,
  type AttributeDefinitionStatusInput,
  type AttributeStatusOutput as Output,
} from '../attributes/attribute-status';

/**
 * `attribute-definition.discard` (attributes plan, package A2): a draft that was never published is
 * set aside. Rule as publish. Nothing is deleted (CA3): it becomes archived, its code stays taken
 * and its revisions stay readable. A published attribute cannot be discarded (archiving one is a
 * later package, with the two-person rule for a material one). One audit row.
 */
export class AttributeDefinitionDiscard extends UseCase<
  AttributeDefinitionStatusInput,
  Output,
  AttributeDefinitionStatusFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-definition-discard',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_EDIT.key] },
  };

  readonly #logger = new Logger('AttributeDefinitionDiscard');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AttributeDefinitionStatusDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AttributeDefinitionStatusInput,
  ): Promise<Result<Output, AttributeDefinitionStatusFailure>> {
    const result = await changeStatus(
      this.deps,
      context,
      input,
      (definition) => definition.discard(),
      (before) =>
        this.deps.audit.record(
          context,
          AttributeDefinitionDiscardedAudit.entry(before.state.id, {
            before: { status: 'draft' },
            after: { status: 'archived' },
          }),
        ),
    );
    this.#logger.log({
      msg: 'catalog.attribute-definition-discard',
      code: result.ok ? 'discarded' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }
}
