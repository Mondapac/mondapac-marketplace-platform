import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { TypeSettings } from '../../domain/seller-certificate';
import type { IssuerState } from '../../domain/validity';

/** An issuer of the registry as a seller picks it (data design 3.7): public name and state. */
export interface IssuerChoice {
  readonly id: Id<'Issuer'>;
  readonly typeId: Id<'CertificationType'>;
  readonly displayName: string;
  readonly state: IssuerState;
}

/** A type of the Market with the settings of its published revision and its public names. */
export interface SellerTypeView extends TypeSettings {
  /** The public name per locale of the published revision. */
  readonly names: Readonly<Record<string, string>>;
}

/**
 * What the seller side reads of the registry: a type by code or id with its published revision's
 * settings, and the issuers of a type. Runs in the open unit of the caller; the Market comes from
 * the `MarketContext` only. A type with no published revision is a fault and rejects (fail closed).
 */
export interface CertificateTypeCatalog {
  typeByCode(market: MarketContext, code: string): Promise<TypeSettings | null>;
  typeById(market: MarketContext, typeId: Id<'CertificationType'>): Promise<TypeSettings | null>;
  /** The issuer, whatever its state; null when unknown in this Market. */
  issuer(market: MarketContext, issuerId: Id<'Issuer'>): Promise<IssuerChoice | null>;
  /** The `active` issuers of a type, by name. */
  activeIssuers(
    market: MarketContext,
    typeId: Id<'CertificationType'>,
  ): Promise<readonly IssuerChoice[]>;
  /** The active types with their form settings and names, by code. */
  activeTypes(market: MarketContext): Promise<readonly SellerTypeView[]>;
}

export const CERTIFICATE_TYPE_CATALOG = Symbol('CERTIFICATION_CERTIFICATE_TYPE_CATALOG');
