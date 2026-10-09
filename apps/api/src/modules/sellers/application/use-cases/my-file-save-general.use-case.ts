import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_BUSINESS_IDENTITY_EDIT } from '../../contracts/permissions';
import {
  parseBusinessName,
  parseContactEmail,
  parsePhone,
  type BusinessName,
  type ContactEmail,
  type Phone,
} from '../../domain/draft-fields';
import type { Sealed } from '../../domain/sealed';
import type { DraftRefused, GeneralDraftInput } from '../../domain/seller-file';
import { parseStoreName, type StoreName } from '../../domain/store-name';
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
  type DraftValidationFailed,
  type FileNotFound,
} from '../draft/draft-view';
import { withdrawPendingOnEdit } from '../draft/withdraw-on-edit';
import type { BusinessFileRevisionRepository } from '../ports/business-file-revision.repository';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import type { SellerFileCipher } from '../ports/seller-file-cipher';
import type { SellerFileRepository } from '../ports/seller-file.repository';
import type { SellerMarketPolicy } from '../ports/seller-market-policy';

/**
 * The General group as the seller sends it (SEL-22, SEL-11; UX S2). The request has no seller id,
 * Market, state or admin setting (AC 16). An absent, null or blank field is "not entered".
 */
export interface MyFileSaveGeneralInput {
  readonly storeName?: unknown;
  readonly businessName?: unknown;
  readonly phone?: unknown;
  readonly contactEmail?: unknown;
}

export type MyFileSaveGeneralFailure =
  | DraftValidationFailed
  | DraftRefused
  | DraftAccessDenied
  | AccessUnavailable
  | RequestThrottled
  | SellersUnavailable
  | FileNotFound
  | DraftConflict;

export interface MyFileSaveGeneralDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly files: SellerFileRepository;
  readonly policy: SellerMarketPolicy;
  readonly cipher: SellerFileCipher;
  readonly revisions: BusinessFileRevisionRepository;
  readonly outbox: OutboxWriter;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly clock: Clock;
}

interface ParsedGeneral {
  readonly storeName: StoreName | null;
  readonly businessName: BusinessName | null;
  readonly phone: Phone | null;
  readonly contactEmail: ContactEmail | null;
}

function parseGeneral(input: MyFileSaveGeneralInput): Result<ParsedGeneral, DraftValidationFailed> {
  const fields: { path: string; code: string }[] = [];
  const field = <T>(
    path: string,
    raw: unknown,
    parse: (raw: unknown) => Result<T, string | { readonly rule: string }>,
  ): T | null => {
    if (isBlank(raw)) return null;
    const parsed = parse(raw);
    if (parsed.ok) return parsed.value;
    fields.push({
      path,
      code: typeof parsed.error === 'string' ? parsed.error : parsed.error.rule,
    });
    return null;
  };
  const parsed: ParsedGeneral = {
    storeName: field('storeName', input.storeName, parseStoreName),
    businessName: field('businessName', input.businessName, parseBusinessName),
    phone: field('phone', input.phone, parsePhone),
    contactEmail: field('contactEmail', input.contactEmail, parseContactEmail),
  };
  return fields.length > 0 ? err({ code: 'validation.failed', fields }) : ok(parsed);
}

/**
 * `my-file.save-general` (sellers design 6.2; SEL-22, SEL-11 AC 7; slice 2): the Seller Owner
 * saves the General group of the draft. Rule `permissions [sellers.business-identity.edit]`,
 * allowed while the seller is not approved. In order:
 *
 * 1. the owner is `ActorContext.sellerId` (AC 18);
 * 2. the saves limit of 6.5 is reserved before any work (60 a minute, 1,000 a day per account);
 *    a store that cannot answer refuses with `access.unavailable`;
 * 3. the values are parsed (paths and codes only); a save without a phone is `phone.required`,
 *    decided by the aggregate after `file.not-found` and `file.change-request-required`;
 * 4. the personal fields are sealed under the seller's key, outside the unit;
 * 5. one read-write unit loads the file, applies the save (completeness recomputed, version +1)
 *    and writes it over the version it read; a lost race is `conflict.stale`. A file with an
 *    approved revision refuses the save in the aggregate (`file.change-request-required`, Hassan
 *    L2). `identity`'s access state is not read: a seller it reports approved without an
 *    approved revision (`file-check-needed`, D 3.3) still completes the details.
 *
 * A save that raises the version withdraws the pending submission, if any, in the same unit
 * (`withdrawPendingOnEdit`; design 3.1); nothing personal reaches a log, an error or an event.
 */
export class MyFileSaveGeneral extends UseCase<
  MyFileSaveGeneralInput,
  DraftSaved,
  MyFileSaveGeneralFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.my-file-save-general',
    rule: { kind: 'permissions', allOf: [SELLERS_BUSINESS_IDENTITY_EDIT.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: MyFileSaveGeneralDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: MyFileSaveGeneralInput,
  ): Promise<Result<DraftSaved, MyFileSaveGeneralFailure>> {
    const result = await this.save(context, input);
    logDraftOutcome(
      'my-file-save-general',
      context,
      sellerActorOf(context)?.sellerId ?? null,
      result.ok ? 'saved' : result.error.code,
    );
    return result;
  }

  private async save(
    context: CallContext,
    input: MyFileSaveGeneralInput,
  ): Promise<Result<DraftSaved, MyFileSaveGeneralFailure>> {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, files, policy, clock } = this.deps;

    const reserved = await reserveRateLimits(this.deps, context, SAVE_LIMITS, owner.accountId);
    if (!reserved.ok) return reserved;

    const parsed = parseGeneral(input ?? {});
    if (!parsed.ok) return parsed;
    const requirements = draftRequirementsOf(policy, market);
    if (requirements === null) return err({ code: 'sellers.unavailable' });

    if (!(await fileExists(this.deps, context, owner.sellerId))) {
      return err({ code: 'file.not-found' });
    }
    const sealed = await this.seal(market, owner.sellerId, parsed.value);
    if (!sealed.ok) return sealed;

    return unitOfWork.run<DraftSaved, MyFileSaveGeneralFailure>(market, async () => {
      const file = await files.findById(market, owner.sellerId);
      if (file === null) return err({ code: 'file.not-found' });
      const applied = file.saveGeneral(sealed.value, clock.now(), requirements);
      if (!applied.ok) return applied;
      if (!(await files.saveDraft(market, file))) return err({ code: 'conflict.stale' });
      const edit = await withdrawPendingOnEdit(this.deps, context, file);
      if (edit === 'lost') return err({ code: 'conflict.stale' });
      return ok(draftSaved(file, requirements, edit === 'withdrawn'));
    });
  }

  /** Seals each entered personal field under the seller's key; the store name stays clear. */
  private async seal(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    parsed: ParsedGeneral,
  ): Promise<Result<GeneralDraftInput, SellersUnavailable>> {
    const { cipher } = this.deps;
    try {
      const businessName =
        parsed.businessName === null
          ? null
          : await cipher.seal(market, sellerId, 'business-name', parsed.businessName);
      const phone =
        parsed.phone === null ? null : await cipher.seal(market, sellerId, 'phone', parsed.phone);
      const contactEmail =
        parsed.contactEmail === null
          ? null
          : await cipher.seal(market, sellerId, 'contact-email', parsed.contactEmail);
      if ([businessName, phone, contactEmail].some((value) => value !== null && !value.ok)) {
        return err({ code: 'sellers.unavailable' });
      }
      const value = <F extends 'business-name' | 'phone' | 'contact-email'>(
        sealed: Result<Sealed<F>, unknown> | null,
      ): Sealed<F> | null => (sealed !== null && sealed.ok ? sealed.value : null);
      return ok({
        storeName: parsed.storeName,
        businessName: value(businessName),
        phone: value(phone),
        contactEmail: value(contactEmail),
      });
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
  }
}
