import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_BUSINESS_IDENTITY_EDIT } from '../../contracts/permissions';
import {
  parseBusinessIdentifier,
  type DraftIdentifier,
  type IdentifierInvalid,
} from '../../domain/business-identifier';
import { SAVE_LIMITS } from '../../domain/rate-limits';
import {
  draftRequirementsOf,
  fileExists,
  logDraftOutcome,
  reserveRateLimits,
  sellerActorOf,
  type AccessUnavailable,
  type DraftAccessDenied,
  type RequestThrottled,
  type SellersUnavailable,
} from '../draft/draft-support';
import {
  draftSaved,
  isBlank,
  type DraftConflict,
  type DraftSaved,
  type FileNotFound,
} from '../draft/draft-view';
import type { BusinessIdentifierSchemes } from '../ports/business-identifier-scheme';
import type { IdentifierIndex } from '../ports/identifier-index';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import type { SellerFileCipher } from '../ports/seller-file-cipher';
import type { SellerFileRepository } from '../ports/seller-file.repository';
import type { SellerMarketPolicy } from '../ports/seller-market-policy';

/**
 * The identifier as the seller sends it (UX F13). The request has no seller id, Market or scheme:
 * the scheme is the Market's. An absent, null or blank value clears the saved identifier.
 */
export interface MyFileSaveIdentifierInput {
  readonly identifier?: unknown;
}

export type MyFileSaveIdentifierFailure =
  | { readonly code: IdentifierInvalid }
  | { readonly code: 'file.change-request-required' }
  | DraftAccessDenied
  | AccessUnavailable
  | RequestThrottled
  | SellersUnavailable
  | FileNotFound
  | DraftConflict;

export interface MyFileSaveIdentifierDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly files: SellerFileRepository;
  readonly policy: SellerMarketPolicy;
  readonly identifierSchemes: BusinessIdentifierSchemes;
  readonly identifierIndex: IdentifierIndex;
  readonly cipher: SellerFileCipher;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly clock: Clock;
}

/**
 * `my-file.save-identifier` (sellers design 6.2, 8.1, 8.2; slice 3): the Seller Owner saves the
 * business identifier of the draft. Rule `permissions [sellers.business-identity.edit]`, allowed
 * while the seller is not approved; the owner is `ActorContext.sellerId`. In order:
 *
 * 1. the saves limit of 6.5 is reserved before any work; a store that cannot answer is
 *    `access.unavailable`;
 * 2. the value is parsed against the Market's scheme (`identifier.format`, `identifier.checksum`);
 *    a blank value clears the saved one, which only leaves the draft complete in a Market that
 *    does not require an identifier;
 * 3. outside the unit, the normalised value is sealed under the seller's key and its keyed index
 *    is computed (the index is bound to the Market and the scheme, design 8.2);
 * 4. one read-write unit loads the file, saves the identifier in the aggregate (a refused file with
 *    an approved revision, completeness recomputed against the Market's rule) and writes it over
 *    the version it read (`conflict.stale` on a lost race). Saving the same value again is a
 *    no-op: no write, no new version.
 *
 * No lookup in this slice (4a). Uniqueness is not decided here: a draft gives no right to a
 * number (brief s7); the claim is taken when a reviewer approves (7a-decide). The seller never
 * learns whether another seller holds the value. The value never reaches a log, an error or an
 * event.
 */
export class MyFileSaveIdentifier extends UseCase<
  MyFileSaveIdentifierInput,
  DraftSaved,
  MyFileSaveIdentifierFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.my-file-save-identifier',
    rule: { kind: 'permissions', allOf: [SELLERS_BUSINESS_IDENTITY_EDIT.key] },
    whenSellerNotApproved: 'allow',
  };

  readonly #logger = new Logger('MyFileSaveIdentifier');

  constructor(
    gate: UseCaseGate,
    private readonly deps: MyFileSaveIdentifierDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: MyFileSaveIdentifierInput,
  ): Promise<Result<DraftSaved, MyFileSaveIdentifierFailure>> {
    const result = await this.save(context, input ?? {});
    logDraftOutcome(
      'my-file-save-identifier',
      context,
      sellerActorOf(context)?.sellerId ?? null,
      result.ok ? 'saved' : result.error.code,
    );
    return result;
  }

  private async save(
    context: CallContext,
    input: MyFileSaveIdentifierInput,
  ): Promise<Result<DraftSaved, MyFileSaveIdentifierFailure>> {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, files, policy, identifierSchemes, identifierIndex, cipher, clock } =
      this.deps;

    const reserved = await reserveRateLimits(this.deps, context, SAVE_LIMITS, owner.accountId);
    if (!reserved.ok) return reserved;

    const scheme = identifierSchemes.schemeOf(market);
    const requirements = draftRequirementsOf(policy, market);
    if (scheme === null || requirements === null) return err({ code: 'sellers.unavailable' });

    const parsed = isBlank(input.identifier)
      ? null
      : parseBusinessIdentifier(input.identifier, scheme);
    if (parsed !== null && !parsed.ok) return err({ code: parsed.error });

    if (!(await fileExists(this.deps, context, owner.sellerId))) {
      return err({ code: 'file.not-found' });
    }

    let identifier: DraftIdentifier | null = null;
    if (parsed !== null) {
      const { value, scheme: code } = parsed.value;
      try {
        const sealed = await cipher.seal(market, owner.sellerId, 'identifier', value);
        if (!sealed.ok) return err({ code: 'sellers.unavailable' });
        identifier = {
          scheme: code,
          sealed: sealed.value,
          index: identifierIndex.of(market, code, value),
        };
      } catch (error) {
        // Name and correlation id only: never the message or the value (Hassan L2).
        this.#logger.error({
          msg: 'sellers.my-file-save-identifier.unavailable',
          error: error instanceof Error ? error.name : 'unknown',
          correlationId: context.correlationId,
        });
        return err({ code: 'sellers.unavailable' });
      }
    }

    return unitOfWork.run<DraftSaved, MyFileSaveIdentifierFailure>(market, async () => {
      const file = await files.findById(market, owner.sellerId);
      if (file === null) return err({ code: 'file.not-found' });
      const applied = file.saveIdentifier(identifier, clock.now(), requirements);
      if (!applied.ok) return applied;
      if (file.state.version === file.persistedVersion) return ok(draftSaved(file, requirements));
      if (!(await files.saveDraft(market, file))) return err({ code: 'conflict.stale' });
      return ok(draftSaved(file, requirements));
    });
  }
}
