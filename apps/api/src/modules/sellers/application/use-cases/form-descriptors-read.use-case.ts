import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_BUSINESS_IDENTITY_EDIT } from '../../contracts/permissions';
import { IDENTIFIER_INPUT_MAX_LENGTH } from '../../domain/business-identifier';
import { PHONE_MAX_LENGTH } from '../../domain/draft-fields';
import { logDraftOutcome, sellerActorOf, type SellersUnavailable } from '../draft/draft-support';
import { zoneOptionsOf } from '../draft/draft-view';
import type { AddressFormats, TimezoneResolver } from '../ports/seller-market-formats';
import type { SellerMarketPolicy } from '../ports/seller-market-policy';

/**
 * The form descriptors of the actor's Market (sellers design 6.2; Reza 2): what the seller's
 * form builds its fields from, so no Market's format is hard-coded in the panel. Not personal.
 */
export interface FormDescriptors {
  readonly address: {
    readonly fields: readonly {
      readonly key: string;
      readonly labelKey: string;
      readonly required: boolean;
      readonly maxLength: number;
    }[];
    readonly postcodeField: string;
    readonly regionField: string | null;
    /** The source of the anchored, bounded pattern; the server checks it again. */
    readonly postcodePattern: string;
    readonly regions: readonly string[];
  };
  /** Per region of the address format: its zones, the default first. */
  readonly timezones: Readonly<Record<string, readonly string[]>>;
  /**
   * Interim: the Market file has no phone section yet (Q-M11 "pattern from the Market"), so only
   * the Market-neutral bound is described; the pattern joins with the shared config change.
   */
  readonly phone: { readonly maxLength: number };
  /**
   * The Market's business identifier field (design 4.1, 6.2; slice 3): the scheme code, the
   * translation key of its label, whether a complete draft needs it and the most a person may
   * type. The format itself is checked by `my-file.validate-identifier`, never by the client.
   */
  readonly identifier: {
    readonly scheme: string;
    readonly labelKey: string;
    readonly required: boolean;
    readonly maxLength: number;
  };
}

export interface FormDescriptorsReadDependencies {
  readonly addressFormats: AddressFormats;
  readonly zones: TimezoneResolver;
  readonly policy: SellerMarketPolicy;
}

/**
 * `form-descriptors.read` for the seller (sellers design 6.2; slice 2). Rule `permissions
 * [sellers.business-identity.edit]`, allowed while not approved; the admin twin under
 * `sellers.seller.view` arrives with the admin pages. Reads Market configuration only.
 */
export class FormDescriptorsRead extends UseCase<
  Record<string, never>,
  FormDescriptors,
  SellersUnavailable
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.form-descriptors-read',
    rule: { kind: 'permissions', allOf: [SELLERS_BUSINESS_IDENTITY_EDIT.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: FormDescriptorsReadDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext): Promise<Result<FormDescriptors, SellersUnavailable>> {
    const { market } = context;
    const format = this.deps.addressFormats.formatOf(market);
    const sellerId = sellerActorOf(context)?.sellerId ?? null;
    const identifier = this.deps.policy.businessIdentifier(market);
    if (format === null || identifier === null) {
      logDraftOutcome('form-descriptors-read', context, sellerId, 'sellers.unavailable');
      return Promise.resolve(err({ code: 'sellers.unavailable' }));
    }
    const timezones: Record<string, readonly string[]> = {};
    for (const region of format.regions) {
      timezones[region] = zoneOptionsOf(this.deps.zones.zonesOf(market, region));
    }
    logDraftOutcome('form-descriptors-read', context, sellerId, 'read');
    return Promise.resolve(
      ok({
        address: {
          fields: format.fields.map(({ key, labelKey, required, maxLength }) => ({
            key,
            labelKey,
            required,
            maxLength,
          })),
          postcodeField: format.postcodeField,
          regionField: format.regionField,
          postcodePattern: format.postcodePattern,
          regions: [...format.regions],
        },
        timezones,
        phone: { maxLength: PHONE_MAX_LENGTH },
        identifier: {
          scheme: identifier.scheme,
          labelKey: identifier.labelKey,
          required: identifier.required,
          maxLength: IDENTIFIER_INPUT_MAX_LENGTH,
        },
      }),
    );
  }
}
