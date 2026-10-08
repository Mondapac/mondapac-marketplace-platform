import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_BUSINESS_IDENTITY_EDIT } from '../../contracts/permissions';
import { parseAddress, type Address, type FieldProblem } from '../../domain/address';
import { SAVE_LIMITS } from '../../domain/rate-limits';
import type { Sealed } from '../../domain/sealed';
import type { DraftRefused } from '../../domain/seller-file';
import type { ZoneState } from '../../domain/zone';
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
  zoneOptionsOf,
  type DraftConflict,
  type DraftSaved,
  type DraftValidationFailed,
  type FileNotFound,
} from '../draft/draft-view';
import { suggestedZoneFor } from '../draft/location-hint';
import type { LocationTimezoneResolver } from '../ports/location-timezone-resolver';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import type { SellerFileCipher } from '../ports/seller-file-cipher';
import type { SellerFileRepository } from '../ports/seller-file.repository';
import type { SellerMarketPolicy } from '../ports/seller-market-policy';
import type {
  AddressFormats,
  DraftServiceArea,
  ServiceAreas,
  TimezoneResolver,
} from '../ports/seller-market-formats';

/**
 * The Address group as the seller sends it (brief s7; UX S3; spike 3 record). `address` is the
 * operating address, an object of the Market format's fields; `registeredAddress` only when it
 * differs. `timezone` is the seller's choice from the region's list (optional); `browserTimezone`
 * is the browser's own zone, an untrusted hint. `location` is a device position for the
 * `LocationTimezoneResolver` hint: no HTTP route accepts it yet (the body shape is closed), so it
 * is an in-process input only; it is validated, rounded, used for the call and never kept.
 */
export interface MyFileSaveAddressInput {
  readonly address?: unknown;
  readonly registeredAddress?: unknown;
  readonly timezone?: unknown;
  readonly browserTimezone?: unknown;
  readonly location?: unknown;
}

/** What the seller learns at once from an address save (brief s7, AC 6, AC 8). */
export interface AddressSaved extends DraftSaved {
  /** The area the operating postcode falls in, or null for none. */
  readonly serviceArea: DraftServiceArea | null;
  /** True unless the area takes new sellers: the address is kept; submission waits (AC 6). */
  readonly outsideServiceArea: boolean;
  readonly timezone: ZoneState | null;
  /** The zones the seller may choose from, for the address's region; the default first. */
  readonly zoneOptions: readonly string[];
}

export type MyFileSaveAddressFailure =
  | DraftValidationFailed
  | DraftRefused
  | DraftAccessDenied
  | AccessUnavailable
  | RequestThrottled
  | SellersUnavailable
  | FileNotFound
  | DraftConflict;

export interface MyFileSaveAddressDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly files: SellerFileRepository;
  readonly policy: SellerMarketPolicy;
  readonly cipher: SellerFileCipher;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly addressFormats: AddressFormats;
  readonly zones: TimezoneResolver;
  readonly areas: ServiceAreas;
  readonly locationZones: LocationTimezoneResolver;
  readonly clock: Clock;
}

/**
 * `my-file.save-address` (sellers design 4.2, 4.3, 6.2; spike 3 record; slice 2): the Seller
 * Owner saves the operating address and, when it differs, the registered address. Same access
 * rule, ownership, limits, fail-closed reads and optimistic write as `my-file.save-general`.
 *
 * The Market's `AddressFormat` validates both addresses (fields, postcode pattern, region). The
 * operating postcode is looked up in the platform `ServiceAreaDirectory`; an address outside
 * every open area is still saved and the answer says so (AC 6). The zone follows the domain rule
 * `zoneAfterAddressSave`: the region default, then a hint (a resolver's suggestion for the
 * device position, else the browser's zone) only for a draft whose zone nobody set, or the seller's choice from the region's list (`timezone.not-selectable`
 * otherwise). The chosen zone stays a draft value: it reaches no approved revision and no
 * `approvedSellerZones` answer in this slice (the certification amendment comes first).
 */
export class MyFileSaveAddress extends UseCase<
  MyFileSaveAddressInput,
  AddressSaved,
  MyFileSaveAddressFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.my-file-save-address',
    rule: { kind: 'permissions', allOf: [SELLERS_BUSINESS_IDENTITY_EDIT.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: MyFileSaveAddressDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: MyFileSaveAddressInput,
  ): Promise<Result<AddressSaved, MyFileSaveAddressFailure>> {
    const result = await this.save(context, input ?? {});
    logDraftOutcome(
      'my-file-save-address',
      context,
      sellerActorOf(context)?.sellerId ?? null,
      result.ok ? 'saved' : result.error.code,
    );
    return result;
  }

  private async save(
    context: CallContext,
    input: MyFileSaveAddressInput,
  ): Promise<Result<AddressSaved, MyFileSaveAddressFailure>> {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, files, policy, addressFormats, zones, areas, clock } = this.deps;

    const reserved = await reserveRateLimits(this.deps, context, SAVE_LIMITS, owner.accountId);
    if (!reserved.ok) return reserved;

    const format = addressFormats.formatOf(market);
    const requirements = draftRequirementsOf(policy, market);
    if (format === null || requirements === null) return err({ code: 'sellers.unavailable' });
    const problems: FieldProblem[] = [];
    const operating = parseAddress(input.address, format, 'address');
    if (!operating.ok) problems.push(...operating.error);
    const registered = isBlank(input.registeredAddress)
      ? ok(null)
      : parseAddress(input.registeredAddress, format, 'registeredAddress');
    if (!registered.ok) problems.push(...registered.error);
    if (!operating.ok || !registered.ok) {
      return err({ code: 'validation.failed', fields: problems });
    }

    const area = areas.areaFor(market, operating.value.postcode);
    const regionZones = zones.zonesOf(market, operating.value.region);
    if (!(await fileExists(this.deps, context, owner.sellerId))) {
      return err({ code: 'file.not-found' });
    }
    // Only when the request makes no choice of its own and the region has a list: the hint can
    // never apply otherwise, so the resolver is not asked (nor the position handled) for nothing.
    // Asked only after the file is known to exist, so a missing file costs no resolver call.
    const suggestedZone =
      regionZones !== null && (input.timezone === undefined || input.timezone === null)
        ? await suggestedZoneFor(this.deps.locationZones, market, input.location)
        : null;
    const sealed = await this.seal(market, owner.sellerId, operating.value, registered.value);
    if (!sealed.ok) return sealed;

    return unitOfWork.run<AddressSaved, MyFileSaveAddressFailure>(market, async () => {
      const file = await files.findById(market, owner.sellerId);
      if (file === null) return err({ code: 'file.not-found' });
      const applied = file.saveAddress(
        {
          address: sealed.value.address,
          registeredAddress: sealed.value.registeredAddress,
          serviceAreaCode: area?.code ?? null,
          zones: regionZones,
          zone: {
            chosen: input.timezone === null ? undefined : input.timezone,
            hint: input.browserTimezone,
            suggestedZone,
          },
        },
        clock.now(),
        requirements,
      );
      if (!applied.ok) return applied;
      if (!(await files.saveDraft(market, file))) return err({ code: 'conflict.stale' });
      return ok({
        ...draftSaved(file, requirements),
        serviceArea: area,
        outsideServiceArea: area?.sellerOnboardingEnabled !== true,
        timezone: file.state.draft.zone,
        zoneOptions: zoneOptionsOf(regionZones),
      });
    });
  }

  private async seal(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    operating: Address,
    registered: Address | null,
  ): Promise<
    Result<
      {
        readonly address: Sealed<'address'>;
        readonly registeredAddress: Sealed<'registered-address'> | null;
      },
      SellersUnavailable
    >
  > {
    const { cipher } = this.deps;
    try {
      const address = await cipher.seal(market, sellerId, 'address', operating);
      const registeredAddress =
        registered === null
          ? null
          : await cipher.seal(market, sellerId, 'registered-address', registered);
      if (!address.ok || (registeredAddress !== null && !registeredAddress.ok)) {
        return err({ code: 'sellers.unavailable' });
      }
      return ok({
        address: address.value,
        registeredAddress: registeredAddress === null ? null : registeredAddress.value,
      });
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
  }
}
