import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { AttributeDefinition } from '../../domain/attribute-definition';
import { AttributeFamily } from '../../domain/attribute-family';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { AttributeSeed } from '../ports/attribute-seed';

export interface SeedAttributesOutput {
  /** Definitions and families created by this run; 0 once the Market is seeded. */
  readonly definitions: number;
  readonly families: number;
}

export type SeedAttributesFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'attribute.seed-invalid'; readonly name: string; readonly reason: string };

export interface SeedAttributesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly attributes: AttributeRepository;
  readonly attributeSeed: AttributeSeed;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * The seed routine of catalog design 7.2 for attribute definitions (with their `material` flags)
 * and the default family (slice 3). Rule `system`, run per hosted Market at worker start and then
 * daily. Definitions first, each in its own unit; then families, which must name only active
 * definitions of the Market. It only ever creates (Ali B4): an existing code is skipped whatever
 * its state, there is no update path, and the application holds no grant a seed could use to
 * rewrite a definition's code, type or flag. A concurrent or repeated run converges on the
 * unique `(market, code)` keys. The claim-text check of names and option labels joins with
 * slice 5.
 */
export class SeedAttributes extends UseCase<
  Record<string, never>,
  SeedAttributesOutput,
  SeedAttributesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.seed-attributes',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SeedAttributes');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SeedAttributesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<SeedAttributesOutput, SeedAttributesFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, attributes, attributeSeed, clock, ids } = this.deps;
    let definitions = 0;
    let families = 0;

    for (const seeded of attributeSeed.definitions(market)) {
      const done = await unitOfWork.run(market, async () => {
        if ((await attributes.definitionIdByCode(market, seeded.code)) !== null) return ok(false);
        const definition = AttributeDefinition.create({
          ...seeded,
          id: ids.next<'AttributeDefinition'>(),
          revisionId: ids.next<'AttributeDefinitionRevision'>(),
          marketId: market.marketId,
          createdByKind: 'seed',
          now: clock.now(),
        });
        if (!definition.ok) return err(definition.error.code);
        await attributes.addDefinition(market, definition.value);
        return ok(true);
      });
      if (!done.ok) {
        return err({ code: 'attribute.seed-invalid', name: seeded.code, reason: done.error });
      }
      if (done.value) definitions += 1;
    }

    for (const seeded of attributeSeed.families(market)) {
      const done = await unitOfWork.run(market, async () => {
        if ((await attributes.familyIdByCode(market, seeded.code)) !== null) return ok(false);
        const codes = seeded.groups.flatMap((group) => group.attributes.map((entry) => entry.code));
        const present = await attributes.activeDefinitionCodes(market, codes);
        if (codes.some((code) => !present.has(code)))
          return err('attribute-family.unknown-attribute');
        const family = AttributeFamily.create({
          id: ids.next<'AttributeFamily'>(),
          revisionId: ids.next<'AttributeFamilyRevision'>(),
          marketId: market.marketId,
          code: seeded.code,
          groups: seeded.groups,
          createdByKind: 'seed',
          now: clock.now(),
        });
        if (!family.ok) return err(family.error.code);
        await attributes.addFamily(market, family.value);
        return ok(true);
      });
      if (!done.ok) {
        return err({ code: 'attribute.seed-invalid', name: seeded.code, reason: done.error });
      }
      if (done.value) families += 1;
    }

    if (definitions + families > 0) {
      this.#logger.log({
        msg: 'catalog.seed-attributes.created',
        definitions,
        families,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
    }
    return ok({ definitions, families });
  }
}
