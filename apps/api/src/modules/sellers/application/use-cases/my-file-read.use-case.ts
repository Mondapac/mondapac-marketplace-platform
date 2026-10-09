import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_BUSINESS_IDENTITY_EDIT } from '../../contracts/permissions';
import { addressFromJson, type AddressFormatSpec } from '../../domain/address';
import type { Temporal } from '@mondapac/shared-kernel';
import type { RevisionAuthorKind, WithdrawCause } from '../../domain/revision-kinds';
import type { SellerRegisterResult } from '../../domain/register-check';
import {
  onboardingStepsOf,
  sellerStatusOf,
  type OnboardingStep,
  type SellerStatus,
} from '../../domain/seller-status';
import type { Sealed, SealedField } from '../../domain/sealed';
import type { DraftPart, DraftRequirements, SellerFile } from '../../domain/seller-file';
import type { ZoneState } from '../../domain/zone';
import {
  draftRequirementsOf,
  logDraftOutcome,
  sellerActorOf,
  type DraftAccessDenied,
  type SellersUnavailable,
} from '../draft/draft-support';
import { zoneOptionsOf, type FileNotFound } from '../draft/draft-view';
import type { BusinessFileRevisionRepository } from '../ports/business-file-revision.repository';
import type { SellerAccessReader } from '../ports/seller-access-reader';
import type { RegisterCheckRepository } from '../ports/register-check.repository';
import type { RegisterLookupPolicy } from '../ports/register-lookup-policy';
import { sellerResultOf } from '../register/register-lookup';
import type { SellerFileCipher } from '../ports/seller-file-cipher';
import type { SellerFileRepository } from '../ports/seller-file.repository';
import type { SellerMarketPolicy } from '../ports/seller-market-policy';
import type { BusinessIdentifierSchemes } from '../ports/business-identifier-scheme';
import type {
  AddressFormats,
  DraftServiceArea,
  ServiceAreas,
  TimezoneResolver,
} from '../ports/seller-market-formats';

/**
 * The seller's own draft, decrypted (sellers design 6.2 `my-file.read`; 8.1: one seller per
 * request). **Personal data**: the HTTP slice answers it with `Cache-Control: no-store` (8.3),
 * and no part of it may reach a log, an event or an audit row.
 */
export interface MyFileView {
  readonly version: number;
  readonly draftComplete: boolean;
  readonly missing: readonly DraftPart[];
  readonly general: {
    readonly storeName: string | null;
    readonly businessName: string | null;
    readonly phone: string | null;
    readonly contactEmail: string | null;
  };
  /** The operating address's fields, in the Market format's order, or null. */
  readonly address: Readonly<Record<string, string>> | null;
  /** The registered address when it differs, or null. */
  readonly registeredAddress: Readonly<Record<string, string>> | null;
  /** The area the saved postcode falls in **now** (an area may open later, AC 6), or null. */
  readonly serviceArea: DraftServiceArea | null;
  /** Null while no address is saved. */
  readonly outsideServiceArea: boolean | null;
  readonly timezone: ZoneState | null;
  /** The chosen shop slug (clear, Q-M25), or null. */
  readonly slug: string | null;
  /**
   * The business identifier of the Market's scheme: the normalised value and how people write it
   * (slice 3). Null when none is saved, or when the saved one is of a scheme the Market no longer
   * uses (it does not count as saved, AC 3).
   */
  readonly identifier: { readonly value: string; readonly display: string } | null;
  /**
   * What the register said about the saved identifier, as the seller may see it (design 7.7,
   * brief s5): `matched`, `not-matched` or `could-not-be-checked`. Null when the Market has no
   * register lookup, no identifier is saved, or the file holds no current result. Never a
   * register value or a mismatch flag.
   */
  readonly registerResult: SellerRegisterResult | null;
  /** The zones of the saved address's region, the default first; empty without an address. */
  readonly zoneOptions: readonly string[];
  /** The one status of design 3.3 that slice 5b can tell. */
  readonly status: SellerStatus;
  /** The steps card of S1 (design 7.1 `onboardingSteps`). */
  readonly onboardingSteps: readonly OnboardingStep[];
  /** The pending submission, or null. */
  readonly submission: {
    readonly revisionNo: number;
    readonly submittedAt: Temporal.Instant;
  } | null;
  /**
   * The seller's latest revision when it ended withdrawn (cause, by whom, when), so the page can
   * say why the submission is gone (ux F14); null otherwise.
   */
  readonly latestWithdrawal: {
    readonly cause: WithdrawCause;
    readonly byKind: RevisionAuthorKind;
    readonly at: Temporal.Instant;
  } | null;
}

type BaseView = Omit<MyFileView, 'status' | 'onboardingSteps' | 'submission' | 'latestWithdrawal'>;

export type MyFileReadFailure = DraftAccessDenied | SellersUnavailable | FileNotFound;

export interface MyFileReadDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly files: SellerFileRepository;
  readonly revisions: BusinessFileRevisionRepository;
  readonly accessReader: SellerAccessReader;
  readonly policy: SellerMarketPolicy;
  readonly identifierSchemes: BusinessIdentifierSchemes;
  readonly cipher: SellerFileCipher;
  readonly addressFormats: AddressFormats;
  readonly zones: TimezoneResolver;
  readonly areas: ServiceAreas;
  readonly registerChecks: RegisterCheckRepository;
  readonly registerPolicy: RegisterLookupPolicy;
  readonly clock: Clock;
}

/**
 * `my-file.read` (sellers design 6.2; slice 2 part): the Seller Owner reads its own draft. Rule
 * `permissions [sellers.business-identity.edit]`, allowed while not approved (a seller who cannot
 * read the form cannot complete it). The file is the actor's (AC 18), read in one read-only unit
 * (ADR-0025); the personal fields are decrypted after it, one field per key unwrap. The statuses
 * of 3.3, the withdrawal and the identity-change rows join with slice 5; the slug is the draft's
 * `draft_slug` (Q-M25). A destroyed key or a failed decryption is `sellers.unavailable`,
 * never an empty value.
 */
export class MyFileRead extends UseCase<Record<string, never>, MyFileView, MyFileReadFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.my-file-read',
    rule: { kind: 'permissions', allOf: [SELLERS_BUSINESS_IDENTITY_EDIT.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: MyFileReadDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<MyFileView, MyFileReadFailure>> {
    const result = await this.read(context);
    logDraftOutcome(
      'my-file-read',
      context,
      sellerActorOf(context)?.sellerId ?? null,
      result.ok ? 'read' : result.error.code,
    );
    return result;
  }

  private async read(context: CallContext): Promise<Result<MyFileView, MyFileReadFailure>> {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, files, addressFormats } = this.deps;

    const lookup = this.deps.registerPolicy.settingsOf(market);
    // The access state is `identity`'s, read live and outside any unit (design 7.2).
    let access;
    try {
      access = await this.deps.accessReader.accessOf(context, owner.sellerId);
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
    if (access === null) return err({ code: 'file.not-found' });
    const read = await unitOfWork.run(
      market,
      async () => {
        const found = await files.findById(market, owner.sellerId);
        const index = found?.state.draft.identifier?.index ?? null;
        const check =
          lookup.kind === 'configured' && index !== null
            ? await this.deps.registerChecks.find(market, owner.sellerId, index)
            : null;
        const pending =
          found === null ? null : await this.deps.revisions.findPending(market, owner.sellerId);
        const latest =
          found === null ? null : await this.deps.revisions.findLatest(market, owner.sellerId);
        return ok({ found, check, pending, latest });
      },
      { readOnly: true },
    );
    if (!read.ok || read.value.found === null) return err({ code: 'file.not-found' });
    const file = read.value.found;
    const registerResult =
      lookup.kind === 'configured'
        ? sellerResultOf(
            read.value.check,
            this.deps.clock.now(),
            lookup,
            file.state.lastChangedAt,
            file.state.version,
          )
        : null;
    const format = addressFormats.formatOf(market);
    const requirements = draftRequirementsOf(this.deps.policy, market);
    if (format === null || requirements === null) return err({ code: 'sellers.unavailable' });
    try {
      const viewed = await this.view(
        market,
        owner.sellerId,
        file,
        format,
        requirements,
        registerResult,
      );
      if (!viewed.ok) return viewed;
      const { pending, latest } = read.value;
      const base = viewed.value;
      const statusInput = {
        access,
        hasApprovedRevision: file.state.hasApprovedRevision,
        hasPendingOnboardingRevision: pending?.kind === 'onboarding',
        missing: base.missing,
        outsideServiceArea: base.outsideServiceArea,
        registerNegative: base.registerResult === 'not-matched',
      };
      const status = sellerStatusOf(statusInput);
      return ok({
        ...base,
        status,
        onboardingSteps: onboardingStepsOf(statusInput, status),
        submission:
          pending === null
            ? null
            : { revisionNo: pending.revisionNo, submittedAt: pending.createdAt },
        latestWithdrawal: latest?.withdrawal != null ? { ...latest.withdrawal } : null,
      });
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
  }

  private async view(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    file: SellerFile,
    format: AddressFormatSpec,
    requirements: DraftRequirements,
    registerResult: SellerRegisterResult | null,
  ): Promise<Result<BaseView, SellersUnavailable>> {
    const { cipher, zones, areas, identifierSchemes } = this.deps;
    let destroyed = false;
    const open = async <F extends SealedField>(
      field: F,
      sealed: Sealed<F> | null,
    ): Promise<string | null> => {
      if (sealed === null) return null;
      const opened = await cipher.open(market, sellerId, field, sealed);
      if (!opened.ok) destroyed = true;
      return opened.ok ? opened.value : null;
    };
    const { draft } = file.state;
    const businessName = await open('business-name', draft.businessName);
    const phone = await open('phone', draft.phone);
    const contactEmail = await open('contact-email', draft.contactEmail);
    const addressJson = await open('address', draft.address);
    const registeredJson = await open('registered-address', draft.registeredAddress);
    const scheme = identifierSchemes.schemeOf(market);
    const identifierValue =
      draft.identifier === null || scheme?.scheme !== draft.identifier.scheme
        ? null
        : await open('identifier', draft.identifier.sealed);
    if (destroyed) return err({ code: 'sellers.unavailable' });

    const address = addressJson === null ? null : addressFromJson(addressJson, format);
    const registered = registeredJson === null ? null : addressFromJson(registeredJson, format);
    const area = address === null ? null : areas.areaFor(market, address.postcode);
    const regionZones = address === null ? null : zones.zonesOf(market, address.region);
    return ok({
      version: file.state.version,
      draftComplete: file.state.draftComplete,
      missing: file.missing(requirements),
      general: {
        storeName: draft.storeName?.name ?? null,
        businessName,
        phone,
        contactEmail,
      },
      address: address?.fields ?? null,
      registeredAddress: registered?.fields ?? null,
      serviceArea: area,
      outsideServiceArea: address === null ? null : area?.sellerOnboardingEnabled !== true,
      timezone: draft.zone,
      slug: draft.slug,
      identifier:
        identifierValue === null || scheme === null
          ? null
          : { value: identifierValue, display: scheme.display(identifierValue) },
      registerResult: identifierValue === null ? null : registerResult,
      zoneOptions: zoneOptionsOf(regionZones),
    });
  }
}
