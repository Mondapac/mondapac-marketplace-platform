import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { checkSeedTexts, type SeedClaimRefusal } from '../claim-text/seed-claim-check';
import type { CheckClaimText } from '../claim-text/check-claim-text.service';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
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
  | { readonly code: 'attribute.seed-invalid'; readonly name: string; readonly reason: string }
  | SeedClaimRefusal;

export interface SeedAttributesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly attributes: AttributeRepository;
  readonly attributeSeed: AttributeSeed;
  readonly check: CheckClaimText;
  readonly policy: CatalogMarketPolicy;
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
 * unique `(market, code)` keys. Before anything is written, every definition name and option
 * label passes the claim-text check as the system actor (design 7.2, ADR-0031 d3); a match or an
 * unavailable check refuses the whole run.
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
    const { unitOfWork, attributes, attributeSeed, clock, ids, check, policy } = this.deps;
    const seededDefinitions = attributeSeed.definitions(market);
    const checked = await checkSeedTexts(
      check,
      policy,
      context,
      seededDefinitions.flatMap((seeded) => [
        ...Object.entries(seeded.names).map(([locale, text]) => ({
          field: 'attribute-definition.name' as const,
          ref: seeded.code,
          locale,
          text,
        })),
        ...seeded.options.flatMap((option) =>
          Object.entries(option.labels).map(([locale, text]) => ({
            field: 'attribute-definition.option-label' as const,
            ref: `${seeded.code}-${option.code}`.slice(0, 64),
            locale,
            text,
          })),
        ),
      ]),
    );
    if (!checked.ok) {
      this.#logger.error({
        msg: 'catalog.seed-attributes.claim-text',
        code: checked.error.code,
        places: checked.error.places.length,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return checked;
    }
    let definitions = 0;
    let families = 0;

    for (const seeded of seededDefinitions) {
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
