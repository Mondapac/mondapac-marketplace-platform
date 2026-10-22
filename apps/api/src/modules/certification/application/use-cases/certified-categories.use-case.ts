import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { CertificationUnavailable } from '../../contracts/certification.facade';
import type { CertifiedCategoriesReader } from '../ports/certified-categories.reader';

const logger = new Logger('CertifiedCategories');

/**
 * `certifiedCategoryIds` for request actors: rule `anonymous`. Reads the Market's published claim
 * policies and nothing of the actor. A failed read is `certification.unavailable`, never an empty
 * list a caller could read as "no certified category".
 */
export class CertifiedCategories extends UseCase<
  Record<string, never>,
  readonly Id<'Category'>[],
  CertificationUnavailable
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.certified-categories',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly reader: CertifiedCategoriesReader,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<readonly Id<'Category'>[], CertificationUnavailable>> {
    try {
      return ok(await this.reader.categoryIds(context.market));
    } catch (error) {
      logger.error(
        `certifiedCategoryIds failed: ${error instanceof Error ? error.name : 'unknown'}`,
      );
      return err({ code: 'certification.unavailable' });
    }
  }
}
