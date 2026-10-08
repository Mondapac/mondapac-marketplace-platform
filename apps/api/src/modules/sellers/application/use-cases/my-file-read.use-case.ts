import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_BUSINESS_IDENTITY_EDIT } from '../../contracts/permissions';
import { addressFromJson, type AddressFormatSpec } from '../../domain/address';
import type { Sealed, SealedField } from '../../domain/sealed';
import type { DraftPart, SellerFile } from '../../domain/seller-file';
import type { ZoneState } from '../../domain/zone';
import {
  logDraftOutcome,
  sellerActorOf,
  type DraftAccessDenied,
  type SellersUnavailable,
} from '../draft/draft-support';
import { zoneOptionsOf, type FileNotFound } from '../draft/draft-view';
import type { SellerFileCipher } from '../ports/seller-file-cipher';
import type { SellerFileRepository } from '../ports/seller-file.repository';
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
  /** The zones of the saved address's region, the default first; empty without an address. */
  readonly zoneOptions: readonly string[];
}

export type MyFileReadFailure = DraftAccessDenied | SellersUnavailable | FileNotFound;

export interface MyFileReadDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly files: SellerFileRepository;
  readonly cipher: SellerFileCipher;
  readonly addressFormats: AddressFormats;
  readonly zones: TimezoneResolver;
  readonly areas: ServiceAreas;
}

/**
 * `my-file.read` (sellers design 6.2; slice 2 part): the Seller Owner reads its own draft. Rule
 * `permissions [sellers.business-identity.edit]`, allowed while not approved (a seller who cannot
 * read the form cannot complete it). The file is the actor's (AC 18), read in one read-only unit
 * (ADR-0025); the personal fields are decrypted after it, one field per key unwrap. The statuses
 * of 3.3, the withdrawal and the identity-change rows join with slice 5; the slug with its
 * column (see the slice notes). A destroyed key or a failed decryption is `sellers.unavailable`,
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

    const read = await unitOfWork.run(
      market,
      async () => ok(await files.findById(market, owner.sellerId)),
      { readOnly: true },
    );
    if (!read.ok || read.value === null) return err({ code: 'file.not-found' });
    const file = read.value;
    const format = addressFormats.formatOf(market);
    if (format === null) return err({ code: 'sellers.unavailable' });
    try {
      return await this.view(market, owner.sellerId, file, format);
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
  }

  private async view(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    file: SellerFile,
    format: AddressFormatSpec,
  ): Promise<Result<MyFileView, SellersUnavailable>> {
    const { cipher, zones, areas } = this.deps;
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
    if (destroyed) return err({ code: 'sellers.unavailable' });

    const address = addressJson === null ? null : addressFromJson(addressJson, format);
    const registered = registeredJson === null ? null : addressFromJson(registeredJson, format);
    const area = address === null ? null : areas.areaFor(market, address.postcode);
    const regionZones = address === null ? null : zones.zonesOf(market, address.region);
    return ok({
      version: file.state.version,
      draftComplete: file.state.draftComplete,
      missing: file.missing(),
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
      zoneOptions: zoneOptionsOf(regionZones),
    });
  }
}
