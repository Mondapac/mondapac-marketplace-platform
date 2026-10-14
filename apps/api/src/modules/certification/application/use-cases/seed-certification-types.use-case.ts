import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { validateTypeRevision, type TypeRevisionProblem } from '../../domain/type-revision';
import type { CertificationTypeRepository } from '../ports/certification-type.repository';
import type { CertificationTypeSeed } from '../ports/type-seed';

/**
 * The author written on a seeded revision. `author_account_id` is NOT NULL and the seed has no
 * account, so it is the nil UUID: it names no account and no later row refers to it.
 */
export const SEED_AUTHOR_ACCOUNT_ID = '00000000-0000-0000-0000-000000000000';

export interface SeedCertificationTypesOutput {
  /** Types created by this run; 0 once the Market is seeded. */
  readonly created: number;
}

export type SeedCertificationTypesFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'type.seed-invalid';
      readonly typeCode: string;
      readonly problems: readonly TypeRevisionProblem[];
    };

export interface SeedCertificationTypesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly types: CertificationTypeRepository;
  readonly seed: CertificationTypeSeed;
  /** The Market's `supportedLocales`. */
  readonly supportedLocales: (market: CallContext['market']) => readonly string[];
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * The seed routine of certification design 5.2 (the identity role-seed pattern, ID 5.6). Rule
 * `system`, run per hosted Market at worker start and then daily. Every seeded revision first
 * passes `validateTypeRevision` against the Market's supported locales; one that fails refuses
 * the whole run before anything is written. Then, per type, one unit creates it with its first
 * revision, texts and claim terms when its code is missing. It only ever creates: a type that
 * exists is skipped whatever its state or revisions, so an edit by an admin is never undone. No
 * issuer is seeded (none is known; an issuer is `proposed` with no expert reference, design
 * 5.2, and needs real data). A concurrent run converges on the unique `(market, code)`.
 */
export class SeedCertificationTypes extends UseCase<
  Record<string, never>,
  SeedCertificationTypesOutput,
  SeedCertificationTypesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.seed-certification-types',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SeedCertificationTypes');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SeedCertificationTypesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<SeedCertificationTypesOutput, SeedCertificationTypesFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, types, seed, clock, ids } = this.deps;
    const seeded = seed.types(market);
    if (seeded.length === 0) {
      this.#logger.warn({
        msg: 'certification.seed-types.no-seed',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
    }
    const locales = this.deps.supportedLocales(market);
    for (const entry of seeded) {
      const checked = validateTypeRevision(entry.content, locales, null);
      if (!checked.ok) {
        this.#logger.error({
          msg: 'certification.seed-types.invalid',
          typeCode: entry.code,
          problems: checked.error.map((problem) => problem.code),
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
        return err({ code: 'type.seed-invalid', typeCode: entry.code, problems: checked.error });
      }
    }
    let created = 0;
    for (const entry of seeded) {
      const done = await unitOfWork.run(market, async () => {
        if (await types.existsByCode(market, entry.code)) return ok(false);
        await types.addSeeded(market, {
          typeId: ids.next(),
          revisionId: ids.next(),
          seeded: entry,
          authorAccountId: SEED_AUTHOR_ACCOUNT_ID,
          createdAt: clock.now(),
        });
        return ok(true);
      });
      if (done.ok && done.value) {
        created += 1;
        this.#logger.log({
          msg: 'certification.seed-types.created',
          typeCode: entry.code,
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
      }
    }
    return ok({ created });
  }
}
