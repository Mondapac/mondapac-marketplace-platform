import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { newCulture, parseCultureContent, type CultureState } from '../../domain/culture';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ClaimEvaluator } from '../ports/claim-evaluator';
import type { ClaimTermLocales } from '../ports/claim-term-locales';
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';
import { refuseClaimWords } from '../cultures/culture-views';
import type { CultureRepository } from '../ports/culture.repository';
import type { CultureSeed } from '../ports/culture-seed';

export interface SeedCulturesOutput {
  /** Cultures created by this run; 0 once the Market is seeded. */
  readonly created: number;
}

export type SeedCulturesFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'culture.seed-invalid'; readonly seedCode: string; readonly reason: string }
  | { readonly code: 'culture.seed-type-unavailable'; readonly seedCode: string }
  | { readonly code: 'culture.seed-claim-text-refused'; readonly seedCode: string }
  | { readonly code: 'culture.seed-claim-text-unavailable'; readonly seedCode: string };

export interface SeedCulturesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly cultures: CultureRepository;
  readonly cultureSeed: CultureSeed;
  readonly policy: CatalogMarketPolicy;
  readonly evaluator: ClaimEvaluator;
  readonly matcher: ClaimTextMatcher;
  readonly claimLocales: ClaimTermLocales;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * The seed routine for the first cultures of a Market (multi-culture package 1; ADR-0047). Rule
 * `system`, run per hosted Market at worker start and then daily. It only ever creates: a seeded
 * code that exists is skipped whatever its state, so an admin's later edits are never overwritten.
 * A seeded culture is active at once, and takes the default mark only while the Market has none.
 * Every seeded code, name and description goes through the claim-term matcher as the system actor,
 * like every other path that writes a culture, and fails closed: a text that asserts a
 * certification, or a matcher that cannot answer, refuses the run. A required certification type must be an active type of the Market: when certification's
 * seed has not created it yet, the run is refused and the next run converges. Names are checked
 * against the Market's locales like an admin's.
 */
export class SeedCultures extends UseCase<
  Record<string, never>,
  SeedCulturesOutput,
  SeedCulturesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.seed-cultures',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SeedCultures');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SeedCulturesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<SeedCulturesOutput, SeedCulturesFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const {
      unitOfWork,
      cultures,
      cultureSeed: seed,
      policy,
      evaluator,
      matcher,
      claimLocales,
      clock,
      ids,
    } = this.deps;
    const list = seed.cultures(market);
    if (list.length === 0) return ok({ created: 0 });
    const locales = policy.locales(market);
    const prepared: { state: CultureState; wantsDefault: boolean }[] = [];
    let active: ReadonlySet<string> | null = null;
    for (const seeded of list) {
      const content = parseCultureContent(
        {
          names: Object.fromEntries(
            seeded.names.map((n) => [n.locale, { name: n.name, description: n.description }]),
          ),
        },
        { required: locales.default, supported: locales.supported },
      );
      if (!content.ok) {
        return err({
          code: 'culture.seed-invalid',
          seedCode: seeded.code,
          reason: content.error.map((p) => `${p.path}:${p.code}`).join(','),
        });
      }
      // Seed text goes through the claim-term matcher like every other path, and fails closed: a
      // seed that asserts a certification, or a matcher that cannot answer, refuses the run.
      const claim = await refuseClaimWords(
        { matcher, claimLocales },
        context,
        content.value.names,
        [],
        { text: seeded.code, locale: locales.default },
      );
      if (claim !== null) {
        return err({
          code:
            claim.code === 'culture.claim-word' || claim.code === 'culture.locale-uncheckable'
              ? 'culture.seed-claim-text-refused'
              : 'culture.seed-claim-text-unavailable',
          seedCode: seeded.code,
        });
      }
      if (seeded.requiredCertificationType !== null) {
        if (active === null) {
          const types = await evaluator.activeTypeCodes(context);
          if (!types.ok)
            return err({ code: 'culture.seed-type-unavailable', seedCode: seeded.code });
          active = types.value;
        }
        if (!active.has(seeded.requiredCertificationType)) {
          return err({ code: 'culture.seed-type-unavailable', seedCode: seeded.code });
        }
      }
      const base = newCulture({
        id: ids.next<'Culture'>(),
        code: seeded.code,
        content: content.value,
        displayOrder: seeded.displayOrder,
        requiredCertificationType: seeded.requiredCertificationType,
        badgeColour: seeded.badgeColour,
        createdBy: null,
        now: clock.now(),
      });
      prepared.push({ state: { ...base, status: 'active' }, wantsDefault: seeded.isDefault });
    }
    let created = 0;
    for (const { state, wantsDefault } of prepared) {
      const done = await unitOfWork.run(market, async () => {
        if (await cultures.codeTaken(market, state.code)) return ok(false);
        const isDefault = wantsDefault && (await cultures.defaultId(market)) === null;
        const added = await cultures.add(market, { ...state, isDefault });
        return added === null ? ok(true) : err(added);
      });
      if (!done.ok) {
        return err({ code: 'culture.seed-invalid', seedCode: state.code, reason: done.error });
      }
      if (done.value) {
        created += 1;
        this.#logger.log({
          msg: 'catalog.seed-cultures.created',
          code: state.code,
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
      }
    }
    return ok({ created });
  }
}
